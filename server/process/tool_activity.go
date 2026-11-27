package process

import (
	"sync"

	"github.com/pockode/server/agent"
)

// toolActivity is the newest thing each tool call still in flight has said about
// itself.
//
// Why a process keeps this at all: a tool_activity event is broadcast and never
// recorded (agent.EventType.Persisted), so a client that was not connected when
// one arrived has missed it — and on a phone not being connected is the normal
// case rather than an edge. Without this, reconnecting to a background task that
// has been running for half an hour shows its placeholder result and nothing
// else. It is handed to a client in the chat.messages.subscribe reply, next to
// the process state that reply already carries for the same reason.
//
// Live state, never a record: it is the latest value of something still
// changing, which is exactly what must not be written into a transcript.
type toolActivity struct {
	activityMu sync.Mutex
	// latest is the newest activity line, by tool_use_id.
	latest map[string]string
	// progress is the newest subagent progress, by tool_use_id; see
	// agent.ToolActivityEvent.Subagent.
	progress map[string]agent.SubagentProgress
	// background are the calls whose own result was only a placeholder, which is
	// what lets their entry survive that result.
	background map[string]bool
}

// observe updates the map from one event of the stream.
func (t *toolActivity) observe(event agent.AgentEvent) {
	switch e := event.(type) {
	case agent.ToolActivityEvent:
		// OutputDelta is deliberately not kept: it is an increment, and one
		// chunk on its own is not the tail of anything. The whole output arrives
		// with the result.
		if e.ToolUseID == "" || (e.Activity == "" && e.Subagent == nil) {
			return
		}
		t.activityMu.Lock()
		defer t.activityMu.Unlock()
		if e.Activity != "" {
			if t.latest == nil {
				t.latest = make(map[string]string)
			}
			t.latest[e.ToolUseID] = e.Activity
		}
		if e.Subagent != nil {
			if t.progress == nil {
				t.progress = make(map[string]agent.SubagentProgress)
			}
			t.progress[e.ToolUseID] = *e.Subagent
		}

	case agent.ToolResultEvent:
		if e.ToolUseID == "" {
			return
		}
		t.activityMu.Lock()
		defer t.activityMu.Unlock()
		if e.Subtype == agent.ToolResultBackgroundStarted {
			// The call has returned but the work has not: everything worth
			// keeping arrives after this.
			if t.background == nil {
				t.background = make(map[string]bool)
			}
			t.background[e.ToolUseID] = true
			return
		}
		delete(t.latest, e.ToolUseID)
		delete(t.progress, e.ToolUseID)
		delete(t.background, e.ToolUseID)

	case agent.DoneEvent, agent.InterruptedEvent, agent.ErrorEvent:
		// A turn that is over leaves no ordinary call running, so anything still
		// tracked for one is stale — a call cut short by a stop or a crashed CLI
		// never gets the result that would have cleared it. Background work is
		// the exception the whole map exists for: it outlives the turn by
		// definition.
		//
		// These three and not every AwaitsUserInput event: a permission request
		// pauses a turn that is still running, and the call it is about is
		// precisely one still in flight.
		t.activityMu.Lock()
		defer t.activityMu.Unlock()
		for id := range t.latest {
			if !t.background[id] {
				delete(t.latest, id)
			}
		}
		for id := range t.progress {
			if !t.background[id] {
				delete(t.progress, id)
			}
		}
	}
}

// snapshot returns the activity of every call still in flight, or nil when there
// is none.
func (t *toolActivity) snapshot() map[string]string {
	t.activityMu.Lock()
	defer t.activityMu.Unlock()

	if len(t.latest) == 0 {
		return nil
	}
	out := make(map[string]string, len(t.latest))
	for id, activity := range t.latest {
		out[id] = activity
	}
	return out
}

// progressSnapshot returns the subagent progress of every call still in flight
// that reported one, or nil when none did.
func (t *toolActivity) progressSnapshot() map[string]agent.SubagentProgress {
	t.activityMu.Lock()
	defer t.activityMu.Unlock()

	if len(t.progress) == 0 {
		return nil
	}
	out := make(map[string]agent.SubagentProgress, len(t.progress))
	for id, progress := range t.progress {
		out[id] = progress
	}
	return out
}
