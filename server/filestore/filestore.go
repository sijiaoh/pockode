// Package filestore provides infrastructure for JSON-file-backed stores:
// atomic file I/O (flock + write-temp-fsync-rename), fsnotify-based external
// change detection with debounce, and writeGen-based stale reload prevention.
package filestore

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/fsnotify/fsnotify"
)

const reloadDebounce = 100 * time.Millisecond

// File manages atomic I/O and fsnotify watching for a single JSON index file.
// Domain stores compose this type and delegate file operations to it.
type File struct {
	path  string
	label string

	// writeGen is incremented on every successful Write call.
	// SnapshotGen/IsStale use it to skip stale fsnotify-triggered reloads.
	writeGen atomic.Int64

	watcher    *fsnotify.Watcher
	debounce   *time.Timer
	debounceMu sync.Mutex

	// onReload is called after debounce when the index file changes on disk.
	onReload func()
}

// Config holds the parameters for creating a File.
type Config struct {
	// Path is the absolute path to the JSON index file.
	Path string
	// Label is a human-readable name for log messages (e.g. "work", "agent-role").
	Label string
	// OnReload is called when a file change is detected after debounce.
	// The callee is responsible for reading from disk, checking
	// ReloadGuard, updating in-memory state, and notifying listeners.
	OnReload func()
}

// New creates a File, ensuring the parent directory exists.
func New(cfg Config) (*File, error) {
	dir := filepath.Dir(cfg.Path)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, err
	}

	return &File{
		path:     cfg.Path,
		label:    cfg.Label,
		onReload: cfg.OnReload,
	}, nil
}

// --- File I/O ---

func (f *File) lockPath() string {
	return f.path + ".lock"
}

// Read reads the index file under a shared flock and returns the raw bytes.
// Returns nil, nil if the file does not exist.
func (f *File) Read() ([]byte, error) {
	lockF, err := os.OpenFile(f.lockPath(), os.O_CREATE|os.O_RDWR, 0644)
	if err != nil {
		return nil, fmt.Errorf("open lock file: %w", err)
	}
	defer lockF.Close()

	if err := syscall.Flock(int(lockF.Fd()), syscall.LOCK_SH); err != nil {
		return nil, fmt.Errorf("flock shared: %w", err)
	}
	defer syscall.Flock(int(lockF.Fd()), syscall.LOCK_UN)

	data, err := os.ReadFile(f.path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	return data, err
}

// Write atomically writes data using write-temp-fsync-rename under an
// exclusive flock. Increments writeGen on success.
func (f *File) Write(data []byte) error {
	lockF, err := os.OpenFile(f.lockPath(), os.O_CREATE|os.O_RDWR, 0644)
	if err != nil {
		return fmt.Errorf("open lock file: %w", err)
	}
	defer lockF.Close()

	if err := syscall.Flock(int(lockF.Fd()), syscall.LOCK_EX); err != nil {
		return fmt.Errorf("flock exclusive: %w", err)
	}
	defer syscall.Flock(int(lockF.Fd()), syscall.LOCK_UN)

	tmpPath := f.path + ".tmp"

	tmpF, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644)
	if err != nil {
		return fmt.Errorf("create temp file: %w", err)
	}

	if _, err := tmpF.Write(data); err != nil {
		tmpF.Close()
		os.Remove(tmpPath)
		return fmt.Errorf("write temp file: %w", err)
	}
	if err := tmpF.Sync(); err != nil {
		tmpF.Close()
		os.Remove(tmpPath)
		return fmt.Errorf("fsync temp file: %w", err)
	}
	if err := tmpF.Close(); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("close temp file: %w", err)
	}

	if err := os.Rename(tmpPath, f.path); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("rename temp to index: %w", err)
	}

	f.writeGen.Add(1)
	return nil
}

// SnapshotGen returns the current write generation. Call this before
// ReadFromDisk in a reload handler, then pass the returned value to
// IsStale after acquiring the domain lock.
func (f *File) SnapshotGen() int64 {
	return f.writeGen.Load()
}

// IsStale returns true if the write generation has changed since genBefore,
// meaning an in-process write occurred during the reload and the disk data
// may be stale. Call this under the domain's write lock.
func (f *File) IsStale(genBefore int64) bool {
	return f.writeGen.Load() != genBefore
}

// --- fsnotify ---

// StartWatching begins monitoring the index file's parent directory for
// Write/Create events matching the index file name.
func (f *File) StartWatching() error {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return err
	}
	f.watcher = watcher

	dir := filepath.Dir(f.path)
	if err := watcher.Add(dir); err != nil {
		watcher.Close()
		return err
	}

	go f.watchLoop()
	slog.Info("store watching for external changes", "label", f.label, "path", f.path)
	return nil
}

// StopWatching stops the fsnotify watcher and cancels any pending debounce.
func (f *File) StopWatching() {
	f.debounceMu.Lock()
	if f.debounce != nil {
		f.debounce.Stop()
	}
	f.debounceMu.Unlock()

	if f.watcher != nil {
		f.watcher.Close()
	}
}

func (f *File) watchLoop() {
	target := filepath.Base(f.path)
	for {
		select {
		case event, ok := <-f.watcher.Events:
			if !ok {
				return
			}
			if filepath.Base(event.Name) != target {
				continue
			}
			if event.Op&(fsnotify.Write|fsnotify.Create) == 0 {
				continue
			}
			f.scheduleReload()
		case err, ok := <-f.watcher.Errors:
			if !ok {
				return
			}
			slog.Error("store fsnotify error", "label", f.label, "error", err)
		}
	}
}

func (f *File) scheduleReload() {
	f.debounceMu.Lock()
	defer f.debounceMu.Unlock()

	if f.debounce != nil {
		f.debounce.Stop()
	}
	f.debounce = time.AfterFunc(reloadDebounce, f.onReload)
}

// --- Diff helper ---

// Operation represents a CRUD operation type, reusable across domains.
type Operation string

const (
	OperationCreate Operation = "create"
	OperationUpdate Operation = "update"
	OperationDelete Operation = "delete"
)

// Diff computes create/update/delete changes between old and updated slices.
// getID extracts each item's unique identifier. changed reports whether two
// items with the same ID differ in a meaningful way. makeEvent constructs
// a domain-specific event from an operation and item.
func Diff[T any, E any](
	old, updated []T,
	getID func(T) string,
	changed func(a, b T) bool,
	makeEvent func(op Operation, item T) E,
) []E {
	var events []E

	oldMap := make(map[string]T, len(old))
	for _, item := range old {
		oldMap[getID(item)] = item
	}

	newMap := make(map[string]T, len(updated))
	for _, item := range updated {
		newMap[getID(item)] = item
	}

	for id, item := range oldMap {
		if _, exists := newMap[id]; !exists {
			events = append(events, makeEvent(OperationDelete, item))
		}
	}

	for id, item := range newMap {
		oldItem, exists := oldMap[id]
		if !exists {
			events = append(events, makeEvent(OperationCreate, item))
		} else if changed(oldItem, item) {
			events = append(events, makeEvent(OperationUpdate, item))
		}
	}

	return events
}

// MarshalIndex marshals a value as indented JSON, suitable for index files.
func MarshalIndex(v any) ([]byte, error) {
	return json.MarshalIndent(v, "", "  ")
}
