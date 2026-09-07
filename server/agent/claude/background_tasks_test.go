package claude

import (
	"bytes"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pockode/server/agent"
)

const (
	oneLiveTask        = `{"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"bd1k65q5o","task_type":"local_bash","description":"sleep 25"}]}`
	oneAmbientTask     = `{"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"amb1","task_type":"local_bash","description":"watcher","ambient":true}]}`
	noLiveTasks        = `{"type":"system","subtype":"background_tasks_changed","tasks":[]}`
	successResult      = `{"type":"result","subtype":"success","is_error":false,"terminal_reason":"completed","result":"STARTED"}`
	abortedResult      = `{"type":"result","subtype":"error_during_execution","is_error":true,"terminal_reason":"aborted_streaming"}`
	failedResult       = `{"type":"result","subtype":"error_max_turns","is_error":true,"terminal_reason":"max_turns","errors":["Reached maximum number of turns (10)"]}`
	interruptRequestID = "req-interrupt"
	interruptResponse  = `{"type":"control_response","response":{"subtype":"success","request_id":"req-interrupt"}}`
	assistantOutput    = `{"type":"assistant","message":{"model":"claude","content":[{"type":"text","text":"STARTED"}]}}`
)

// The measured timeline (claude 2.1.263): the CLI ends the turn with an ordinary
// success result while a background task runs, then resumes output by itself
// once the task finishes. Both result frames are identical, so only the live set
// tells them apart.
func TestParseLine_BackgroundWaitDoesNotEndTheTurn(t *testing.T) {
	tracker := &backgroundTaskTracker{}

	for _, line := range []string{oneLiveTask, assistantOutput} {
		parseTestLineWithTracker(testLogger(), []byte(line), tracker)
	}

	if events := parseTestLineWithTracker(testLogger(), []byte(successResult), tracker); events != nil {
		t.Fatalf("expected the turn end to be swallowed while a background task runs, got %#v", events)
	}

	// Task finished: the CLI resumes on its own and the real ending follows.
	parseTestLineWithTracker(testLogger(), []byte(noLiveTasks), tracker)
	events := parseTestLineWithTracker(testLogger(), []byte(successResult), tracker)
	if len(events) != 1 {
		t.Fatalf("expected exactly one event for the real turn end, got %#v", events)
	}
	if _, ok := events[0].(agent.DoneEvent); !ok {
		t.Errorf("expected DoneEvent after the background task finished, got %#v", events[0])
	}
}

// Only a normal ending is swallowed: an error or an abort really did end the
// turn, and hiding it would leave the user waiting on nothing.
func TestParseLine_BackgroundWaitStillReportsErrorAndAbort(t *testing.T) {
	tests := []struct {
		name     string
		line     string
		expected agent.AgentEvent
	}{
		{"aborted", abortedResult, agent.InterruptedEvent{}},
		{"failed", failedResult, agent.ErrorEvent{Error: "Reached maximum number of turns (10)"}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tracker := &backgroundTaskTracker{}
			parseTestLineWithTracker(testLogger(), []byte(oneLiveTask), tracker)

			events := parseTestLineWithTracker(testLogger(), []byte(tt.line), tracker)
			if len(events) != 1 || !agentEventEqual(events[0], tt.expected) {
				t.Errorf("expected %#v while a background task runs, got %#v", tt.expected, events)
			}
		})
	}
}

// Ambient tasks are housekeeping the CLI tells hosts to leave out of activity
// indicators, so they must not hold the turn open either.
func TestParseLine_AmbientTaskDoesNotHoldTheTurnOpen(t *testing.T) {
	tracker := &backgroundTaskTracker{}
	parseTestLineWithTracker(testLogger(), []byte(oneAmbientTask), tracker)

	events := parseTestLineWithTracker(testLogger(), []byte(successResult), tracker)
	if len(events) != 1 {
		t.Fatalf("expected the turn to end normally with only an ambient task, got %#v", events)
	}
	if _, ok := events[0].(agent.DoneEvent); !ok {
		t.Errorf("expected DoneEvent, got %#v", events[0])
	}
}

// The level signal is per-process: the CLI emits nothing at startup, so a
// restarted session must not inherit the previous process's live set.
func TestBackgroundTaskTracker_StartsEmptyPerProcess(t *testing.T) {
	tracker := &backgroundTaskTracker{}
	parseTestLineWithTracker(testLogger(), []byte(oneLiveTask), tracker)
	if !tracker.hasLive() {
		t.Fatal("expected the task list to be tracked")
	}

	restarted := &backgroundTaskTracker{}
	if restarted.hasLive() {
		t.Error("a new CLI process must start with an empty background task set")
	}
}

// A payload this code cannot read must not wedge the turn open: it clears the
// set, so the worst case is the pre-existing behaviour rather than a session
// that spins forever.
func TestParseLine_UnreadableTaskListClearsTheSet(t *testing.T) {
	tracker := &backgroundTaskTracker{}
	parseTestLineWithTracker(testLogger(), []byte(oneLiveTask), tracker)

	parseTestLineWithTracker(testLogger(), []byte(`{"type":"system","subtype":"background_tasks_changed","tasks":"not an array"}`), tracker)
	if tracker.hasLive() {
		t.Error("an unreadable task list must clear the set, not keep the stale one")
	}
}

// The live set is state, not history: it must never reach the transcript.
func TestParseLine_BackgroundTasksChangedIsNotTranscript(t *testing.T) {
	if events := parseTestLineWithTracker(testLogger(), []byte(oneLiveTask), &backgroundTaskTracker{}); events != nil {
		t.Errorf("expected background_tasks_changed to stay out of the transcript, got %#v", events)
	}
}

// The swallowing cannot be open-ended: the CLI supports monitors that never
// finish, and a model may start a task and genuinely be done. Once the budget
// runs out the held-back ending is delivered after all, with an explanation for
// the user and one for the agent.
func TestBackgroundWait_DeliversTheEndingAfterTheBudget(t *testing.T) {
	events := make(chan agent.AgentEvent, 4)
	notes := make(chan string, 1)

	tracker := &backgroundTaskTracker{}
	tracker.wait.start(testLogger(), events, func(note string) { notes <- note }, 20*time.Millisecond)
	defer tracker.wait.stopWaiting()

	parseTestLineWithTracker(testLogger(), []byte(oneLiveTask), tracker)
	if got := parseTestLineWithTracker(testLogger(), []byte(successResult), tracker); got != nil {
		t.Fatalf("expected the ending to be held back first, got %#v", got)
	}

	warning, ok := awaitEvent(t, events).(agent.WarningEvent)
	if !ok {
		t.Fatalf("expected the fallback to explain itself to the user first")
	}
	if warning.Code != backgroundWaitTimeoutCode {
		t.Errorf("unexpected warning code %q", warning.Code)
	}
	if _, ok := awaitEvent(t, events).(agent.DoneEvent); !ok {
		t.Error("expected the held-back DoneEvent to be delivered after the budget")
	}

	select {
	case note := <-notes:
		if note == "" {
			t.Error("the agent must be told why Pockode stopped waiting")
		}
	default:
		t.Error("expected a note for the agent, so the fallback is not silent on its side")
	}
}

// The tasks going away is not the end of the wait: the CLI is supposed to
// resume output on its own afterwards, and if it never does, the fallback is
// the only thing left to end the turn.
func TestBackgroundWait_SurvivesAnEmptyTaskList(t *testing.T) {
	events := make(chan agent.AgentEvent, 4)

	tracker := &backgroundTaskTracker{}
	tracker.wait.start(testLogger(), events, func(string) {}, 20*time.Millisecond)
	defer tracker.wait.stopWaiting()

	parseTestLineWithTracker(testLogger(), []byte(oneLiveTask), tracker)
	parseTestLineWithTracker(testLogger(), []byte(successResult), tracker)
	parseTestLineWithTracker(testLogger(), []byte(noLiveTasks), tracker)

	if _, ok := awaitEvent(t, events).(agent.WarningEvent); !ok {
		t.Fatal("expected the fallback to still fire after the task list emptied")
	}
}

// An ending the user actually saw cancels the fallback, so it cannot arrive a
// second time on top of it.
func TestBackgroundWait_CancelledByARealEnding(t *testing.T) {
	tests := []struct {
		name  string
		lines []string
	}{
		{"resumed and finished", []string{noLiveTasks, successResult}},
		{"user stopped it", []string{interruptResponse}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			events := make(chan agent.AgentEvent, 4)

			tracker := &backgroundTaskTracker{}
			tracker.wait.start(testLogger(), events, func(string) {}, 30*time.Millisecond)
			defer tracker.wait.stopWaiting()

			pending := &sync.Map{}
			pending.Store(interruptRequestID, interruptMarker{})

			parseTestLineWithTracker(testLogger(), []byte(oneLiveTask), tracker)
			parseTestLineWithTracker(testLogger(), []byte(successResult), tracker)
			for _, line := range tt.lines {
				parseTestLineFull(testLogger(), []byte(line), pending, tracker, func(string, string) {})
			}

			time.Sleep(150 * time.Millisecond)
			select {
			case event := <-events:
				t.Errorf("expected no fallback after the turn already ended, got %#v", event)
			default:
			}
		})
	}
}

// Each extension buys more time, capped at four times the base — the CLI's own
// background task budget.
func TestBackgroundWait_BudgetGrowsAndCaps(t *testing.T) {
	wait := &backgroundWait{base: 30 * time.Minute}

	var got []time.Duration
	for range 5 {
		wait.extend()
		got = append(got, wait.budget)
	}

	expected := []time.Duration{30 * time.Minute, time.Hour, 2 * time.Hour, 2 * time.Hour, 2 * time.Hour}
	if !slices.Equal(got, expected) {
		t.Errorf("expected budgets %v, got %v", expected, got)
	}
}

func waitBudget(wait *backgroundWait) time.Duration {
	wait.deadlineMu.Lock()
	defer wait.deadlineMu.Unlock()
	return wait.budget
}

func awaitEvent(t *testing.T, events <-chan agent.AgentEvent) agent.AgentEvent {
	t.Helper()
	select {
	case event := <-events:
		return event
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for the background wait fallback")
		return nil
	}
}

// The agent's copy of the explanation rides on the next prompt Pockode sends,
// and only that one: it describes a moment, not a standing condition.
func TestSession_QueuedNoteRidesOnTheNextPromptOnly(t *testing.T) {
	var buf bytes.Buffer
	sess := &cliSession{log: testLogger(), stdin: nopWriteCloser{&buf}}

	sess.queueNote("Pockode stopped waiting")
	if err := sess.SendMessage("continue"); err != nil {
		t.Fatalf("SendMessage failed: %v", err)
	}
	if !strings.Contains(buf.String(), "Pockode stopped waiting") {
		t.Errorf("expected the note to reach the agent, got %s", buf.String())
	}

	buf.Reset()
	if err := sess.SendMessage("continue"); err != nil {
		t.Fatalf("SendMessage failed: %v", err)
	}
	if strings.Contains(buf.String(), "Pockode stopped waiting") {
		t.Errorf("expected the note to be delivered once, got %s", buf.String())
	}
}

// The budget bounds a silent wait, not a turn. Once the task finishes the CLI
// resumes output by itself and may work for a long time before the next result
// frame; ending the turn in the middle of that would idle a session that is
// visibly streaming.
func TestBackgroundWait_OutputPushesTheDeadlineOut(t *testing.T) {
	events := make(chan agent.AgentEvent, 4)

	tracker := &backgroundTaskTracker{}
	tracker.wait.start(testLogger(), events, func(string) {}, time.Hour)
	defer tracker.wait.stopWaiting()

	parseTestLineWithTracker(testLogger(), []byte(oneLiveTask), tracker)
	parseTestLineWithTracker(testLogger(), []byte(successResult), tracker)
	armed := waitDeadline(&tracker.wait)

	// The task finished and the CLI resumed output on its own.
	parseTestLineWithTracker(testLogger(), []byte(noLiveTasks), tracker)
	parseTestLineWithTracker(testLogger(), []byte(assistantOutput), tracker)

	if resumed := waitDeadline(&tracker.wait); !resumed.After(armed) {
		t.Error("expected output from the agent to push the deadline out, so the fallback cannot fire mid-turn")
	}
}

func waitDeadline(wait *backgroundWait) time.Time {
	wait.deadlineMu.Lock()
	defer wait.deadlineMu.Unlock()
	return wait.deadline
}

// A fallback resolves nothing, so the patience it was granted must not reset:
// an agent that goes back to waiting after the nudge waits longer next time
// instead of repeating the same cycle.
func TestBackgroundWait_BudgetKeepsGrowingAcrossFallbacks(t *testing.T) {
	events := make(chan agent.AgentEvent, 8)

	tracker := &backgroundTaskTracker{}
	tracker.wait.start(testLogger(), events, func(string) {}, 20*time.Millisecond)
	defer tracker.wait.stopWaiting()

	parseTestLineWithTracker(testLogger(), []byte(oneLiveTask), tracker)
	parseTestLineWithTracker(testLogger(), []byte(successResult), tracker)
	awaitEvent(t, events) // warning
	awaitEvent(t, events) // done

	// The nudge the fallback triggers gets the agent as far as another wait.
	parseTestLineWithTracker(testLogger(), []byte(successResult), tracker)

	if budget := waitBudget(&tracker.wait); budget != 40*time.Millisecond {
		t.Errorf("expected the second wait to get a doubled budget, got %v", budget)
	}
}

// The idle reaper spares a process on this alone, so it has to end when the
// wait does — a permanently exempt process could never be reclaimed.
func TestBackgroundTaskTracker_ReapExemptionLastsExactlyAsLongAsTheWait(t *testing.T) {
	events := make(chan agent.AgentEvent, 4)

	tracker := &backgroundTaskTracker{}
	tracker.wait.start(testLogger(), events, func(string) {}, 20*time.Millisecond)
	defer tracker.wait.stopWaiting()

	if tracker.waitingForBackgroundWork() {
		t.Fatal("a fresh process is not waiting on anything")
	}

	parseTestLineWithTracker(testLogger(), []byte(oneLiveTask), tracker)
	if tracker.waitingForBackgroundWork() {
		t.Error("a running background task alone does not hold a turn open; the turn is still going")
	}

	parseTestLineWithTracker(testLogger(), []byte(successResult), tracker)
	if !tracker.waitingForBackgroundWork() {
		t.Fatal("expected the swallowed ending to exempt the process from reaping")
	}

	// The fallback ends the wait, and with it the exemption — even though the
	// task list never emptied.
	awaitEvent(t, events)
	awaitEvent(t, events)
	if tracker.waitingForBackgroundWork() {
		t.Error("expected the exemption to lapse once the fallback gave up waiting")
	}
}
