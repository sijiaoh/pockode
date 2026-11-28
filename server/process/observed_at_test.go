package process

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/session"
)

// A client measures a call between two records, and it may hold one from history
// and the other from a notification — a page reloaded mid-call. Both copies of a
// record therefore have to carry the one moment Pockode saw the event.
func TestProcess_StoredAndBroadcastRecordsCarryTheSameObservedAt(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	m := NewManager(mockRegistry(mock), "", "/tmp", "", "", store, idleOnly(10*time.Minute))
	defer m.Shutdown()

	rec := &messageRecorder{}
	m.SetStreamSink(rec)

	m.GetOrCreateProcess(context.Background(), createActivatedSession(t, store, "sess-1"))
	sess := mock.session(t, "sess-1")

	before := time.Now()
	sess.emit(t, agent.ToolCallEvent{ToolUseID: "call-1", ToolName: "Bash", ToolInput: json.RawMessage(`{}`)})
	// The call opens a turn nothing prompted, whose turn_started goes first.
	waitForHistory(t, store, "sess-1", 2)
	after := time.Now()

	records, err := store.GetHistory(context.Background(), "sess-1")
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := agent.DecodeRecord(records[1])
	if err != nil {
		t.Fatal(err)
	}
	stored, ok := decoded.(agent.ToolCallRecord)
	if !ok {
		t.Fatalf("records[1] = %T, want a tool call", decoded)
	}
	if stored.ObservedAt == nil || stored.ObservedAt.Before(before) || stored.ObservedAt.After(after) {
		t.Fatalf("stored observed_at = %v, want between %v and %v", stored.ObservedAt, before, after)
	}

	// The broadcast follows the append, so history having the record does not
	// mean the listener has heard of it yet.
	var broadcast *agent.ToolCallRecord
	deadline := time.Now().Add(5 * time.Second)
	for broadcast == nil {
		for _, msg := range rec.snapshot() {
			if r, ok := msg.Record.(agent.ToolCallRecord); ok {
				broadcast = &r
			}
		}
		if broadcast == nil {
			if time.Now().After(deadline) {
				t.Fatal("the tool call was never broadcast")
			}
			time.Sleep(5 * time.Millisecond)
		}
	}
	if broadcast.ObservedAt == nil || !broadcast.ObservedAt.Equal(*stored.ObservedAt) {
		t.Fatalf("broadcast observed_at = %v, stored %v", broadcast.ObservedAt, *stored.ObservedAt)
	}
}
