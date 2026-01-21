package watch

import (
	"context"
	"log/slog"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/sourcegraph/jsonrpc2"
)

const gitPollInterval = 3 * time.Second

// GitWatcher polls git status/diff and notifies subscribers when changes are detected.
type GitWatcher struct {
	*BaseWatcher

	workDir string

	stateMu   sync.Mutex
	lastState string // Combined status + diff signatures
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

func (w *GitWatcher) Subscribe(conn *jsonrpc2.Conn, connID string) (string, error) {
	id := w.GenerateID()

	sub := &Subscription{
		ID:     id,
		Path:   "*", // GitWatcher watches all git changes
		ConnID: connID,
		Conn:   conn,
	}
	w.AddSubscription(sub)
	return id, nil
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

// pollGitState returns a combined signature of status + diff --stat.
// Detects: file changes, staging changes, and partial staging.
func (w *GitWatcher) pollGitState() string {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	var parts []string

	if out := w.runGitCmd(ctx, "status", "--porcelain=v1", "-uall", "--ignore-submodules=none"); out != "" {
		parts = append(parts, "S:"+sortLines(out))
	}
	if out := w.runGitCmd(ctx, "diff", "--stat", "--submodule=short"); out != "" {
		parts = append(parts, "U:"+out)
	}
	if out := w.runGitCmd(ctx, "diff", "--staged", "--stat", "--submodule=short"); out != "" {
		parts = append(parts, "T:"+out)
	}

	return strings.Join(parts, "\n---\n")
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
