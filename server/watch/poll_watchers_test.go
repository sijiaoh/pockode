package watch

import "testing"

// Cancelling a watcher aborts the git command mid-poll, so the poll reports an
// empty tree rather than the truth. Announcing that as a change would send
// subscribers chasing a state nobody ever wrote, at the moment the work tree
// behind it is being removed.
func TestPollWatchers_StayQuietAfterStop(t *testing.T) {
	gitWatcher := NewGitWatcher(t.TempDir())
	worktreeWatcher := NewWorktreeWatcher(t.TempDir())

	tests := []struct {
		name           string
		subscribe      func(Notifier)
		seedState      func()
		checkAndNotify func()
		stop           func()
	}{
		{"git", func(n Notifier) { gitWatcher.Subscribe(n) }, func() { gitWatcher.lastState = "seeded" }, gitWatcher.checkAndNotify, gitWatcher.Stop},
		{"worktree", func(n Notifier) { worktreeWatcher.Subscribe(n) }, func() { worktreeWatcher.lastState = "seeded" }, worktreeWatcher.checkAndNotify, worktreeWatcher.Stop},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			notifier := &captureNotifier{}
			tt.subscribe(notifier)
			// The temp dir is not a git repo, so every poll reads as a change away
			// from this seed. Asserting the live case first keeps the assertion
			// below from holding for the wrong reason.
			tt.seedState()

			tt.checkAndNotify()
			if notifier.count() != 1 {
				t.Fatalf("expected the live watcher to notify once, got %d", notifier.count())
			}

			tt.seedState()
			tt.stop()
			tt.checkAndNotify()

			if notifier.count() != 1 {
				t.Errorf("expected no further notification after Stop, got %d", notifier.count())
			}
		})
	}
}
