package watch

import (
	"context"
	"log/slog"
	"os"
	"path"
	"path/filepath"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
)

// A batch of changes reaches each subscription as one fs.changed once no change
// has reached it for debounceInterval. Every notification costs the
// client a re-read of the path (a directory listing, carried back through the
// relay when remote), so coalescing is per subscription rather than per changed
// path: writing 200 files into an open directory is one re-read, not 200.
const debounceInterval = 100 * time.Millisecond

// debounceMaxWait caps how long a burst can hold a notification back, so a
// file written continuously (a log, a build output) still shows up. 500ms is
// short enough that a change being watched reads as live, and bounds a
// subscription under constant writes to two re-reads a second.
const debounceMaxWait = 500 * time.Millisecond

// FSWatcher watches filesystem changes via fsnotify and notifies subscribers.
type FSWatcher struct {
	*BaseWatcher
	workDir string
	watcher *fsnotify.Watcher

	pathMu       sync.RWMutex
	pathToIDs    map[string][]string // path -> subscription IDs
	idToPath     map[string]string   // subscription ID -> path
	pathRefCount map[string]int

	// debouncer is keyed by subscription ID.
	debouncer *keyDebouncer
}

func NewFSWatcher(workDir string) *FSWatcher {
	w := &FSWatcher{
		BaseWatcher:  NewBaseWatcher(),
		workDir:      workDir,
		pathToIDs:    make(map[string][]string),
		idToPath:     make(map[string]string),
		pathRefCount: make(map[string]int),
	}
	w.debouncer = newKeyDebouncer(debounceInterval, debounceMaxWait, w.notifySubscription)
	return w
}

func (w *FSWatcher) Start() error {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return err
	}
	w.watcher = watcher

	w.Go(w.eventLoop)
	slog.Info("FSWatcher started", "workDir", w.workDir)
	return nil
}

func (w *FSWatcher) Stop() {
	w.CancelAndWait()
	if w.watcher != nil {
		w.watcher.Close()
	}

	w.debouncer.stop()

	slog.Info("FSWatcher stopped")
}

// Subscribe registers a subscriber for one path under the client-chosen id.
func (w *FSWatcher) Subscribe(id, subPath string, notifier Notifier) error {
	// Registered first, so that an id the client cannot use is refused before any
	// of the path bookkeeping below is touched — it belongs to whoever holds that
	// id already. An event landing before that bookkeeping is in place reaches no
	// subscriber, as it did under either order: notifying needs both halves. It
	// costs nothing here, because fs.changed carries no data — it only says "read
	// this path again" — and the client reads the path once the subscription is
	// established anyway (useFSWatch's onSubscribed).
	if err := w.AddSubscription(&Subscription{ID: id, Notifier: notifier}); err != nil {
		return err
	}

	fullPath := filepath.Join(w.workDir, subPath)
	if _, err := os.Stat(fullPath); err != nil {
		w.RemoveSubscription(id)
		return err
	}

	key := subscriptionKey(subPath)

	w.pathMu.Lock()

	// Start fsnotify watch if first subscriber for this path
	if w.pathRefCount[key] == 0 {
		if err := w.watcher.Add(fullPath); err != nil {
			w.pathMu.Unlock()
			w.RemoveSubscription(id)
			return err
		}
		slog.Debug("started watching path", "path", key)
	}

	w.pathToIDs[key] = append(w.pathToIDs[key], id)
	w.idToPath[id] = key
	w.pathRefCount[key]++
	w.pathMu.Unlock()

	return nil
}

// Unsubscribe overrides BaseWatcher.Unsubscribe to also clean up fsnotify watches.
func (w *FSWatcher) Unsubscribe(id string) {
	w.pathMu.Lock()
	key, ok := w.idToPath[id]
	if ok {
		w.removePathMapping(id, key)
	}
	w.pathMu.Unlock()

	w.debouncer.cancel(id)
	w.RemoveSubscription(id)
}

// removePathMapping removes path tracking. Caller must hold pathMu.
func (w *FSWatcher) removePathMapping(id, key string) {
	delete(w.idToPath, id)

	ids := w.pathToIDs[key]
	for i, v := range ids {
		if v == id {
			w.pathToIDs[key] = append(ids[:i], ids[i+1:]...)
			break
		}
	}
	if len(w.pathToIDs[key]) == 0 {
		delete(w.pathToIDs, key)
	}

	w.pathRefCount[key]--
	if w.pathRefCount[key] == 0 {
		fullPath := filepath.Join(w.workDir, key)
		w.watcher.Remove(fullPath)
		delete(w.pathRefCount, key)
		slog.Debug("stopped watching path", "path", key)
	}
}

// subscriptionKey normalises a workDir-relative path to the form used as a key
// in the subscription maps.
//
// Subscribers name paths the way the rest of the API does — with `/`, which is
// also what contents.GetContents hands out — while filesystem events arrive as
// native paths. On Windows the two spellings of `src/main.go` are different map
// keys, so without normalising, every subscription to anything below the work
// directory root goes unnotified and the client silently shows stale content.
func subscriptionKey(relPath string) string {
	return filepath.ToSlash(relPath)
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
	native, err := filepath.Rel(w.workDir, event.Name)
	if err != nil {
		slog.Error("failed to get relative path", "path", event.Name, "error", err)
		return
	}
	changedPath := subscriptionKey(native)

	// Subscribers of the changed path and of its parent directory.
	w.pathMu.RLock()
	ids := append([]string{}, w.pathToIDs[changedPath]...)
	if changedPath != "" {
		// path.Dir, not filepath.Dir: subscription keys are slash-separated on
		// every platform, so the parent has to be derived the same way.
		parent := path.Dir(changedPath)
		if parent == "." {
			parent = ""
		}
		ids = append(ids, w.pathToIDs[parent]...)
	}
	w.pathMu.RUnlock()

	for _, id := range ids {
		w.debouncer.touch(id)
	}
}

// notifySubscription sends fs.changed to one subscription. The notification
// names only the subscription — it means "read your path again" — so a merged
// batch loses nothing by not saying which entries changed.
func (w *FSWatcher) notifySubscription(id string) {
	// Skip if watcher is stopped (a timer may fire after Stop)
	if w.Context().Err() != nil {
		return
	}
	// Gone if it was unsubscribed after the change was seen.
	sub := w.GetSubscription(id)
	if sub == nil {
		return
	}
	n := Notification{
		Method: "fs.changed",
		Params: map[string]any{"id": sub.ID},
	}
	if err := sub.Notifier.Notify(context.Background(), n); err != nil {
		slog.Debug("failed to notify subscriber", "watchId", sub.ID, "error", err)
	}
}
