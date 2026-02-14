package watch

import (
	"context"
	"log/slog"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"time"
)

const gitPollInterval = 3 * time.Second

// GitWatcher polls git state (HEAD + status) and notifies subscribers on changes.
// Detects working tree changes and HEAD changes (commit, checkout, etc).
// For file-specific diff content changes, use GitDiffWatcher instead.
type GitWatcher struct {
	*BaseWatcher

	workDir string

	stateMu   sync.Mutex
	lastState string // HEAD hash + git status output
}

func NewGitWatcher(workDir string) *GitWatcher {
	return &GitWatcher{
		BaseWatcher: NewBaseWatcher("g"),
		workDir:     workDir,
	}
}

func (w *GitWatcher) Start() error {
	state := w.pollGitState()
	w.stateMu.Lock()
	w.lastState = state
	w.stateMu.Unlock()

	go w.pollLoop()
	slog.Info("GitWatcher started", "workDir", w.workDir, "pollInterval", gitPollInterval)
	return nil
}

func (w *GitWatcher) Stop() {
	w.Cancel()
	slog.Info("GitWatcher stopped")
}

func (w *GitWatcher) Subscribe(notifier Notifier) string {
	id := w.GenerateID()

	sub := &Subscription{
		ID:       id,
		Notifier: notifier,
	}
	w.AddSubscription(sub)
	return id
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
	newState := w.pollGitState()

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
func (w *GitWatcher) pollGitState() string {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// Run both commands in parallel to reduce latency
	var head, status string
	var wg sync.WaitGroup
	wg.Add(2)

	go func() {
		defer wg.Done()
		head = w.runGitCmd(ctx, "rev-parse", "HEAD")
	}()

	go func() {
		defer wg.Done()
		status = w.runGitCmd(ctx, "status", "--porcelain=v1", "-uall", "--ignore-submodules=none")
	}()

	wg.Wait()

	return head + "\n" + sortLines(status)
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

func sortLines(text string) string {
	if text == "" {
		return ""
	}
	lines := strings.Split(text, "\n")
	sort.Strings(lines)
	return strings.Join(lines, "\n")
}

func (w *GitWatcher) notifySubscribers() {
	count := w.NotifyAll("git.changed", func(sub *Subscription) any {
		return map[string]any{
			"id": sub.ID,
		}
	})
	slog.Debug("notified git status change", "subscribers", count)
}
