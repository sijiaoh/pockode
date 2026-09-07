package claude

import (
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/pockode/server/agent"
)

// backgroundWaitBase is how long a swallowed end of turn is held before it is
// delivered anyway. Two cases make an unbounded wait wrong: the CLI supports
// session-scoped monitors that never finish, and a model may start a background
// task and genuinely be done. Both would otherwise spin forever.
//
// Where the numbers come from: the CLI's own background-task budget — a 30
// minute base doubling per extension, capped at four times the base.
const (
	backgroundWaitBase         = 30 * time.Minute
	backgroundWaitMaxDoublings = 2
)

// The two halves of "it must not be silent": what the user reads in the
// transcript, and what the agent is told on the next prompt it receives.
const (
	backgroundWaitTimeoutCode = "background_wait_timeout"
	// Both say what Pockode observed — silence — rather than that the task
	// produced nothing, which it has no way of knowing: a task can finish
	// without the CLI resuming, and a message asserting otherwise would be
	// plainly wrong to the one user who checks.
	backgroundWaitTimeoutWarning = "No output for %s while waiting on background work, so this response is being treated as finished."
	backgroundWaitTimeoutNote    = "Pockode saw no output for %s while waiting on your background task(s) and then ended that " +
		"turn, because it cannot wait forever. Any task you started may still be running: check it with BashOutput before " +
		"assuming its result, and say so if you were still waiting on it."
)

// backgroundWait delivers a swallowed end-of-turn event late.
//
// Swallowing the CLI's pseudo-ending is what keeps a background wait looking
// like one long thought (see backgroundTaskTracker), but it cannot be
// open-ended. When the budget runs out the ending is delivered after all and
// everything downstream falls back to the behaviour it had before background
// waits existed — idle, then the usual auto-continue.
//
// The fallback is never silent: the user gets a warning in the transcript and
// the agent gets a note on the next prompt Pockode sends it.
//
// A zero value never fires; start attaches it to a running CLI process.
type backgroundWait struct {
	deadlineMu sync.Mutex
	deadline   time.Time     // zero when disarmed
	budget     time.Duration // the interval the current deadline was armed with
	extends    int           // extensions granted in this wait period

	log    *slog.Logger
	events chan<- agent.AgentEvent
	// notify hands the agent its copy of the explanation; see cliSession.queueNote.
	notify func(string)
	base   time.Duration

	// wake is nil until start runs, which is why every send on it is
	// non-blocking: an unstarted wait keeps a deadline nobody watches instead of
	// blocking the parser that set it.
	wake chan struct{}
	stop chan struct{}
	done chan struct{}
}

func (w *backgroundWait) start(log *slog.Logger, events chan<- agent.AgentEvent, notify func(string), base time.Duration) {
	w.log = log
	w.events = events
	w.notify = notify
	w.base = base
	w.wake = make(chan struct{}, 1)
	w.stop = make(chan struct{})
	w.done = make(chan struct{})
	go w.run()
}

// stopWaiting abandons any pending fallback and waits for the goroutine to
// exit. It must run before the event channel is closed: the fallback writes to
// that channel, and a send racing a close panics.
func (w *backgroundWait) stopWaiting() {
	close(w.stop)
	<-w.done
}

// extend arms the timer for another interval. Each extension within the same
// wait period buys more time, on the assumption that a wait that has already
// produced output is worth more patience than one that has not.
func (w *backgroundWait) extend() {
	w.deadlineMu.Lock()
	budget := w.base << min(w.extends, backgroundWaitMaxDoublings)
	w.extends++
	w.budget = budget
	w.deadline = time.Now().Add(budget)
	w.deadlineMu.Unlock()

	w.wakeRunner()
}

// refresh pushes the deadline out while the agent is actually producing output.
//
// The budget bounds a *silent* wait, not a turn: once the background task
// finishes, the CLI resumes output on its own and may work for a long time
// before the next result frame. Firing the fallback in the middle of that would
// mark the session idle while it is visibly streaming, nudge it mid-turn, and
// then end the same turn twice.
//
// No wake is needed: the runner's timer fires at the old deadline and timedOut
// hands it back to the loop, which picks up the new one.
func (w *backgroundWait) refresh() {
	w.deadlineMu.Lock()
	defer w.deadlineMu.Unlock()

	if w.deadline.IsZero() {
		return
	}
	w.deadline = time.Now().Add(w.budget)
}

// end cancels the fallback because the wait is over: the turn really ended, the
// user stopped it, or the agent is now blocked on the user.
func (w *backgroundWait) end() {
	w.deadlineMu.Lock()
	armed := !w.deadline.IsZero()
	w.deadline = time.Time{}
	w.extends = 0
	w.deadlineMu.Unlock()

	if armed {
		w.wakeRunner()
	}
}

// armed reports whether an end of turn is currently being held back.
func (w *backgroundWait) armed() bool {
	w.deadlineMu.Lock()
	defer w.deadlineMu.Unlock()
	return !w.deadline.IsZero()
}

func (w *backgroundWait) wakeRunner() {
	select {
	case w.wake <- struct{}{}:
	default:
	}
}

func (w *backgroundWait) run() {
	defer close(w.done)

	for {
		w.deadlineMu.Lock()
		deadline := w.deadline
		w.deadlineMu.Unlock()

		// A nil channel blocks forever, which is exactly the disarmed state.
		var fire <-chan time.Time
		var timer *time.Timer
		if !deadline.IsZero() {
			timer = time.NewTimer(time.Until(deadline))
			fire = timer.C
		}

		select {
		case <-fire:
			w.timedOut()
		case <-w.wake:
		case <-w.stop:
			if timer != nil {
				timer.Stop()
			}
			return
		}

		if timer != nil {
			timer.Stop()
		}
	}
}

func (w *backgroundWait) timedOut() {
	w.deadlineMu.Lock()
	// A deadline moved or cleared between the timer firing and this lock means
	// the wait already ended; the next loop pass picks up the new one.
	if w.deadline.IsZero() || time.Now().Before(w.deadline) {
		w.deadlineMu.Unlock()
		return
	}
	// extends is deliberately not reset: nothing was resolved, so if the agent
	// goes back to waiting after the nudge this fallback triggers, the next wait
	// gets the longer budget instead of restarting the same 30 minute cycle.
	budget := w.budget
	w.deadline = time.Time{}
	w.deadlineMu.Unlock()

	w.log.Warn("background wait budget exhausted, delivering the end of turn", "waited", budget)

	w.notify(fmt.Sprintf(backgroundWaitTimeoutNote, budget))
	if !w.send(agent.WarningEvent{
		Message: fmt.Sprintf(backgroundWaitTimeoutWarning, budget),
		Code:    backgroundWaitTimeoutCode,
	}) {
		return
	}
	w.send(agent.DoneEvent{})
}

// send reports whether the event was delivered; a stopped wait drops it,
// because the process is going away and will report its own ending.
func (w *backgroundWait) send(event agent.AgentEvent) bool {
	select {
	case w.events <- event:
		return true
	case <-w.stop:
		return false
	}
}
