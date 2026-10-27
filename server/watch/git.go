package watch

import (
	"context"
	"encoding/json"
	"log/slog"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/pockode/server/git"
)

const gitPollInterval = 3 * time.Second

// GitWatcher polls git state (HEAD + status) and notifies subscribers on changes.
// Detects working tree changes and HEAD changes (commit, checkout, etc).
// For file-specific diff content changes, use GitDiffWatcher instead.
type GitWatcher struct {
	*BaseWatcher

	workDir string

	stateMu   sync.Mutex
	lastState string // HEAD hash + git.status result
}

func NewGitWatcher(workDir string) *GitWatcher {
	return &GitWatcher{
		BaseWatcher: NewBaseWatcher(),
		workDir:     workDir,
	}
}

func (w *GitWatcher) Start() error {
	// Without an answer the baseline is empty, and the first poll that has one
	// announces it once.
	state, _ := w.pollGitState()
	w.stateMu.Lock()
	w.lastState = state
	w.stateMu.Unlock()

	w.Go(w.pollLoop)
	slog.Info("GitWatcher started", "workDir", w.workDir, "pollInterval", gitPollInterval)
	return nil
}

func (w *GitWatcher) Stop() {
	w.CancelAndWait()
	slog.Info("GitWatcher stopped")
}

// Subscribe registers a subscriber under the client-chosen id.
func (w *GitWatcher) Subscribe(id string, notifier Notifier) error {
	return w.AddSubscription(&Subscription{
		ID:       id,
		Notifier: notifier,
	})
}

func (w *GitWatcher) pollLoop() {
	ticker := time.NewTicker(gitPollInterval)
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

func (w *GitWatcher) checkAndNotify() {
	newState, ok := w.pollGitState()
	// A cancelled or timed-out context aborts the git commands, so the poll
	// reports an empty tree rather than the truth: comparing it would announce
	// a change nobody made — twice, once more when the next poll answers.
	if !ok || w.Context().Err() != nil {
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

// pollGitState returns git status + HEAD hash for detecting changes.
// This detects both working tree changes and HEAD changes (commit, checkout, etc).
// ok is false when the poll ran out of time and so has no answer: a status now
// counts lines too (git.StatusContext), and in a large tree that can.
func (w *GitWatcher) pollGitState() (state string, ok bool) {
	// Bound by the watcher's context, not just the timeout: Stop waits for this
	// loop, and a git command left running against a work tree that is being
	// removed has nothing left to report anyway.
	ctx, cancel := context.WithTimeout(w.Context(), 10*time.Second)
	defer cancel()

	// Run both commands in parallel to reduce latency
	var head, status string
	var wg sync.WaitGroup
	wg.Add(2)

	go func() {
		defer wg.Done()
		head = w.runGitCmd(ctx, "rev-parse", "HEAD")
	}()

	// The whole of what git.status answers, not just `git status --porcelain`:
	// a file edited again stays " M" while its line counts move, and the
	// client would keep showing the old ones until something else changed.
	go func() {
		defer wg.Done()
		result, err := git.StatusContext(ctx, w.workDir)
		if err != nil {
			return
		}
		encoded, err := json.Marshal(result)
		if err != nil {
			return
		}
		status = string(encoded)
	}()

	wg.Wait()

	if ctx.Err() != nil {
		return "", false
	}
	return head + "\n" + status, true
}

func (w *GitWatcher) runGitCmd(ctx context.Context, args ...string) string {
	cmdArgs := append([]string{"--no-optional-locks"}, args...)
	cmd := exec.CommandContext(ctx, "git", cmdArgs...)
	cmd.Dir = w.workDir

	output, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(output))
}

func (w *GitWatcher) notifySubscribers() {
	count := w.NotifyAll("git.changed", func(sub *Subscription) any {
		return map[string]any{
			"id": sub.ID,
		}
	})
	slog.Debug("notified git status change", "subscribers", count)
}
