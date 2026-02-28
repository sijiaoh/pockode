package work

import (
	"context"
	"testing"
)

func TestNeedsInputSyncer_InProgressToNeedsInput(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	task := createTask(t, s, story.ID, "T")
	startWorkWithSession(t, s, task.ID, "sess-1")

	syncer := NewNeedsInputSyncer(s)
	syncer.SyncNeedsInput(context.Background(), "sess-1", true)

	w := getWork(t, s, task.ID)
	if w.Status != StatusNeedsInput {
		t.Errorf("expected status %s, got %s", StatusNeedsInput, w.Status)
	}
}

func TestNeedsInputSyncer_NeedsInputToInProgress(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	task := createTask(t, s, story.ID, "T")
	startWorkWithSession(t, s, task.ID, "sess-1")

	// First transition to needs_input
	syncer := NewNeedsInputSyncer(s)
	syncer.SyncNeedsInput(context.Background(), "sess-1", true)

	// Then back to in_progress
	syncer.SyncNeedsInput(context.Background(), "sess-1", false)

	w := getWork(t, s, task.ID)
	if w.Status != StatusInProgress {
		t.Errorf("expected status %s, got %s", StatusInProgress, w.Status)
	}
}

func TestNeedsInputSyncer_NoWorkForSession(t *testing.T) {
	s := newTestStore(t)
	syncer := NewNeedsInputSyncer(s)

	// Should not panic
	syncer.SyncNeedsInput(context.Background(), "nonexistent", true)
}

func TestNeedsInputSyncer_IdempotentNeedsInput(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	task := createTask(t, s, story.ID, "T")
	startWorkWithSession(t, s, task.ID, "sess-1")

	syncer := NewNeedsInputSyncer(s)

	// First call transitions
	syncer.SyncNeedsInput(context.Background(), "sess-1", true)
	w := getWork(t, s, task.ID)
	if w.Status != StatusNeedsInput {
		t.Fatalf("expected needs_input, got %s", w.Status)
	}

	// Second call is a no-op (needs_input → needs_input is not a valid transition,
	// but the syncer should skip it without error)
	syncer.SyncNeedsInput(context.Background(), "sess-1", true)
	w = getWork(t, s, task.ID)
	if w.Status != StatusNeedsInput {
		t.Errorf("expected status to remain needs_input, got %s", w.Status)
	}
}

func TestNeedsInputSyncer_SkipsNonMatchingStatus(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	task := createTask(t, s, story.ID, "T")
	startWorkWithSession(t, s, task.ID, "sess-1")

	syncer := NewNeedsInputSyncer(s)

	// Calling with false when in_progress should be a no-op
	syncer.SyncNeedsInput(context.Background(), "sess-1", false)
	w := getWork(t, s, task.ID)
	if w.Status != StatusInProgress {
		t.Errorf("expected in_progress unchanged, got %s", w.Status)
	}
}

func TestNeedsInputSyncer_SkipsCompletedWork(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	task := createTask(t, s, story.ID, "T")
	startWorkWithSession(t, s, task.ID, "sess-1")
	doneWork(t, s, task.ID)

	// After doneWork, autoClose promotes to closed (no children)
	w := getWork(t, s, task.ID)
	statusBefore := w.Status

	syncer := NewNeedsInputSyncer(s)

	// Should not transition completed work (done or closed)
	syncer.SyncNeedsInput(context.Background(), "sess-1", true)
	w = getWork(t, s, task.ID)
	if w.Status != statusBefore {
		t.Errorf("expected status %s unchanged, got %s", statusBefore, w.Status)
	}
}
