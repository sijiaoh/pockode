package session

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

// What a deleted worktree's data directory is left in has to be what a store
// would have left it in: a worktree recreated under the same name opens a
// FileStore over this very index and must see exactly the sessions that are
// still there.
func TestDeleteInDir(t *testing.T) {
	dataDir := t.TempDir()
	store, err := NewFileStore(dataDir)
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	for _, id := range []string{"sess-1", "sess-2"} {
		if _, err := store.Create(context.Background(), id, CreateSpec{}); err != nil {
			t.Fatalf("create %s: %v", id, err)
		}
		if _, err := store.AppendToHistory(context.Background(), id, map[string]any{"type": "text"}); err != nil {
			t.Fatalf("append to history of %s: %v", id, err)
		}
	}

	if err := DeleteInDir(dataDir, "sess-1"); err != nil {
		t.Fatalf("DeleteInDir: %v", err)
	}

	reopened, err := NewFileStore(dataDir)
	if err != nil {
		t.Fatalf("NewFileStore after the delete: %v", err)
	}
	sessions, err := reopened.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(sessions) != 1 || sessions[0].ID != "sess-2" {
		t.Fatalf("sessions = %+v, want only sess-2", sessions)
	}
	if _, err := os.Stat(filepath.Join(dataDir, "sessions", "sess-1")); !os.IsNotExist(err) {
		t.Errorf("the deleted session's transcript is still on disk: %v", err)
	}

	// A session that is not there is already gone, and its id — which could be
	// anything — is never turned into a path to find that out.
	if err := DeleteInDir(dataDir, "sess-1"); err != nil {
		t.Errorf("deleting an absent session: %v", err)
	}
}
