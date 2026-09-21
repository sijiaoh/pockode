package process

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/session"
)

// messageRecorder collects what the manager broadcasts, which is where a
// non-persisted event is the only place it can be observed.
type messageRecorder struct {
	mu       sync.Mutex
	messages []ChatMessage
}

func (r *messageRecorder) OnChatMessage(msg ChatMessage) {
	r.mu.Lock()
	r.messages = append(r.messages, msg)
	r.mu.Unlock()
}

func (r *messageRecorder) snapshot() []ChatMessage {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]ChatMessage(nil), r.messages...)
}

// A progress line is the latest value of something still changing; recorded, it
// becomes a lie the moment the next one arrives. It still has to reach the
// clients that are watching.
func TestProcess_ToolActivityIsBroadcastButNeverRecorded(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	m := NewManager(mockRegistry(mock), "", "/tmp", "", "", store, idleOnly(10*time.Minute))
	defer m.Shutdown()

	rec := &messageRecorder{}
	m.SetMessageListener(rec)

	m.GetOrCreateProcess(context.Background(), createActivatedSession(t, store, "sess-1"))

	sess := mock.session(t, "sess-1")
	sess.emit(t, agent.ToolActivityEvent{ToolUseID: "call-1", Activity: "still going"})
	sess.emit(t, agent.TextEvent{Content: "done"})

	// The text event lands in history; waiting for it proves the activity ahead
	// of it was processed and deliberately not written.
	waitForHistory(t, store, "sess-1", 1)

	records, err := store.GetHistory(context.Background(), "sess-1")
	if err != nil {
		t.Fatalf("failed to read history: %v", err)
	}
	if len(records) != 1 {
		t.Fatalf("expected only the text event in history, got %d records", len(records))
	}

	var activity *ChatMessage
	for _, msg := range rec.snapshot() {
		if msg.Event.EventType() == agent.EventTypeToolActivity {
			activity = &msg
		}
	}
	if activity == nil {
		t.Fatal("the activity never reached the listener")
	}
	if activity.Seq != session.NoHistorySeq {
		t.Errorf("Seq = %d, want NoHistorySeq: there is no record for a client to quote", activity.Seq)
	}
}

// A client on a phone reconnects mid-run far more often than it watches one
// start, so the newest activity of every call still in flight has to be
// answerable from process state.
func TestProcess_ToolActivityIsKeptForACallStillInFlight(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	m := NewManager(mockRegistry(mock), "", "/tmp", "", "", store, idleOnly(10*time.Minute))
	defer m.Shutdown()

	m.GetOrCreateProcess(context.Background(), createActivatedSession(t, store, "sess-1"))
	sess := mock.session(t, "sess-1")

	sess.emit(t, agent.ToolActivityEvent{ToolUseID: "call-1", Activity: "first"})
	sess.emit(t, agent.ToolActivityEvent{ToolUseID: "call-1", Activity: "second"})
	waitUntil(t, "the activity to be tracked", func() bool {
		return m.GetToolActivity("sess-1")["call-1"] == "second"
	})

	// A backgrounded call's own result is a placeholder, so the progress worth
	// keeping is all still to come.
	sess.emit(t, agent.ToolResultEvent{ToolUseID: "call-1", ToolResult: "running in background", Subtype: agent.ToolResultBackgroundStarted})
	waitForHistory(t, store, "sess-1", 1)
	if got := m.GetToolActivity("sess-1")["call-1"]; got != "second" {
		t.Errorf("activity after the placeholder = %q, want it kept", got)
	}

	// Nor does the end of the turn settle it: that is what background means.
	sess.emit(t, agent.DoneEvent{})
	waitForHistory(t, store, "sess-1", 2)
	if got := m.GetToolActivity("sess-1")["call-1"]; got != "second" {
		t.Errorf("activity after the turn ended = %q, want it kept", got)
	}

	// The real outcome settles the run.
	sess.emit(t, agent.ToolResultEvent{ToolUseID: "call-1", ToolResult: "finished", Subtype: agent.ToolResultBackgroundResult})
	waitForHistory(t, store, "sess-1", 3)
	waitUntil(t, "the settled run to be forgotten", func() bool {
		return m.GetToolActivity("sess-1") == nil
	})
}

// An ordinary call is settled by its result, and one that never returns is
// settled by the turn ending — otherwise a reconnect would show a stale line
// under a call that was interrupted half an hour ago.
func TestProcess_ToolActivityIsDroppedWhenTheRunSettles(t *testing.T) {
	tests := []struct {
		name    string
		settled agent.AgentEvent
	}{
		{"the call returned", agent.ToolResultEvent{ToolUseID: "call-1", ToolResult: "ok"}},
		{"the turn was interrupted", agent.InterruptedEvent{}},
		{"the turn ended", agent.DoneEvent{}},
		{"the CLI died mid-turn", agent.ErrorEvent{Error: "claude exited"}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store, _ := session.NewFileStore(t.TempDir())
			mock := &mockAgent{}
			m := NewManager(mockRegistry(mock), "", "/tmp", "", "", store, idleOnly(10*time.Minute))
			defer m.Shutdown()

			m.GetOrCreateProcess(context.Background(), createActivatedSession(t, store, "sess-1"))
			sess := mock.session(t, "sess-1")

			sess.emit(t, agent.ToolActivityEvent{ToolUseID: "call-1", Activity: "working"})
			waitUntil(t, "the activity to be tracked", func() bool {
				return m.GetToolActivity("sess-1")["call-1"] == "working"
			})

			sess.emit(t, tt.settled)
			waitUntil(t, "the run to be forgotten", func() bool {
				return m.GetToolActivity("sess-1") == nil
			})
		})
	}
}

// A pause is not an end: the call a permission request is about is the one
// still running, and clearing its activity would blank the row the user is
// looking at while they decide.
func TestProcess_ToolActivitySurvivesAPausedTurn(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	m := NewManager(mockRegistry(mock), "", "/tmp", "", "", store, idleOnly(10*time.Minute))
	defer m.Shutdown()

	m.GetOrCreateProcess(context.Background(), createActivatedSession(t, store, "sess-1"))
	sess := mock.session(t, "sess-1")

	sess.emit(t, agent.ToolActivityEvent{ToolUseID: "call-1", Activity: "working"})
	waitUntil(t, "the activity to be tracked", func() bool {
		return m.GetToolActivity("sess-1")["call-1"] == "working"
	})

	// The activity itself is never recorded, so the request is the first record
	// there is; waiting for it proves the process has handled both.
	sess.emit(t, agent.PermissionRequestEvent{RequestID: "r1", ToolName: "Bash", ToolUseID: "call-2"})
	waitForHistory(t, store, "sess-1", 1)

	if got := m.GetToolActivity("sess-1")["call-1"]; got != "working" {
		t.Errorf("activity after a paused turn = %q, want it kept", got)
	}
}

// Nothing to hand a client that subscribes to a session with no process behind
// it, and asking must not create one.
func TestManager_ToolActivityOfAnEndedSessionIsEmpty(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	m := NewManager(mockRegistry(&mockAgent{}), "", "/tmp", "", "", store, idleOnly(10*time.Minute))
	defer m.Shutdown()

	if activity := m.GetToolActivity("never-started"); activity != nil {
		t.Errorf("expected no activity, got %v", activity)
	}
}
