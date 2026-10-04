package claude

import (
	"sync"
	"time"

	"github.com/pockode/server/agent"
)

// thinkingDisplayMinVersion is the first claude that accepts --thinking-display.
// Bisected over the published releases: 2.1.92 refuses the flag as an unknown
// option and 2.1.94 takes it (there is no 2.1.93). A CLI refusing a flag does not
// start at all, which is why the flag is gated rather than always passed.
const thinkingDisplayMinVersion = "2.1.94"

// thinkingDisplayArgs asks the CLI for its thinking as text, when the CLI is new
// enough to be asked.
//
// Without it every thinking block arrives with an empty `thinking` and only a
// signature (measured on claude 2.1.289): the model's thinking display defaults
// to "omitted", and summaries have to be requested. "summarized" is what the
// CLI's own transcript view shows. The flag is hidden from --help, so an unknown
// or unreadable version is treated as one that lacks it — the thinking rows then
// carry a duration and no text, which is the cost of not knowing.
func thinkingDisplayArgs(version string) []string {
	if version == "" {
		return nil
	}
	cmp, err := agent.CompareVersions(version, thinkingDisplayMinVersion)
	if err != nil || cmp < 0 {
		return nil
	}
	return []string{"--thinking-display", "summarized"}
}

// thinkingClock measures how long each thinking block took, and keeps the
// thinking_tokens frames down to one signal per stretch of thinking.
//
// Claude reports no thinking time, and its thinking text arrives whole in one
// frame, so the duration is the time from the thread's last transcript output —
// text, a tool call, a tool result, a previous thinking block, or the message
// that opened the turn — to the block's arrival: how long the agent was quiet
// before saying this. Transcript output on purpose: the CLI writes
// thinking_tokens estimates and bookkeeping frames all through a think, and
// measuring from the last line of any kind would make nearly every thinking 0s.
//
// Kept per thread, because a backgrounded subagent writes between the main
// agent's own lines: the main thread is "", a subagent the call that spawned it,
// whose clock starts when that call is made.
//
// Live state of this process and nothing else. What it produces is written into
// the record once and never read back.
type thinkingClock struct {
	clockMu sync.Mutex
	// since is when each thread last produced transcript output. A thread with
	// no entry has nothing to measure from, and its thinking has no duration.
	since map[string]time.Time
	// backgrounded are the calls whose result was only a placeholder: what runs
	// under them outlives the turn, so their clocks survive its end.
	backgrounded map[string]bool
	// sent is when the last message went to the CLI.
	sent time.Time
	// turnOpen is whether a turn is running: opened by a message, or by a
	// background result bringing a parked turn back, and ended by the turn's
	// ending or its parking.
	turnOpen bool
	// parked is whether the last turn parked on background work rather than
	// ending, which is the one state a background result brings a turn back
	// from.
	parked bool
	// signalled is whether the main thread's current stretch of thinking has
	// already been announced.
	signalled bool
}

// messageSent starts the main thread's clock when nothing is running on it: a
// message that opens a turn is where the agent's first quiet begins.
//
// A message sent into a running turn moves nothing. The agent goes on with
// whatever it was doing — possibly a thinking already under way, which a
// restarted clock would cut short — and reads the message at its next call to
// the model, a moment nothing reports.
func (c *thinkingClock) messageSent(at time.Time) {
	c.clockMu.Lock()
	defer c.clockMu.Unlock()
	c.sent = at
	c.parked = false
	if !c.turnOpen {
		c.turnOpen = true
		c.markLocked("", at)
	}
}

// observe stamps one parsed event with what the clock knows, and reports
// whether the event should be sent at all.
func (c *thinkingClock) observe(event agent.AgentEvent, at time.Time) (agent.AgentEvent, bool) {
	c.clockMu.Lock()
	defer c.clockMu.Unlock()

	switch e := event.(type) {
	case agent.ThinkingDeltaEvent:
		// The frames repeat several times a second and carry nothing but a
		// token estimate, so only the first of a stretch says anything.
		if c.signalled {
			return nil, false
		}
		c.signalled = true

	case agent.ThinkingEvent:
		if start, ok := c.since[e.ParentToolUseID]; ok {
			// Never zero for a thinking that was measured: zero is how the
			// record says it was not, and a client rounds up to whole seconds.
			e.DurationMs = max(at.Sub(start).Milliseconds(), 1)
		}
		c.markLocked(e.ParentToolUseID, at)
		return e, true

	case agent.TextEvent:
		c.markLocked(e.ParentToolUseID, at)

	case agent.ToolCallEvent:
		c.markLocked(e.ParentToolUseID, at)
		// Any call may be a subagent's spawn, and the subagent's first quiet
		// begins here.
		c.markLocked(e.ToolUseID, at)

	case agent.ToolResultEvent:
		switch e.Subtype {
		case agent.ToolResultBackgroundStarted:
			// What runs under the call may still be thinking.
			if c.backgrounded == nil {
				c.backgrounded = make(map[string]bool)
			}
			c.backgrounded[e.ToolUseID] = true
		default:
			delete(c.since, e.ToolUseID)
			delete(c.backgrounded, e.ToolUseID)
		}
		if e.ParentToolUseID == "" && e.Subtype == agent.ToolResultBackgroundResult {
			// Work finishing in the background is nothing the agent said, so
			// it does not cut short a thinking under way, nor start a clock for
			// a turn that is over. Only a parked turn is brought back by one,
			// and there it is where the quiet begins.
			if !c.parked {
				break
			}
			c.parked = false
			c.turnOpen = true
		}
		c.markLocked(e.ParentToolUseID, at)

	case agent.DoneEvent, agent.ErrorEvent, agent.InterruptedEvent, agent.BackgroundWaitEvent:
		// What the CLI does next starts from a message, or — after a background
		// wait — from the task result that brings it back; the time in between
		// is nobody's thinking.
		//
		// The exception is a message sent after the turn's last output, which
		// the CLI had finished before reading: it opens the next turn, which is
		// running from the moment this ending is read. Not after a Stop, which
		// may have thrown the message away with the turn — then the next
		// message has to be free to start the clock itself.
		_, interrupted := event.(agent.InterruptedEvent)
		if last, ok := c.since[""]; ok && c.sent.After(last) && !interrupted {
			c.since[""] = c.sent
			c.turnOpen = true
			c.parked = false
		} else {
			delete(c.since, "")
			c.turnOpen = false
			_, c.parked = event.(agent.BackgroundWaitEvent)
		}
		c.signalled = false
		// Calls the turn left open will not be answered now, except the ones
		// still running in the background.
		for thread := range c.since {
			if thread != "" && !c.backgrounded[thread] {
				delete(c.since, thread)
			}
		}
	}
	return event, true
}

func (c *thinkingClock) markLocked(thread string, at time.Time) {
	if c.since == nil {
		c.since = make(map[string]time.Time)
	}
	c.since[thread] = at
	if thread == "" {
		c.signalled = false
		// Output from the main agent proves a parked turn came back, whatever
		// brought it back — some background endings are never forwarded.
		if c.parked {
			c.parked = false
			c.turnOpen = true
		}
	}
}
