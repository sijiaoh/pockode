package process

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/projection"
	"github.com/pockode/server/session"
)

// messageRecorder collects what the manager puts on a session's stream, which
// is where a non-persisted event is the only place it can be observed.
type messageRecorder struct {
	mu       sync.Mutex
	messages []streamed
}

type streamed struct {
	SessionID string
	Record    agent.Wire
	Seq       session.HistorySeq
}

func (r *messageRecorder) Enqueue(sessionID string, record agent.Wire, seq session.HistorySeq) {
	r.mu.Lock()
	r.messages = append(r.messages, streamed{SessionID: sessionID, Record: record, Seq: seq})
	r.mu.Unlock()
}

func (r *messageRecorder) snapshot() []streamed {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]streamed(nil), r.messages...)
}

// A progress line is the latest value of something still changing; recorded, it
// becomes a lie the moment the next one arrives. It still has to reach the
// clients that are watching.
func TestProcess_ToolActivityIsBroadcastButNeverRecorded(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	m := NewManager(mockRegistry(mock), "", "/tmp", "", "", store, projection.FromReader(store), idleOnly(10*time.Minute))
	defer m.Shutdown()

	rec := &messageRecorder{}
	m.SetStreamSink(rec)

	m.GetOrCreateProcess(context.Background(), createActivatedSession(t, store, "sess-1"))

	sess := mock.session(t, "sess-1")
	sess.emit(t, agent.ToolActivityEvent{ToolUseID: "call-1", Activity: "still going"})
	sess.emit(t, agent.TextEvent{Content: "done"})

	// The text event lands in history; waiting for it proves the activity ahead
	// of it was processed and deliberately not written. The text opens a turn,
	// so its turn_started is the one other record.
	waitForHistory(t, store, "sess-1", 2)

	records, err := store.GetHistory(context.Background(), "sess-1")
	if err != nil {
		t.Fatalf("failed to read history: %v", err)
	}
	if len(records) != 2 {
		t.Fatalf("expected only the text event and its turn's start in history, got %d records", len(records))
	}

	var activity *streamed
	for _, msg := range rec.snapshot() {
		if msg.Record.Type() == agent.EventTypeToolActivity {
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
