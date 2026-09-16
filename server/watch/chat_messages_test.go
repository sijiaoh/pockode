package watch

import (
	"testing"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/process"
)

// The buffer's whole job is to absorb a burst without blocking the process
// goroutine, and a burst is now something one chatty command can produce on its
// own. Progress is the cheapest thing in there and the only thing whose loss
// costs nothing, so it is what gives way — a `done` pushed out of the buffer
// instead would leave a finished turn drawn as running.
func TestChatMessagesWatcher_ProgressGivesWayToEventsThatCannotBeLost(t *testing.T) {
	// Not started: nothing drains the buffer, which is the state this guard is
	// about.
	w := NewChatMessagesWatcher(nil)

	activity := process.ChatMessage{
		SessionID: "sess",
		Event:     agent.ToolActivityEvent{ToolUseID: "call-1", OutputDelta: "chunk"},
	}
	for range cap(w.msgCh) * 2 {
		w.OnChatMessage(activity)
	}

	queued := len(w.msgCh)
	if queued > cap(w.msgCh)/2+1 {
		t.Fatalf("progress filled the buffer to %d of %d; the reserve did not engage", queued, cap(w.msgCh))
	}

	// And the reserve is for this: the turn ending still gets in.
	w.OnChatMessage(process.ChatMessage{SessionID: "sess", Event: agent.DoneEvent{}})
	if len(w.msgCh) != queued+1 {
		t.Errorf("the done event was dropped with %d of %d slots free", cap(w.msgCh)-queued, cap(w.msgCh))
	}
}
