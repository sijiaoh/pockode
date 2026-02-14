package watch

import (
	"context"
	"crypto/md5"
	"encoding/hex"
	"log/slog"
	"sync"
	"time"

	"github.com/pockode/server/git"
)

const gitDiffPollInterval = 3 * time.Second

// gitDiffSubscription holds additional data for a diff subscription.
type gitDiffSubscription struct {
	path     string
	staged   bool
	lastHash string
}

// GitDiffWatcher polls git diff for specific files and notifies subscribers when changes occur.
type GitDiffWatcher struct {
	*BaseWatcher
	workDir string

	dataMu  sync.RWMutex
	subData map[string]*gitDiffSubscription // subscription ID -> extra data
}

func NewGitDiffWatcher(workDir string) *GitDiffWatcher {
	return &GitDiffWatcher{
		BaseWatcher: NewBaseWatcher("d"),
		workDir:     workDir,
		subData:     make(map[string]*gitDiffSubscription),
	}
}

func (w *GitDiffWatcher) Start() error {
	go w.pollLoop()
	slog.Info("GitDiffWatcher started", "workDir", w.workDir, "pollInterval", gitDiffPollInterval)
	return nil
}

func (w *GitDiffWatcher) Stop() {
	w.Cancel()
	slog.Info("GitDiffWatcher stopped")
}

// Subscribe starts watching diff changes for a specific file.
// Returns subscription ID and initial diff content.
func (w *GitDiffWatcher) Subscribe(path string, staged bool, notifier Notifier) (string, *git.DiffResult, error) {
	result, err := git.DiffWithContent(w.workDir, path, staged)
	if err != nil {
		return "", nil, err
	}

	id := w.GenerateID()
	hash := w.hashDiff(result)

	sub := &Subscription{
		ID:       id,
		Notifier: notifier,
	}

	w.dataMu.Lock()
	w.subData[id] = &gitDiffSubscription{
		path:     path,
		staged:   staged,
		lastHash: hash,
	}
	w.dataMu.Unlock()

	w.AddSubscription(sub)
	return id, result, nil
}

func (w *GitDiffWatcher) Unsubscribe(id string) {
	w.dataMu.Lock()
	delete(w.subData, id)
	w.dataMu.Unlock()

	w.RemoveSubscription(id)
}

func (w *GitDiffWatcher) pollLoop() {
	ticker := time.NewTicker(gitDiffPollInterval)
	defer ticker.Stop()

	for {
		select {
		case <-w.Context().Done():
			return
		case <-ticker.C:
			if !w.HasSubscriptions() {
				continue
			}
			w.checkAll()
		}
	}
}

func (w *GitDiffWatcher) checkAll() {
	subs := w.GetAllSubscriptions()

	for _, sub := range subs {
		w.checkOne(sub)
	}
}

func (w *GitDiffWatcher) checkOne(sub *Subscription) {
	w.dataMu.RLock()
	data := w.subData[sub.ID]
	if data == nil {
		w.dataMu.RUnlock()
		return
	}
	// Copy values needed for diff check
	path := data.path
	staged := data.staged
	lastHash := data.lastHash
	w.dataMu.RUnlock()

	result, err := git.DiffWithContent(w.workDir, path, staged)
	if err != nil {
		slog.Debug("git diff failed", "path", path, "staged", staged, "error", err)
		return
	}

	hash := w.hashDiff(result)
	if hash == lastHash {
		return
	}

	// Update hash and notify (re-check data still exists)
	w.dataMu.Lock()
	data = w.subData[sub.ID]
	if data == nil {
		w.dataMu.Unlock()
		return
	}
	data.lastHash = hash
	w.dataMu.Unlock()

	n := Notification{
		Method: "git.diff.changed",
		Params: map[string]any{
			"id":          sub.ID,
			"diff":        result.Diff,
			"old_content": result.OldContent,
			"new_content": result.NewContent,
		},
	}
	if err := sub.Notifier.Notify(context.Background(), n); err != nil {
		slog.Debug("failed to notify git diff change", "id", sub.ID, "error", err)
	}
}

func (w *GitDiffWatcher) hashDiff(result *git.DiffResult) string {
	h := md5.New()
	h.Write([]byte(result.Diff))
	h.Write([]byte{0})
	h.Write([]byte(result.OldContent))
	h.Write([]byte{0})
	h.Write([]byte(result.NewContent))
	return hex.EncodeToString(h.Sum(nil))
}
