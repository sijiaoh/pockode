package watch

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path"
	"path/filepath"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/pockode/server/contents"
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
	// polled holds the directories watched by their modification time, by
	// subscription key. Guarded by pathMu.
	polled map[string]*polledDir

	timerMu  sync.Mutex
	timerMap map[string]*time.Timer
}

func NewFSWatcher(workDir string) *FSWatcher {
	return &FSWatcher{
		BaseWatcher:  NewBaseWatcher(),
		workDir:      workDir,
		pathToIDs:    make(map[string][]string),
		idToPath:     make(map[string]string),
		pathRefCount: make(map[string]int),
		polled:       make(map[string]*polledDir),
		timerMap:     make(map[string]*time.Timer),
	}
}

func (w *FSWatcher) Start() error {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return err
	}
	w.watcher = watcher

	w.Go(w.eventLoop)
	w.Go(w.pollLoop)
	slog.Info("FSWatcher started", "workDir", w.workDir)
	return nil
}

func (w *FSWatcher) Stop() {
	w.CancelAndWait()
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

	// Followed only inside the work directory, like file.get: otherwise a
	// client could learn when files outside change. The error names no host
	// path, since it goes back to the client as is.
	res, err := contents.Resolve(w.workDir, subPath)
	if err == nil && res.Link != nil && !res.Link.Followable() {
		err = contents.LinkRefusal(subPath, res.Link.State)
	}
	if err != nil {
		w.RemoveSubscription(id)
		slog.Debug("refused to watch path", "path", subPath, "error", err)
		return errors.New(contents.PublicMessage(err))
	}
	fullPath := filepath.Join(w.workDir, subPath)

	key := subscriptionKey(subPath)

	w.pathMu.Lock()

	// Start fsnotify watch if first subscriber for this path
	if w.pathRefCount[key] == 0 {
		poll := pollDirs && res.Info.IsDir()
		if err := w.watcher.Add(fullPath); err != nil {
			// A directory is still watched, by polling, when fsnotify cannot
			// take it: on kqueue, which opens every entry, one link in it that
			// loops fails the whole Add, and a directory must not stop being
			// watched over what one entry points at (docs/symlinks.md).
			if !res.Info.IsDir() {
				w.pathMu.Unlock()
				w.RemoveSubscription(id)
				slog.Warn("failed to watch path", "path", key, "error", err)
				return fmt.Errorf("cannot watch %s for changes", contents.DisplayDir(key))
			}
			_ = w.watcher.Remove(fullPath) // what a failed Add left behind
			slog.Warn("watching directory by polling instead", "path", key, "error", err)
			poll = true
		}
		if poll {
			dir := &polledDir{real: res.Real}
			dir.modTime = w.modTime(dir.real)
			w.polled[key] = dir
		}
		slog.Debug("started watching path", "path", key, "polled", poll)
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
		delete(w.polled, key)
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

// pollInterval is how often a polled directory is looked at: about what a
// person notices as "the tree did not update", at the cost of one stat per
// polled directory.
const pollInterval = time.Second

// pollLoop notifies the subscribers of a polled directory when its
// modification time changes, which creating, removing or renaming an entry
// does on every platform.
func (w *FSWatcher) pollLoop() {
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-w.Context().Done():
			return
		case <-ticker.C:
		}

		w.pathMu.RLock()
		dirs := make(map[string]string, len(w.polled))
		for key, dir := range w.polled {
			dirs[key] = dir.real
		}
		w.pathMu.RUnlock()

		for key, real := range dirs {
			current := w.modTime(real)
			w.pathMu.Lock()
			dir, ok := w.polled[key]
			changed := ok && !dir.modTime.Equal(current)
			if changed {
				dir.modTime = current
			}
			w.pathMu.Unlock()
			if changed {
				w.notifyPath(key)
			}
		}
	}
}

// polledDir is a directory watched by its modification time.
type polledDir struct {
	// real is where the subscribed path resolved inside the work directory
	// when it was subscribed (contents.Resolution.Real): it has no link in
	// it, so polling never follows one — a directory that later becomes a
	// link out is not looked through.
	real    string
	modTime time.Time
}

// modTime is the modification time of real, beneath the work directory. It is
// the zero time for a path that cannot be stat'ed, so that its disappearing,
// and coming back, both count as a change.
func (w *FSWatcher) modTime(real string) time.Time {
	// Lstat, since real holds no link — except the work directory itself,
	// which may be reached through one of the user's own.
	stat := os.Lstat
	if real == "." {
		stat = os.Stat
	}
	info, err := stat(filepath.Join(w.workDir, real))
	if err != nil {
		return time.Time{}
	}
	return info.ModTime()
}

func (w *FSWatcher) handleEvent(event fsnotify.Event) {
	native, err := filepath.Rel(w.workDir, event.Name)
	if err != nil {
		slog.Error("failed to get relative path", "path", event.Name, "error", err)
		return
	}
	relPath := subscriptionKey(native)

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

func (w *FSWatcher) notifyPath(changedPath string) {
	// Skip if watcher is stopped (timer may fire after Stop)
	if w.Context().Err() != nil {
		return
	}

	// Notify subscribers of the changed path and its parent directory.
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

	if len(ids) == 0 {
		return
	}

	var notified int
	for _, id := range ids {
		sub := w.GetSubscription(id)
		if sub == nil {
			continue
		}
		n := Notification{
			Method: "fs.changed",
			Params: map[string]any{"id": sub.ID},
		}
		if err := sub.Notifier.Notify(context.Background(), n); err != nil {
			slog.Debug("failed to notify subscriber", "watchId", sub.ID, "error", err)
		}
		notified++
	}

	slog.Debug("notified path change", "path", changedPath, "subscribers", notified)
}
