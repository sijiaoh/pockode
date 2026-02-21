package work

import (
	"context"
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
	"github.com/google/uuid"
)

// Store provides CRUD operations and change notifications for Work items.
type Store interface {
	List() ([]Work, error)
	Get(id string) (Work, bool, error)

	Create(ctx context.Context, w Work) (Work, error)
	Update(ctx context.Context, id string, fields UpdateFields) error
	Delete(ctx context.Context, id string) error

	// MarkDone atomically transitions a work item to done, auto-advancing
	// from open → in_progress if needed. This avoids the TOCTOU race of a
	// separate Get → Update sequence.
	MarkDone(ctx context.Context, id string) error

	AddOnChangeListener(listener OnChangeListener)

	// StartWatching begins monitoring the index file for external changes (e.g. from MCP).
	StartWatching() error
	StopWatching()
}

// UpdateFields specifies which fields to update. Nil fields are left unchanged.
type UpdateFields struct {
	Title       *string     `json:"title,omitempty"`
	Body        *string     `json:"body,omitempty"`
	AgentRoleID *string     `json:"agent_role_id,omitempty"`
	Status      *WorkStatus `json:"status,omitempty"`
	SessionID   *string     `json:"session_id,omitempty"`
}

type indexData struct {
	Works []Work `json:"works"`
}

// FileStore persists Work items to a JSON file with flock-based inter-process safety.
type FileStore struct {
	dataDir   string
	worksMu   sync.RWMutex
	works     []Work
	listeners []OnChangeListener

	// writeGen is incremented on every in-process write (Create/Update/Delete/MarkDone).
	// reloadFromDisk uses it to skip stale fsnotify-triggered reloads.
	writeGen atomic.Int64

	// fsnotify for detecting external changes (MCP writes)
	watcher    *fsnotify.Watcher
	debounce   *time.Timer
	debounceMu sync.Mutex
}

func NewFileStore(dataDir string) (*FileStore, error) {
	worksDir := filepath.Join(dataDir, "works")
	if err := os.MkdirAll(worksDir, 0755); err != nil {
		return nil, err
	}

	store := &FileStore{dataDir: dataDir}

	idx, err := store.readIndexFromDisk()
	if err != nil {
		return nil, err
	}
	store.works = idx.Works

	return store, nil
}

func (s *FileStore) indexPath() string {
	return filepath.Join(s.dataDir, "works", "index.json")
}

// --- Read operations ---

func (s *FileStore) List() ([]Work, error) {
	s.worksMu.RLock()
	defer s.worksMu.RUnlock()

	result := make([]Work, len(s.works))
	copy(result, s.works)
	return result, nil
}

func (s *FileStore) Get(id string) (Work, bool, error) {
	s.worksMu.RLock()
	defer s.worksMu.RUnlock()

	for _, w := range s.works {
		if w.ID == id {
			return w, true, nil
		}
	}
	return Work{}, false, nil
}

// --- Write operations ---

func (s *FileStore) Create(_ context.Context, w Work) (Work, error) {
	if !ValidateType(w.Type) {
		return Work{}, fmt.Errorf("%w: invalid type %q", ErrInvalidWork, w.Type)
	}
	if w.Title == "" {
		return Work{}, fmt.Errorf("%w: title is required", ErrInvalidWork)
	}

	s.worksMu.Lock()

	var parent *Work
	if w.ParentID != "" {
		for i := range s.works {
			if s.works[i].ID == w.ParentID {
				parent = &s.works[i]
				break
			}
		}
		if parent == nil {
			s.worksMu.Unlock()
			return Work{}, fmt.Errorf("%w: parent %q not found", ErrInvalidWork, w.ParentID)
		}
	}
	if err := ValidateParent(w.Type, parent); err != nil {
		s.worksMu.Unlock()
		return Work{}, err
	}
	if parent != nil && parent.Status == StatusClosed {
		s.worksMu.Unlock()
		return Work{}, fmt.Errorf("%w: cannot add child to closed parent %s", ErrInvalidWork, parent.ID)
	}

	// Inherit agent_role_id from parent if not specified (task under story)
	agentRoleID := w.AgentRoleID
	if agentRoleID == "" && parent != nil {
		agentRoleID = parent.AgentRoleID
	}
	if agentRoleID == "" {
		s.worksMu.Unlock()
		return Work{}, fmt.Errorf("%w: agent_role_id is required", ErrInvalidWork)
	}

	now := time.Now()
	work := Work{
		ID:          uuid.Must(uuid.NewV7()).String(),
		Type:        w.Type,
		ParentID:    w.ParentID,
		AgentRoleID: agentRoleID,
		Title:       w.Title,
		Body:        w.Body,
		Status:      StatusOpen,
		CreatedAt:   now,
		UpdatedAt:   now,
	}

	s.works = append(s.works, work)

	if err := s.persistIndex(); err != nil {
		s.works = s.works[:len(s.works)-1]
		s.worksMu.Unlock()
		return Work{}, err
	}

	listeners := s.copyListeners()
	s.worksMu.Unlock()

	notify(listeners, ChangeEvent{Op: OperationCreate, Work: work})
	return work, nil
}

func (s *FileStore) Update(_ context.Context, id string, fields UpdateFields) error {
	s.worksMu.Lock()

	idx := s.findIndex(id)
	if idx < 0 {
		s.worksMu.Unlock()
		return ErrWorkNotFound
	}

	w := &s.works[idx]

	if fields.Status != nil {
		if !ValidateTransition(w.Status, *fields.Status) {
			s.worksMu.Unlock()
			return fmt.Errorf("%w: invalid transition %s → %s", ErrInvalidWork, w.Status, *fields.Status)
		}
	}

	// SessionID must only change alongside an appropriate status transition:
	//   set (non-empty) → must be transitioning to in_progress
	//   clear (empty)   → must be transitioning to open (rollback)
	if fields.SessionID != nil {
		if err := validateSessionIDChange(*fields.SessionID, fields.Status); err != nil {
			s.worksMu.Unlock()
			return err
		}
	}

	// Snapshot before mutations so we can roll back on persist failure
	prev := s.snapshotWorks()

	now := time.Now()
	if fields.Title != nil {
		w.Title = *fields.Title
	}
	if fields.Body != nil {
		w.Body = *fields.Body
	}
	if fields.AgentRoleID != nil {
		w.AgentRoleID = *fields.AgentRoleID
	}
	if fields.SessionID != nil {
		w.SessionID = *fields.SessionID
	}
	if fields.Status != nil {
		w.Status = *fields.Status
	}
	w.UpdatedAt = now

	modified := map[string]bool{id: true}
	if fields.Status != nil && *fields.Status == StatusDone {
		s.autoCloseRecursive(w, now, modified)
	}

	return s.persistAndNotifyUpdates(prev, modified)
}

func (s *FileStore) Delete(_ context.Context, id string) error {
	s.worksMu.Lock()

	idx := s.findIndex(id)
	if idx < 0 {
		s.worksMu.Unlock()
		return ErrWorkNotFound
	}

	for _, w := range s.works {
		if w.ParentID == id {
			s.worksMu.Unlock()
			return fmt.Errorf("%w: cannot delete work with children", ErrInvalidWork)
		}
	}

	deleted := s.works[idx]

	newWorks := make([]Work, 0, len(s.works)-1)
	newWorks = append(newWorks, s.works[:idx]...)
	newWorks = append(newWorks, s.works[idx+1:]...)
	prev := s.works
	s.works = newWorks

	if err := s.persistIndex(); err != nil {
		s.works = prev
		s.worksMu.Unlock()
		return err
	}

	listeners := s.copyListeners()
	s.worksMu.Unlock()

	notify(listeners, ChangeEvent{Op: OperationDelete, Work: deleted})
	return nil
}

func (s *FileStore) MarkDone(_ context.Context, id string) error {
	s.worksMu.Lock()

	idx := s.findIndex(id)
	if idx < 0 {
		s.worksMu.Unlock()
		return ErrWorkNotFound
	}

	w := &s.works[idx]

	// Snapshot before any mutations so we can roll back on persist failure
	prev := s.snapshotWorks()

	// Auto-advance open → in_progress so callers don't need a separate step
	if w.Status == StatusOpen {
		w.Status = StatusInProgress
	}
	if !ValidateTransition(w.Status, StatusDone) {
		s.works = prev
		s.worksMu.Unlock()
		return fmt.Errorf("%w: invalid transition %s → %s", ErrInvalidWork, w.Status, StatusDone)
	}

	now := time.Now()
	w.Status = StatusDone
	w.UpdatedAt = now

	modified := map[string]bool{id: true}
	s.autoCloseRecursive(w, now, modified)

	return s.persistAndNotifyUpdates(prev, modified)
}

// persistAndNotifyUpdates persists and fires update events for all modified
// work IDs. prev is the pre-mutation snapshot used for rollback on persist
// failure. Caller must hold s.worksMu write lock; it is released here.
func (s *FileStore) persistAndNotifyUpdates(prev []Work, modified map[string]bool) error {
	if err := s.persistIndex(); err != nil {
		s.works = prev
		s.worksMu.Unlock()
		return err
	}

	var events []ChangeEvent
	for _, w := range s.works {
		if modified[w.ID] {
			events = append(events, ChangeEvent{Op: OperationUpdate, Work: w})
		}
	}
	listeners := s.copyListeners()
	s.worksMu.Unlock()

	for _, e := range events {
		notify(listeners, e)
	}
	return nil
}

func (s *FileStore) snapshotWorks() []Work {
	out := make([]Work, len(s.works))
	copy(out, s.works)
	return out
}

// --- Auto-close logic ---

// maxAutoCloseDepth prevents runaway recursion in autoCloseRecursive.
// Current model only has story → task (depth 2), so 10 is very generous.
const maxAutoCloseDepth = 10

// autoCloseRecursive promotes done → closed when all children are complete,
// and cascades upward to the parent. Caller must hold s.worksMu write lock.
func (s *FileStore) autoCloseRecursive(w *Work, now time.Time, modified map[string]bool) {
	s.autoCloseRecursiveN(w, now, modified, 0)
}

func (s *FileStore) autoCloseRecursiveN(w *Work, now time.Time, modified map[string]bool, depth int) {
	if depth >= maxAutoCloseDepth {
		slog.Warn("autoCloseRecursive depth limit reached", "workId", w.ID, "depth", depth)
		return
	}

	if w.Status != StatusDone {
		return
	}

	// Check if all children are done or closed
	for _, child := range s.works {
		if child.ParentID == w.ID {
			if child.Status != StatusDone && child.Status != StatusClosed {
				return
			}
		}
	}

	// All children complete (or no children) → promote to closed
	w.Status = StatusClosed
	w.UpdatedAt = now
	modified[w.ID] = true

	// Cascade: check if parent can also close
	if w.ParentID == "" {
		return
	}
	for i := range s.works {
		if s.works[i].ID == w.ParentID && s.works[i].Status == StatusDone {
			s.autoCloseRecursiveN(&s.works[i], now, modified, depth+1)
			return
		}
	}
}

// --- Listener management ---

func (s *FileStore) AddOnChangeListener(listener OnChangeListener) {
	s.worksMu.Lock()
	defer s.worksMu.Unlock()
	s.listeners = append(s.listeners, listener)
}

// Caller must hold s.worksMu (read or write).
func (s *FileStore) copyListeners() []OnChangeListener {
	out := make([]OnChangeListener, len(s.listeners))
	copy(out, s.listeners)
	return out
}

// Must be called WITHOUT s.worksMu held.
func notify(listeners []OnChangeListener, event ChangeEvent) {
	for _, l := range listeners {
		l.OnWorkChange(event)
	}
}

// --- File I/O with flock ---
//
// A dedicated lock file (index.json.lock) is used for flock because the data
// file may be replaced via rename, which changes its inode. A stable lock file
// ensures flock works correctly across processes.

func (s *FileStore) lockPath() string {
	return s.indexPath() + ".lock"
}

func (s *FileStore) readIndexFromDisk() (indexData, error) {
	// Acquire shared lock to prevent reading mid-rename
	lockF, err := os.OpenFile(s.lockPath(), os.O_CREATE|os.O_RDWR, 0644)
	if err != nil {
		return indexData{}, fmt.Errorf("open lock file: %w", err)
	}
	defer lockF.Close()

	if err := syscall.Flock(int(lockF.Fd()), syscall.LOCK_SH); err != nil {
		return indexData{}, fmt.Errorf("flock shared: %w", err)
	}
	defer syscall.Flock(int(lockF.Fd()), syscall.LOCK_UN)

	path := s.indexPath()
	f, err := os.Open(path)
	if os.IsNotExist(err) {
		return indexData{Works: []Work{}}, nil
	}
	if err != nil {
		return indexData{}, err
	}
	defer f.Close()

	var idx indexData
	if err := json.NewDecoder(f).Decode(&idx); err != nil {
		return indexData{}, err
	}
	if idx.Works == nil {
		idx.Works = []Work{}
	}
	return idx, nil
}

// persistIndex writes the index atomically using write-temp-fsync-rename.
// A crash at any point leaves either the old file intact or the new file
// fully written — never a partial/empty file.
func (s *FileStore) persistIndex() error {
	data, err := json.MarshalIndent(indexData{Works: s.works}, "", "  ")
	if err != nil {
		return err
	}

	// Acquire exclusive lock
	lockF, err := os.OpenFile(s.lockPath(), os.O_CREATE|os.O_RDWR, 0644)
	if err != nil {
		return fmt.Errorf("open lock file: %w", err)
	}
	defer lockF.Close()

	if err := syscall.Flock(int(lockF.Fd()), syscall.LOCK_EX); err != nil {
		return fmt.Errorf("flock exclusive: %w", err)
	}
	defer syscall.Flock(int(lockF.Fd()), syscall.LOCK_UN)

	// Write to temp file in the same directory (same filesystem for atomic rename)
	path := s.indexPath()
	tmpPath := path + ".tmp"

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

	// Atomic rename
	if err := os.Rename(tmpPath, path); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("rename temp to index: %w", err)
	}

	s.writeGen.Add(1)
	return nil
}

// --- fsnotify: detect external changes (MCP writes) ---

func (s *FileStore) StartWatching() error {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return err
	}
	s.watcher = watcher

	// Watch the directory (file-level watches don't survive file replacements)
	dir := filepath.Dir(s.indexPath())
	if err := watcher.Add(dir); err != nil {
		watcher.Close()
		return err
	}

	go s.watchLoop()
	slog.Info("WorkStore watching for external changes", "path", s.indexPath())
	return nil
}

func (s *FileStore) StopWatching() {
	// Stop debounce timer first to prevent a pending reload from firing
	// after watcher.Close() but before we cancel the timer.
	s.debounceMu.Lock()
	if s.debounce != nil {
		s.debounce.Stop()
	}
	s.debounceMu.Unlock()

	if s.watcher != nil {
		s.watcher.Close()
	}
}

func (s *FileStore) watchLoop() {
	for {
		select {
		case event, ok := <-s.watcher.Events:
			if !ok {
				return
			}
			if filepath.Base(event.Name) != "index.json" {
				continue
			}
			if event.Op&(fsnotify.Write|fsnotify.Create) == 0 {
				continue
			}
			s.scheduleReload()
		case err, ok := <-s.watcher.Errors:
			if !ok {
				return
			}
			slog.Error("work store fsnotify error", "error", err)
		}
	}
}

const reloadDebounce = 100 * time.Millisecond

func (s *FileStore) scheduleReload() {
	s.debounceMu.Lock()
	defer s.debounceMu.Unlock()

	if s.debounce != nil {
		s.debounce.Stop()
	}
	s.debounce = time.AfterFunc(reloadDebounce, s.reloadFromDisk)
}

func (s *FileStore) reloadFromDisk() {
	// Snapshot write generation before reading. If an in-process write
	// happens between our disk read and the lock acquisition, the
	// generation will differ and we skip this reload — the in-process
	// write already updated in-memory state, and its own fsnotify event
	// will trigger a fresh reload if needed.
	genBefore := s.writeGen.Load()

	idx, err := s.readIndexFromDisk()
	if err != nil {
		slog.Error("failed to reload work index", "error", err)
		return
	}

	s.worksMu.Lock()

	if s.writeGen.Load() != genBefore {
		// An in-process write happened since we read the disk — our disk
		// data may be stale. Skip this reload; the next fsnotify event
		// (from the in-process write's rename) will trigger a fresh one.
		s.worksMu.Unlock()
		return
	}

	old := s.works
	s.works = idx.Works
	listeners := s.copyListeners()
	s.worksMu.Unlock()

	// Diff against in-memory state: if our own write caused this reload,
	// the data matches and no events are fired. External writes (MCP)
	// produce a diff and trigger notifications.
	events := diffWorks(old, idx.Works)
	for _, e := range events {
		notify(listeners, e)
	}
}

func diffWorks(old, updated []Work) []ChangeEvent {
	var events []ChangeEvent

	oldMap := make(map[string]Work, len(old))
	for _, w := range old {
		oldMap[w.ID] = w
	}

	newMap := make(map[string]Work, len(updated))
	for _, w := range updated {
		newMap[w.ID] = w
	}

	// Deletes
	for id, w := range oldMap {
		if _, exists := newMap[id]; !exists {
			events = append(events, ChangeEvent{Op: OperationDelete, Work: w})
		}
	}

	// Creates and Updates
	for id, w := range newMap {
		oldW, exists := oldMap[id]
		if !exists {
			events = append(events, ChangeEvent{Op: OperationCreate, Work: w})
		} else if workChanged(oldW, w) {
			events = append(events, ChangeEvent{Op: OperationUpdate, Work: w})
		}
	}

	return events
}

func workChanged(a, b Work) bool {
	return a.Title != b.Title ||
		a.Body != b.Body ||
		a.AgentRoleID != b.AgentRoleID ||
		a.Status != b.Status ||
		a.SessionID != b.SessionID ||
		a.ParentID != b.ParentID ||
		!a.UpdatedAt.Equal(b.UpdatedAt)
}

// --- Helpers ---

func (s *FileStore) findIndex(id string) int {
	for i, w := range s.works {
		if w.ID == id {
			return i
		}
	}
	return -1
}
