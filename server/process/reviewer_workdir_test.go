package process

import (
	"context"
	"testing"
	"time"

	"github.com/pockode/server/session"
)

// A permission reviewer is never run in the project: with no directory of its
// own configured, it is not started at all.
func TestManager_PermissionReviewerNeedsItsOwnWorkDir(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	m := NewManager(mockRegistry(mock), "", t.TempDir(), "", "", store, idleOnly(10*time.Minute))
	defer m.Shutdown()
	ctx := context.Background()

	createSession(t, store, "main")
	reviewer, _, err := store.EnsurePermissionReviewer(ctx, "main", "reviewer")
	if err != nil {
		t.Fatalf("EnsurePermissionReviewer: %v", err)
	}

	if _, _, err := m.GetOrCreateProcess(ctx, reviewer); err == nil {
		t.Fatal("a reviewer started without a working directory of its own")
	}
	if len(mock.startCalls) != 0 {
		t.Errorf("start calls = %d, want none", len(mock.startCalls))
	}
}
