package session

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func newReviewerTestStore(t *testing.T) (*FileStore, string) {
	t.Helper()
	dataDir := t.TempDir()
	store, err := NewFileStore(dataDir)
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	return store, dataDir
}

func TestModeUnattendedIsAcceptedAndLaunchesAsYolo(t *testing.T) {
	tests := []struct {
		mode   Mode
		valid  bool
		bypass bool
	}{
		{ModeDefault, true, false},
		{ModeYolo, true, true},
		{ModeUnattended, true, true},
		{"plan", false, false},
	}
	for _, tt := range tests {
		if got := tt.mode.IsValid(); got != tt.valid {
			t.Errorf("%q.IsValid() = %v, want %v", tt.mode, got, tt.valid)
		}
		if got := tt.mode.BypassesAgentGate(); got != tt.bypass {
			t.Errorf("%q.BypassesAgentGate() = %v, want %v", tt.mode, got, tt.bypass)
		}
	}
}

// One reviewer per main session: the first call creates it on the main
// session's agent, every later one returns that same session.
func TestEnsurePermissionReviewer_FindsOrCreates(t *testing.T) {
	store, dataDir := newReviewerTestStore(t)
	if _, err := store.Create(ctx, "main", CreateSpec{AgentType: AgentTypeCodex, Mode: ModeUnattended, Model: "gpt-5.6-sol"}); err != nil {
		t.Fatalf("create main: %v", err)
	}

	first, created, err := store.EnsurePermissionReviewer(ctx, "main", "reviewer-1")
	if err != nil || !created {
		t.Fatalf("first EnsurePermissionReviewer = %v, %v; want a new reviewer", created, err)
	}
	if first.ID != "reviewer-1" || first.PermissionReviewerOf != "main" || !first.IsPermissionReviewer() {
		t.Errorf("reviewer = %+v, want reviewer-1 reviewing main", first)
	}
	if first.AgentType != AgentTypeCodex {
		t.Errorf("reviewer agent = %q, want the main session's %q", first.AgentType, AgentTypeCodex)
	}
	if first.Mode != ModeDefault || first.Model != "" {
		t.Errorf("reviewer mode/model = %q/%q, want default and empty: neither is copied from the main session", first.Mode, first.Model)
	}

	again, created, err := store.EnsurePermissionReviewer(ctx, "main", "reviewer-2")
	if err != nil || created || again.ID != "reviewer-1" {
		t.Fatalf("second EnsurePermissionReviewer = %s, %v, %v; want reviewer-1 found", again.ID, created, err)
	}

	// The relation is stored, not remembered: a restarted server finds the same
	// reviewer.
	reopened, err := NewFileStore(dataDir)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	found, ok, err := FindPermissionReviewer(reopened, "main")
	if err != nil || !ok || found.ID != "reviewer-1" {
		t.Fatalf("FindPermissionReviewer after reopen = %s, %v, %v; want reviewer-1", found.ID, ok, err)
	}
	if _, ok, _ := FindPermissionReviewer(reopened, "reviewer-1"); ok {
		t.Error("a reviewer was found for the reviewer itself")
	}
}

func TestEnsurePermissionReviewer_Refuses(t *testing.T) {
	store, _ := newReviewerTestStore(t)
	if _, err := store.Create(ctx, "main", CreateSpec{}); err != nil {
		t.Fatalf("create main: %v", err)
	}
	if _, _, err := store.EnsurePermissionReviewer(ctx, "main", "reviewer"); err != nil {
		t.Fatalf("create reviewer: %v", err)
	}

	if _, _, err := store.EnsurePermissionReviewer(ctx, "missing", "r"); !errors.Is(err, ErrSessionNotFound) {
		t.Errorf("reviewer for a missing session: err = %v, want ErrSessionNotFound", err)
	}
	if _, _, err := store.EnsurePermissionReviewer(ctx, "reviewer", "r"); !errors.Is(err, ErrReviewerOfReviewer) {
		t.Errorf("reviewer for a reviewer: err = %v, want ErrReviewerOfReviewer", err)
	}
	if _, ok, _ := store.Get("r"); ok {
		t.Error("a refused reviewer was created anyway")
	}
}

type deleteRecorder struct{ deleted []string }

func (r *deleteRecorder) OnSessionChange(e SessionChangeEvent) {
	if e.Op == OperationDelete {
		r.deleted = append(r.deleted, e.Session.ID)
	}
}

func TestDelete_TakesThePermissionReviewerWithIt(t *testing.T) {
	store, dataDir := newReviewerTestStore(t)
	for _, id := range []string{"main", "other"} {
		if _, err := store.Create(ctx, id, CreateSpec{}); err != nil {
			t.Fatalf("create %s: %v", id, err)
		}
	}
	for main, reviewer := range map[string]string{"main": "main-reviewer", "other": "other-reviewer"} {
		if _, _, err := store.EnsurePermissionReviewer(ctx, main, reviewer); err != nil {
			t.Fatalf("create reviewer of %s: %v", main, err)
		}
		if _, err := store.AppendToHistory(ctx, reviewer, map[string]any{"type": "text"}); err != nil {
			t.Fatalf("append to %s: %v", reviewer, err)
		}
	}
	recorder := &deleteRecorder{}
	store.AddOnChangeListener(recorder)

	// Deleting a reviewer leaves its main session alone.
	if err := store.Delete(ctx, "other-reviewer"); err != nil {
		t.Fatalf("delete other-reviewer: %v", err)
	}
	if _, ok, _ := store.Get("other"); !ok {
		t.Error("deleting a reviewer deleted its main session")
	}

	if err := store.Delete(ctx, "main"); err != nil {
		t.Fatalf("delete main: %v", err)
	}
	if _, ok, _ := store.Get("main-reviewer"); ok {
		t.Error("the main session's reviewer survived its deletion")
	}
	if _, err := os.Stat(filepath.Join(dataDir, "sessions", "main-reviewer")); !os.IsNotExist(err) {
		t.Errorf("the reviewer's transcript is still on disk: %v", err)
	}
	// Every subscriber holding the reviewer's row has to be told it is gone.
	want := []string{"other-reviewer", "main", "main-reviewer"}
	if len(recorder.deleted) != len(want) {
		t.Fatalf("delete events = %v, want %v", recorder.deleted, want)
	}
	for i := range want {
		if recorder.deleted[i] != want[i] {
			t.Fatalf("delete events = %v, want %v", recorder.deleted, want)
		}
	}
}

func TestDeleteInDir_TakesThePermissionReviewerWithIt(t *testing.T) {
	store, dataDir := newReviewerTestStore(t)
	if _, err := store.Create(ctx, "main", CreateSpec{}); err != nil {
		t.Fatalf("create main: %v", err)
	}
	if _, _, err := store.EnsurePermissionReviewer(ctx, "main", "reviewer"); err != nil {
		t.Fatalf("create reviewer: %v", err)
	}

	if deleted, err := DeleteInDir(dataDir, "main"); err != nil || !deleted {
		t.Fatalf("DeleteInDir = %v, %v, want a deletion", deleted, err)
	}
	sessions, err := NewDirReader(dataDir).List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(sessions) != 0 {
		t.Errorf("sessions left = %+v, want none", sessions)
	}
}
