package session

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

var ctx = context.Background()

func TestFileStore_Create(t *testing.T) {
	store, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewFileStore failed: %v", err)
	}

	sess, err := store.Create(ctx, "test-session-id", false)
	if err != nil {
		t.Fatalf("Create failed: %v", err)
	}

	if sess.ID != "test-session-id" {
		t.Errorf("expected ID 'test-session-id', got %q", sess.ID)
	}
	if sess.Title != "New Chat" {
		t.Errorf("expected title 'New Chat', got %q", sess.Title)
	}
	if sess.CreatedAt.IsZero() {
		t.Error("expected non-zero CreatedAt")
	}
	if sess.Mode != ModeDefault {
		t.Errorf("expected non-sandbox session mode to be %q, got %q", ModeDefault, sess.Mode)
	}
}

func TestFileStore_Create_SandboxDefaultsToYolo(t *testing.T) {
	store, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewFileStore failed: %v", err)
	}

	sess, err := store.Create(ctx, "sandbox-session", true)
	if err != nil {
		t.Fatalf("Create failed: %v", err)
	}

	if !sess.Sandbox {
		t.Error("expected Sandbox to be true")
	}
	if sess.Mode != ModeYolo {
		t.Errorf("expected sandbox session mode to default to %q, got %q", ModeYolo, sess.Mode)
	}
}

func TestFileStore_List(t *testing.T) {
	store, _ := NewFileStore(t.TempDir())

	// Initially empty
	sessions, err := store.List()
	if err != nil {
		t.Fatalf("List failed: %v", err)
	}
	if len(sessions) != 0 {
		t.Errorf("expected 0 sessions, got %d", len(sessions))
	}

	sess1, _ := store.Create(ctx, "session-1", false)
	sess2, _ := store.Create(ctx, "session-2", false)

	sessions, err = store.List()
	if err != nil {
		t.Fatalf("List failed: %v", err)
	}
	if len(sessions) != 2 {
		t.Errorf("expected 2 sessions, got %d", len(sessions))
	}

	// Newest first
	if sessions[0].ID != sess2.ID {
		t.Errorf("expected newest session first, got %s", sessions[0].ID)
	}
	if sessions[1].ID != sess1.ID {
		t.Errorf("expected oldest session second, got %s", sessions[1].ID)
	}
}

func TestFileStore_Delete(t *testing.T) {
	store, _ := NewFileStore(t.TempDir())

	sess, _ := store.Create(ctx, "session-to-delete", false)

	err := store.Delete(ctx, sess.ID)
	if err != nil {
		t.Fatalf("Delete failed: %v", err)
	}

	sessions, _ := store.List()
	if len(sessions) != 0 {
		t.Errorf("expected 0 sessions after delete, got %d", len(sessions))
	}
}

func TestFileStore_DeleteNonExistent(t *testing.T) {
	store, _ := NewFileStore(t.TempDir())

	err := store.Delete(ctx, "non-existent-id")
	if err != nil {
		t.Errorf("Delete non-existent should not error, got %v", err)
	}
}

func TestFileStore_Update(t *testing.T) {
	store, _ := NewFileStore(t.TempDir())

	sess, _ := store.Create(ctx, "session-to-update", false)
	if sess.Title != "New Chat" {
		t.Fatalf("expected initial title 'New Chat', got %q", sess.Title)
	}

	err := store.Update(ctx, sess.ID, "Updated Title")
	if err != nil {
		t.Fatalf("Update failed: %v", err)
	}

	sessions, _ := store.List()
	if len(sessions) != 1 {
		t.Fatalf("expected 1 session, got %d", len(sessions))
	}
	if sessions[0].Title != "Updated Title" {
		t.Errorf("expected title 'Updated Title', got %q", sessions[0].Title)
	}
	if !sessions[0].UpdatedAt.After(sess.UpdatedAt) {
		t.Error("expected UpdatedAt to be updated")
	}
}

func TestFileStore_UpdateNonExistent(t *testing.T) {
	store, _ := NewFileStore(t.TempDir())

	err := store.Update(ctx, "non-existent-id", "Title")
	if err != ErrSessionNotFound {
		t.Errorf("Update non-existent should return ErrSessionNotFound, got %v", err)
	}
}

func TestFileStore_Get(t *testing.T) {
	store, _ := NewFileStore(t.TempDir())

	// Get non-existent session
	_, found, err := store.Get("non-existent")
	if err != nil {
		t.Fatalf("Get failed: %v", err)
	}
	if found {
		t.Error("expected not found for non-existent session")
	}

	created, _ := store.Create(ctx, "test-session", false)
	sess, found, err := store.Get("test-session")
	if err != nil {
		t.Fatalf("Get failed: %v", err)
	}
	if !found {
		t.Error("expected session to be found")
	}
	if sess.ID != created.ID {
		t.Errorf("expected ID %s, got %s", created.ID, sess.ID)
	}
}

func TestFileStore_Activate(t *testing.T) {
	store, _ := NewFileStore(t.TempDir())

	sess, _ := store.Create(ctx, "session-to-activate", false)
	if sess.Activated {
		t.Error("expected new session to not be activated")
	}

	err := store.Activate(ctx, sess.ID)
	if err != nil {
		t.Fatalf("Activate failed: %v", err)
	}

	updated, found, _ := store.Get(sess.ID)
	if !found {
		t.Fatal("session not found after activate")
	}
	if !updated.Activated {
		t.Error("expected session to be activated")
	}
	if !updated.UpdatedAt.After(sess.UpdatedAt) {
		t.Error("expected UpdatedAt to be updated")
	}
}

func TestFileStore_ActivateNonExistent(t *testing.T) {
	store, _ := NewFileStore(t.TempDir())

	err := store.Activate(ctx, "non-existent-id")
	if err != ErrSessionNotFound {
		t.Errorf("Activate non-existent should return ErrSessionNotFound, got %v", err)
	}
}

func TestFileStore_Persistence(t *testing.T) {
	dir := t.TempDir()

	store1, _ := NewFileStore(dir)
	sess, _ := store1.Create(ctx, "persistent-session", false)

	// Create new store instance, should see persisted data
	store2, _ := NewFileStore(dir)
	sessions, err := store2.List()
	if err != nil {
		t.Fatalf("List failed: %v", err)
	}
	if len(sessions) != 1 {
		t.Errorf("expected 1 session, got %d", len(sessions))
	}
	if sessions[0].ID != sess.ID {
		t.Errorf("expected session ID %s, got %s", sess.ID, sessions[0].ID)
	}
}

func TestFileStore_History(t *testing.T) {
	store, _ := NewFileStore(t.TempDir())

	sess, _ := store.Create(ctx, "test-session", false)

	history, err := store.GetHistory(ctx, sess.ID)
	if err != nil {
		t.Fatalf("GetHistory failed: %v", err)
	}
	if len(history) != 0 {
		t.Errorf("expected 0 records, got %d", len(history))
	}

	record1 := map[string]string{"type": "message", "content": "hello"}
	record2 := map[string]string{"type": "text", "content": "world"}

	if err := store.AppendToHistory(ctx, sess.ID, record1); err != nil {
		t.Fatalf("AppendToHistory failed: %v", err)
	}
	if err := store.AppendToHistory(ctx, sess.ID, record2); err != nil {
		t.Fatalf("AppendToHistory failed: %v", err)
	}

	history, err = store.GetHistory(ctx, sess.ID)
	if err != nil {
		t.Fatalf("GetHistory failed: %v", err)
	}
	if len(history) != 2 {
		t.Fatalf("expected 2 records, got %d", len(history))
	}

	// Verify content (raw JSON)
	if string(history[0]) != `{"content":"hello","type":"message"}` {
		t.Errorf("unexpected record 0: %s", history[0])
	}
	if string(history[1]) != `{"content":"world","type":"text"}` {
		t.Errorf("unexpected record 1: %s", history[1])
	}
}

func TestFileStore_Touch_UpdatesUpdatedAt(t *testing.T) {
	store, _ := NewFileStore(t.TempDir())

	sess, _ := store.Create(ctx, "test-session", false)
	initialUpdatedAt := sess.UpdatedAt

	time.Sleep(time.Millisecond) // Ensure time difference
	store.Touch(ctx, sess.ID)

	sessions, _ := store.List()
	if !sessions[0].UpdatedAt.After(initialUpdatedAt) {
		t.Error("expected UpdatedAt to be updated after Touch")
	}
}

func TestFileStore_AppendToHistory_DoesNotUpdateTimestamp(t *testing.T) {
	store, _ := NewFileStore(t.TempDir())

	sess, _ := store.Create(ctx, "test-session", false)
	initialUpdatedAt := sess.UpdatedAt

	store.AppendToHistory(ctx, sess.ID, map[string]string{"type": "message"})

	sessions, _ := store.List()
	if sessions[0].UpdatedAt != initialUpdatedAt {
		t.Error("expected UpdatedAt to remain unchanged after AppendToHistory")
	}
}

func TestFileStore_Delete_RemovesHistory(t *testing.T) {
	store, _ := NewFileStore(t.TempDir())

	sessionID := "session-with-history"
	store.Create(ctx, sessionID, false)
	store.AppendToHistory(ctx, sessionID, map[string]string{"type": "message", "content": "test"})

	history, _ := store.GetHistory(ctx, sessionID)
	if len(history) != 1 {
		t.Fatal("expected history to exist before delete")
	}

	store.Delete(ctx, sessionID)

	history, _ = store.GetHistory(ctx, sessionID)
	if len(history) != 0 {
		t.Errorf("expected history to be deleted, got %d records", len(history))
	}
}

func TestFileStore_MigratesEmptyMode(t *testing.T) {
	dir := t.TempDir()
	sessionsDir := filepath.Join(dir, "sessions")
	if err := os.MkdirAll(sessionsDir, 0755); err != nil {
		t.Fatalf("failed to create sessions dir: %v", err)
	}

	// Write index.json with session that has no mode field (legacy data)
	indexContent := `{"sessions":[{"id":"legacy-session","title":"Legacy","createdAt":"2024-01-01T00:00:00Z","updatedAt":"2024-01-01T00:00:00Z"}]}`
	indexPath := filepath.Join(sessionsDir, "index.json")
	if err := os.WriteFile(indexPath, []byte(indexContent), 0644); err != nil {
		t.Fatalf("failed to write index: %v", err)
	}

	store, err := NewFileStore(dir)
	if err != nil {
		t.Fatalf("NewFileStore failed: %v", err)
	}

	sess, found, err := store.Get("legacy-session")
	if err != nil {
		t.Fatalf("Get failed: %v", err)
	}
	if !found {
		t.Fatal("expected session to be found")
	}
	if sess.Mode != ModeDefault {
		t.Errorf("expected mode to be migrated to %q, got %q", ModeDefault, sess.Mode)
	}
}
