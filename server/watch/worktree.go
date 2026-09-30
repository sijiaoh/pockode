package watch

import (
	"context"
	"log/slog"
	"sync"
	"time"
)

const worktreePollInterval = 3 * time.Second

// WorktreeState is one read of the project's worktrees.
type WorktreeState struct {
	IsGitRepo bool
	// Fingerprint changes whenever the worktree list does. It is compared,
	// never shown.
	Fingerprint string
}

// WorktreePoller reads the current WorktreeState. It fails only when ctx ended
// the read, which says nothing about the repository.
type WorktreePoller func(ctx context.Context) (WorktreeState, error)

// WorktreeWatcher polls the project's worktrees and notifies subscribers when
// the list changes or the project stops or starts being a git repository.
type WorktreeWatcher struct {
	*BaseWatcher

	poll WorktreePoller

	// checkMu serializes read-compare-notify, so two checks cannot notify in
	// the opposite order to the one they read in and leave a subscriber holding
	// the older is_git_repo.
	checkMu   sync.Mutex
	lastState WorktreeState
}

func NewWorktreeWatcher(poll WorktreePoller) *WorktreeWatcher {
	return &WorktreeWatcher{
		BaseWatcher: NewBaseWatcher(),
		poll:        poll,
	}
}

func (w *WorktreeWatcher) Start() error {
	if state, err := w.poll(w.Context()); err == nil {
		w.checkMu.Lock()
		w.lastState = state
		w.checkMu.Unlock()
	}

	w.Go(w.pollLoop)
	slog.Info("WorktreeWatcher started", "pollInterval", worktreePollInterval)
	return nil
}

func (w *WorktreeWatcher) Stop() {
	w.CancelAndWait()
	slog.Info("WorktreeWatcher stopped")
}

// Subscribe registers a subscriber under the client-chosen id and reports
// whether the project is a git repository.
//
// The answer is read fresh rather than taken from the last poll: polling stops
// while nobody is subscribed, so the last poll can be arbitrarily old — a
// `git init` run in the meantime would otherwise be reported as not having
// happened. When the fresh read differs from the last poll, every subscriber is
// told, the new one included, since the others missed it as well.
func (w *WorktreeWatcher) Subscribe(id string, notifier Notifier) (bool, error) {
	if err := w.AddSubscription(&Subscription{
		ID:       id,
		Notifier: notifier,
	}); err != nil {
		return false, err
	}

	w.checkAndNotify()

	w.checkMu.Lock()
	defer w.checkMu.Unlock()
	return w.lastState.IsGitRepo, nil
}

func (w *WorktreeWatcher) pollLoop() {
	ticker := time.NewTicker(worktreePollInterval)
	defer ticker.Stop()

	for {
		select {
		case <-w.Context().Done():
			return
		case <-ticker.C:
			if !w.HasSubscriptions() {
				continue
			}

			w.checkAndNotify()
		}
	}
}

func (w *WorktreeWatcher) checkAndNotify() {
	w.checkMu.Lock()
	defer w.checkMu.Unlock()

	newState, err := w.poll(w.Context())
	// See GitWatcher.checkAndNotify: an aborted poll is not a real change.
	if err != nil || w.Context().Err() != nil {
		return
	}
	if newState == w.lastState {
		return
	}
	w.lastState = newState

	count := w.NotifyAll("worktree.changed", func(sub *Subscription) any {
		return worktreeChangedParams{
			ID:        sub.ID,
			IsGitRepo: newState.IsGitRepo,
		}
	})
	slog.Debug("notified worktree list change", "subscribers", count, "isGitRepo", newState.IsGitRepo)
}

type worktreeChangedParams struct {
	ID        string `json:"id"`
	IsGitRepo bool   `json:"is_git_repo"`
}
