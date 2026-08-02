package work

import (
	"context"
	"testing"
)

func TestCreate_TopLevelHasNoWorktreeByDefault(t *testing.T) {
	s := newTestStore(t)

	story := createStory(t, s, "Story")

	if story.Worktree != "" {
		t.Errorf("top-level worktree = %q, want empty (main)", story.Worktree)
	}
}

func TestCreate_ChildInheritsParentWorktree(t *testing.T) {
	s := newTestStore(t)

	story := createStory(t, s, "Story")
	if err := s.SetWorktree(context.Background(), story.ID, "feature-x"); err != nil {
		t.Fatalf("SetWorktree: %v", err)
	}

	task := createTask(t, s, story.ID, "Task")
	if task.Worktree != "feature-x" {
		t.Errorf("child worktree = %q, want inherited %q", task.Worktree, "feature-x")
	}
}

func TestSetWorktree_AssignsWhileOpen(t *testing.T) {
	s := newTestStore(t)

	story := createStory(t, s, "Story")
	if err := s.SetWorktree(context.Background(), story.ID, "feature-x"); err != nil {
		t.Fatalf("SetWorktree: %v", err)
	}

	if got := getWork(t, s, story.ID); got.Worktree != "feature-x" {
		t.Errorf("worktree = %q, want %q", got.Worktree, "feature-x")
	}
}

func TestSetWorktree_PropagatesToOpenDescendants(t *testing.T) {
	s := newTestStore(t)

	// Children created before the story starts inherit the empty default.
	story := createStory(t, s, "Story")
	task := createTask(t, s, story.ID, "Task")
	if task.Worktree != "" {
		t.Fatalf("pre-start child worktree = %q, want empty", task.Worktree)
	}

	// Capturing the story's worktree at start must pull those descendants along,
	// keeping the whole subtree on one worktree.
	if err := s.SetWorktree(context.Background(), story.ID, "feature-x"); err != nil {
		t.Fatalf("SetWorktree: %v", err)
	}
	if got := getWork(t, s, task.ID); got.Worktree != "feature-x" {
		t.Errorf("descendant worktree = %q, want propagated %q", got.Worktree, "feature-x")
	}
}

func TestSetWorktree_ImmutableOnceStarted(t *testing.T) {
	s := newTestStore(t)

	story := createStory(t, s, "Story")
	if err := s.SetWorktree(context.Background(), story.ID, "feature-x"); err != nil {
		t.Fatalf("SetWorktree: %v", err)
	}
	startWorkWithSession(t, s, story.ID, "s1")

	// A started work's worktree cannot change.
	if err := s.SetWorktree(context.Background(), story.ID, "feature-y"); err == nil {
		t.Fatal("SetWorktree on started work should fail")
	}
	if got := getWork(t, s, story.ID); got.Worktree != "feature-x" {
		t.Errorf("worktree = %q, want unchanged %q", got.Worktree, "feature-x")
	}
}

func TestSetWorktree_NoopWhenUnchanged(t *testing.T) {
	s := newTestStore(t)

	story := createStory(t, s, "Story")
	startWorkWithSession(t, s, story.ID, "s1")

	// Re-assigning the same (empty) worktree is a no-op even after start, so
	// restarting a main-worktree story never trips the immutability guard.
	if err := s.SetWorktree(context.Background(), story.ID, ""); err != nil {
		t.Errorf("SetWorktree no-op should not error: %v", err)
	}
}

func TestSetWorktree_NotFound(t *testing.T) {
	s := newTestStore(t)

	if err := s.SetWorktree(context.Background(), "missing", "wt"); err != ErrWorkNotFound {
		t.Errorf("err = %v, want ErrWorkNotFound", err)
	}
}

func TestUnclosedWorkByWorktree(t *testing.T) {
	works := []Work{
		{ID: "a", Title: "open on feature", Worktree: "feature", Status: StatusOpen},
		{ID: "b", Title: "in progress on feature", Worktree: "feature", Status: StatusInProgress},
		{ID: "c", Title: "closed on feature", Worktree: "feature", Status: StatusClosed},
		{ID: "d", Title: "open on other", Worktree: "other", Status: StatusOpen},
		{ID: "e", Title: "open on main", Worktree: "", Status: StatusInProgress},
	}

	t.Run("returns only non-closed work on the target worktree, in order", func(t *testing.T) {
		unclosed := UnclosedWorkByWorktree(works, "feature")
		if len(unclosed) != 2 {
			t.Fatalf("got %d blocking works, want 2: %+v", len(unclosed), unclosed)
		}
		if unclosed[0].ID != "a" || unclosed[1].ID != "b" {
			t.Errorf("blocking IDs = [%s %s], want [a b]", unclosed[0].ID, unclosed[1].ID)
		}
	})

	t.Run("all closed on the worktree means nothing blocks deletion", func(t *testing.T) {
		closedOnly := []Work{
			{ID: "x", Worktree: "feature", Status: StatusClosed},
			{ID: "y", Worktree: "feature", Status: StatusClosed},
		}
		if unclosed := UnclosedWorkByWorktree(closedOnly, "feature"); len(unclosed) != 0 {
			t.Errorf("got %d blocking works, want 0: %+v", len(unclosed), unclosed)
		}
	})

	t.Run("no work on the worktree means nothing blocks deletion", func(t *testing.T) {
		if unclosed := UnclosedWorkByWorktree(works, "empty"); len(unclosed) != 0 {
			t.Errorf("got %d blocking works, want 0: %+v", len(unclosed), unclosed)
		}
	})
}
