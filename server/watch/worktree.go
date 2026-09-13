package watch

import (
	"context"
	"log/slog"
	"os/exec"
	"strings"
	"sync"
	"time"
)

const worktreePollInterval = 3 * time.Second

// WorktreeWatcher polls git worktree list and notifies subscribers when changes are detected.
type WorktreeWatcher struct {
	*BaseWatcher

	mainDir string

	stateMu   sync.Mutex
	lastState string
}

func NewWorktreeWatcher(mainDir string) *WorktreeWatcher {
	return &WorktreeWatcher{
		BaseWatcher: NewBaseWatcher(),
		mainDir:     mainDir,
	}
}

func (w *WorktreeWatcher) Start() error {
	state := w.pollWorktreeList()
	w.stateMu.Lock()
	w.lastState = state
	w.stateMu.Unlock()

	w.Go(w.pollLoop)
	slog.Info("WorktreeWatcher started", "mainDir", w.mainDir, "pollInterval", worktreePollInterval)
	return nil
}

func (w *WorktreeWatcher) Stop() {
	w.CancelAndWait()
	slog.Info("WorktreeWatcher stopped")
}

// Subscribe registers a subscriber under the client-chosen id.
func (w *WorktreeWatcher) Subscribe(id string, notifier Notifier) error {
	return w.AddSubscription(&Subscription{
		ID:       id,
		Notifier: notifier,
	})
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
	newState := w.pollWorktreeList()
	// See GitWatcher.checkAndNotify: an aborted poll is not a real change.
	if w.Context().Err() != nil {
		return
	}

	w.stateMu.Lock()
	changed := newState != w.lastState
	if changed {
		w.lastState = newState
	}
	w.stateMu.Unlock()

	if changed {
		w.notifySubscribers()
	}
}

func (w *WorktreeWatcher) pollWorktreeList() string {
	// See GitWatcher.pollGitState: the command must not outlive the watcher.
	ctx, cancel := context.WithTimeout(w.Context(), 10*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "git", "--no-optional-locks", "worktree", "list", "--porcelain")
	cmd.Dir = w.mainDir
	output, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(output))
}

func (w *WorktreeWatcher) notifySubscribers() {
	count := w.NotifyAll("worktree.changed", func(sub *Subscription) any {
		return map[string]any{
			"id": sub.ID,
		}
	})
	slog.Debug("notified worktree list change", "subscribers", count)
}
