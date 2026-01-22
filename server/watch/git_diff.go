package watch

import (
	"context"
	"crypto/md5"
	"encoding/hex"
	"log/slog"
	"sync"
	"time"

	"github.com/pockode/server/git"
	"github.com/sourcegraph/jsonrpc2"
)

const gitDiffPollInterval = 3 * time.Second

// gitDiffSubscription holds additional data for a diff subscription.
type gitDiffSubscription struct {
	staged   bool
	lastHash string
}

// GitDiffWatcher polls git diff for specific files and notifies subscribers when changes occur.
type GitDiffWatcher struct {
	*BaseWatcher
	workDir string

	subMu   sync.RWMutex
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
func (w *GitDiffWatcher) Subscribe(path string, staged bool, conn *jsonrpc2.Conn, connID string) (string, *git.DiffResult, error) {
	result, err := git.DiffWithContent(w.workDir, path, staged)
	if err != nil {
		return "", nil, err
	}

	id := w.GenerateID()
	hash := w.hashDiff(result)

	sub := &Subscription{
		ID:     id,
		Path:   path,
		ConnID: connID,
		Conn:   conn,
	}

	w.subMu.Lock()
	w.subData[id] = &gitDiffSubscription{
		staged:   staged,
		lastHash: hash,
	}
	w.subMu.Unlock()

	w.AddSubscription(sub)
	return id, result, nil
}

func (w *GitDiffWatcher) Unsubscribe(id string) {
	w.subMu.Lock()
	delete(w.subData, id)
	w.subMu.Unlock()

	w.RemoveSubscription(id)
}

func (w *GitDiffWatcher) CleanupConnection(connID string) {
	subs := w.GetSubscriptionsByConnID(connID)

	w.subMu.Lock()
	for _, sub := range subs {
		delete(w.subData, sub.ID)
	}
	w.subMu.Unlock()

	w.BaseWatcher.CleanupConnection(connID)
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
		w.subMu.RLock()
		data := w.subData[sub.ID]
		var staged bool
		var lastHash string
		if data != nil {
			staged = data.staged
			lastHash = data.lastHash
		}
		w.subMu.RUnlock()

		if data == nil {
			continue
		}

		w.checkAndNotify(sub, staged, lastHash)
	}
}

func (w *GitDiffWatcher) checkAndNotify(sub *Subscription, staged bool, lastHash string) {
	result, err := git.DiffWithContent(w.workDir, sub.Path, staged)
	if err != nil {
		slog.Debug("git diff failed", "path", sub.Path, "staged", staged, "error", err)
		return
	}

	hash := w.hashDiff(result)
	if hash == lastHash {
		return
	}

	w.subMu.Lock()
	data := w.subData[sub.ID]
	if data != nil {
		data.lastHash = hash
	}
	w.subMu.Unlock()

	params := map[string]any{
		"id":          sub.ID,
		"diff":        result.Diff,
		"old_content": result.OldContent,
		"new_content": result.NewContent,
	}
	if err := sub.Conn.Notify(context.Background(), "git.diff.changed", params); err != nil {
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
