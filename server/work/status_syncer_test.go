package work

import (
	"context"
	"testing"
)

// --- HandlePromptRaised ---

func TestStatusSyncer_PromptRaised_InProgressToNeedsInput(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	task := createTask(t, s, story.ID, "T")
	startWorkWithSession(t, s, task.ID, "sess-1")

	syncer := NewStatusSyncer(s)
	syncer.HandlePromptRaised(context.Background(), "sess-1")

	w := getWork(t, s, task.ID)
	if w.Status != StatusNeedsInput {
		t.Errorf("expected status %s, got %s", StatusNeedsInput, w.Status)
	}
}

func TestStatusSyncer_PromptRaised_NoWorkForSession(t *testing.T) {
	s := newTestStore(t)
	syncer := NewStatusSyncer(s)

	// Should not panic
	syncer.HandlePromptRaised(context.Background(), "nonexistent")
}

func TestStatusSyncer_PromptRaised_SkipsCompletedWork(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	task := createTask(t, s, story.ID, "T")
	startWorkWithSession(t, s, task.ID, "sess-1")
	doneWork(t, s, task.ID)

	syncer := NewStatusSyncer(s)
	syncer.HandlePromptRaised(context.Background(), "sess-1")

	w := getWork(t, s, task.ID)
	if w.Status != StatusClosed {
		t.Errorf("expected %s unchanged, got %s", StatusClosed, w.Status)
	}
}

// A work waiting on child work is not waiting on this session's prompt, and
// needs_input is defined as the status in_progress work is paused into.
func TestStatusSyncer_PromptRaised_SkipsWaiting(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	task := createTask(t, s, story.ID, "T")
	startWorkWithSession(t, s, task.ID, "sess-1")

	if err := s.MarkWaiting(context.Background(), task.ID); err != nil {
		t.Fatalf("MarkWaiting: %v", err)
	}

	syncer := NewStatusSyncer(s)
	syncer.HandlePromptRaised(context.Background(), "sess-1")

	w := getWork(t, s, task.ID)
	if w.Status != StatusWaiting {
		t.Errorf("expected status %s unchanged, got %s", StatusWaiting, w.Status)
	}
}

// --- HandleUserAction ---

func TestStatusSyncer_UserAction_NeedsInputToInProgress(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	task := createTask(t, s, story.ID, "T")
	startWorkWithSession(t, s, task.ID, "sess-1")

	if err := s.MarkNeedsInput(context.Background(), task.ID); err != nil {
		t.Fatalf("MarkNeedsInput: %v", err)
	}

	syncer := NewStatusSyncer(s)
	syncer.HandleUserAction(context.Background(), "sess-1")

	w := getWork(t, s, task.ID)
	if w.Status != StatusInProgress {
		t.Errorf("expected status %s, got %s", StatusInProgress, w.Status)
	}
}

func TestStatusSyncer_UserAction_WaitingToInProgress(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	task := createTask(t, s, story.ID, "T")
	startWorkWithSession(t, s, task.ID, "sess-1")

	if err := s.MarkWaiting(context.Background(), task.ID); err != nil {
		t.Fatalf("MarkWaiting: %v", err)
	}

	syncer := NewStatusSyncer(s)
	syncer.HandleUserAction(context.Background(), "sess-1")

	w := getWork(t, s, task.ID)
	if w.Status != StatusInProgress {
		t.Errorf("expected status %s, got %s", StatusInProgress, w.Status)
	}
}

// stopped belongs to the AutoResumer's process-running branch, which resets the
// retry bookkeeping along with the status.
func TestStatusSyncer_UserAction_SkipsStopped(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	task := createTask(t, s, story.ID, "T")
	startWorkWithSession(t, s, task.ID, "sess-1")

	if err := s.Stop(context.Background(), task.ID); err != nil {
		t.Fatalf("Stop: %v", err)
	}

	syncer := NewStatusSyncer(s)
	syncer.HandleUserAction(context.Background(), "sess-1")

	w := getWork(t, s, task.ID)
	if w.Status != StatusStopped {
		t.Errorf("expected %s unchanged, got %s", StatusStopped, w.Status)
	}
}

func TestStatusSyncer_UserAction_NoWorkForSession(t *testing.T) {
	s := newTestStore(t)
	syncer := NewStatusSyncer(s)

	// Should not panic
	syncer.HandleUserAction(context.Background(), "nonexistent")
}
