package process

import (
	"context"
	"testing"
	"time"

	"github.com/pockode/server/session"
)

// A process started with the value the store holds is the session's, even when
// the caller's meta was read before the switch: a sender that lost the race to
// another one must not close the process the other may have just delivered to.
func TestManager_GetOrCreateProcess_StaleMetaKeepsCurrentProcess(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	m := NewManager(mockRegistry(mock), "", "/tmp", "", "", store, idleOnly(10*time.Minute))
	defer m.Shutdown()
	ctx := context.Background()

	stale := createSession(t, store, "sess-1")
	if err := store.SetHTMLFirst(ctx, "sess-1", true); err != nil {
		t.Fatalf("SetHTMLFirst: %v", err)
	}
	current, _, _ := store.Get("sess-1")

	proc, _, err := m.GetOrCreateProcess(ctx, current)
	if err != nil {
		t.Fatalf("GetOrCreateProcess: %v", err)
	}
	again, created, err := m.GetOrCreateProcess(ctx, stale)
	if err != nil {
		t.Fatalf("GetOrCreateProcess (stale): %v", err)
	}
	if again != proc || created {
		t.Error("a caller with stale meta replaced the process started with the stored value")
	}
	if len(mock.startCalls) != 1 {
		t.Errorf("start calls = %d, want 1", len(mock.startCalls))
	}
}

// A process started with a value the store no longer holds is replaced.
func TestManager_GetOrCreateProcess_ReplacesProcessWithOldValue(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	m := NewManager(mockRegistry(mock), "", "/tmp", "", "", store, idleOnly(10*time.Minute))
	defer m.Shutdown()
	ctx := context.Background()

	old, _, err := m.GetOrCreateProcess(ctx, createSession(t, store, "sess-1"))
	if err != nil {
		t.Fatalf("GetOrCreateProcess: %v", err)
	}
	if err := store.SetHTMLFirst(ctx, "sess-1", true); err != nil {
		t.Fatalf("SetHTMLFirst: %v", err)
	}
	current, _, _ := store.Get("sess-1")
	proc, created, err := m.GetOrCreateProcess(ctx, current)
	if err != nil {
		t.Fatalf("GetOrCreateProcess: %v", err)
	}
	if proc == old || !created || !proc.HTMLFirst() {
		t.Error("the process started with the old value was not replaced by one with the new value")
	}
}
