package watch

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/sourcegraph/jsonrpc2"
)

const debounceInterval = 100 * time.Millisecond

// FSWatcher watches filesystem changes via fsnotify and notifies subscribers.
type FSWatcher struct {
	*BaseWatcher
	workDir string
	watcher *fsnotify.Watcher

	pathMu       sync.RWMutex
	pathToIDs    map[string][]string // path -> subscription IDs
	idToPath     map[string]string   // subscription ID -> path
	pathRefCount map[string]int

	timerMu  sync.Mutex
	timerMap map[string]*time.Timer
}

func NewFSWatcher(workDir string) *FSWatcher {
	return &FSWatcher{
		BaseWatcher:  NewBaseWatcher("f"),
		workDir:      workDir,
		pathToIDs:    make(map[string][]string),
		idToPath:     make(map[string]string),
		pathRefCount: make(map[string]int),
		timerMap:     make(map[string]*time.Timer),
	}
}

func (w *FSWatcher) Start() error {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return err
	}
	w.watcher = watcher

	go w.eventLoop()
	slog.Info("FSWatcher started", "workDir", w.workDir)
	return nil
}

func (w *FSWatcher) Stop() {
	w.Cancel()
	if w.watcher != nil {
		w.watcher.Close()
	}

	// Cancel any pending debounce timers
	w.timerMu.Lock()
	for _, timer := range w.timerMap {
		timer.Stop()
	}
	w.timerMap = make(map[string]*time.Timer)
	w.timerMu.Unlock()

	slog.Info("FSWatcher stopped")
}

func (w *FSWatcher) Subscribe(path string, conn *jsonrpc2.Conn, connID string) (string, error) {
	id := w.GenerateID()

	fullPath := filepath.Join(w.workDir, path)
	if _, err := os.Stat(fullPath); err != nil {
		return "", err
	}

	sub := &Subscription{ID: id, ConnID: connID, Conn: conn}

	// Lock order: pathMu → subMu (consistent with Unsubscribe/CleanupConnection)
	w.pathMu.Lock()

	// Start fsnotify watch if first subscriber for this path
	if w.pathRefCount[path] == 0 {
		if err := w.watcher.Add(fullPath); err != nil {
			w.pathMu.Unlock()
			return "", err
		}
		slog.Debug("started watching path", "path", path)
	}

	w.pathToIDs[path] = append(w.pathToIDs[path], id)
	w.idToPath[id] = path
	w.pathRefCount[path]++
	w.pathMu.Unlock()

	// Add to BaseWatcher after path mapping is set up
	w.AddSubscription(sub)

	return id, nil
}

// Unsubscribe overrides BaseWatcher.Unsubscribe to also clean up fsnotify watches.
func (w *FSWatcher) Unsubscribe(id string) {
	w.pathMu.Lock()
	path, ok := w.idToPath[id]
	if ok {
		w.removePathMapping(id, path)
	}
	w.pathMu.Unlock()

	w.RemoveSubscription(id)
}

func (w *FSWatcher) CleanupConnection(connID string) {
	// Get subscription IDs first (releases subMu before acquiring pathMu)
	subs := w.GetSubscriptionsByConnID(connID)
	if len(subs) == 0 {
		return
	}

	// Collect IDs to avoid holding lock during iteration
	ids := make([]string, len(subs))
	for i, sub := range subs {
		ids[i] = sub.ID
	}

	// Lock order: pathMu → subMu (consistent with Subscribe/Unsubscribe)
	w.pathMu.Lock()
	for _, id := range ids {
		if path, ok := w.idToPath[id]; ok {
			w.removePathMapping(id, path)
		}
	}
	w.pathMu.Unlock()

	w.BaseWatcher.CleanupConnection(connID)
}

// removePathMapping removes path tracking. Caller must hold pathMu.
func (w *FSWatcher) removePathMapping(id, path string) {
	delete(w.idToPath, id)

	ids := w.pathToIDs[path]
	for i, v := range ids {
		if v == id {
			w.pathToIDs[path] = append(ids[:i], ids[i+1:]...)
			break
		}
	}
	if len(w.pathToIDs[path]) == 0 {
		delete(w.pathToIDs, path)
	}

	w.pathRefCount[path]--
	if w.pathRefCount[path] == 0 {
		fullPath := filepath.Join(w.workDir, path)
		w.watcher.Remove(fullPath)
		delete(w.pathRefCount, path)
		slog.Debug("stopped watching path", "path", path)
	}
}

func (w *FSWatcher) eventLoop() {
	for {
		select {
		case <-w.Context().Done():
			return
		case event, ok := <-w.watcher.Events:
			if !ok {
				return
			}
			w.handleEvent(event)
		case err, ok := <-w.watcher.Errors:
			if !ok {
				return
			}
			slog.Error("fsnotify error", "error", err)
		}
	}
}

func (w *FSWatcher) handleEvent(event fsnotify.Event) {
	relPath, err := filepath.Rel(w.workDir, event.Name)
	if err != nil {
		slog.Error("failed to get relative path", "path", event.Name, "error", err)
		return
	}

	w.timerMu.Lock()
	if timer, exists := w.timerMap[relPath]; exists {
		timer.Stop()
	}
	w.timerMap[relPath] = time.AfterFunc(debounceInterval, func() {
		w.notifyPath(relPath)
		w.timerMu.Lock()
		delete(w.timerMap, relPath)
		w.timerMu.Unlock()
	})
	w.timerMu.Unlock()
}

func (w *FSWatcher) notifyPath(path string) {
	// Skip if watcher is stopped (timer may fire after Stop)
	if w.Context().Err() != nil {
		return
	}

	w.pathMu.RLock()
	ids := make([]string, len(w.pathToIDs[path]))
	copy(ids, w.pathToIDs[path])
	w.pathMu.RUnlock()

	if len(ids) == 0 {
		return
	}

	var notified int
	for _, id := range ids {
		sub := w.GetSubscription(id)
		if sub == nil {
			continue
		}
		err := sub.Conn.Notify(context.Background(), "fs.changed", map[string]any{
			"id": sub.ID,
		})
		if err != nil {
			slog.Debug("failed to notify subscriber", "watchId", sub.ID, "error", err)
		}
		notified++
	}

	slog.Debug("notified path change", "path", path, "subscribers", notified)
}
