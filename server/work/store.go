package work

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"path/filepath"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/pockode/server/filestore"
)

// Store provides CRUD operations and change notifications for Work items.
type Store interface {
	List() ([]Work, error)
	Get(id string) (Work, bool, error)
	FindBySessionID(sessionID string) (Work, bool, error)

	Create(ctx context.Context, w Work) (Work, error)
	Update(ctx context.Context, id string, fields UpdateFields) error
	Delete(ctx context.Context, id string) error

	// --- Intent-based transition methods ---
	// These are the preferred way to change work status. Each method
	// encapsulates validation, sessionID management, and side effects.

	// Start transitions a work item to in_progress and assigns a sessionID.
	// Allowed from: open, stopped, needs_input. Use Reactivate for
	// process-running detection, or ReactivateParent for parent reactivation.
	Start(ctx context.Context, id string, sessionID string) (Work, error)

	// Stop transitions in_progress/needs_input → stopped.
	Stop(ctx context.Context, id string) error

	// MarkDone atomically transitions a work item to done, auto-advancing
	// from open → in_progress if needed. This avoids the TOCTOU race of a
	// separate Get → Update sequence.
	MarkDone(ctx context.Context, id string) error

	// MarkNeedsInput transitions in_progress → needs_input.
	MarkNeedsInput(ctx context.Context, id string) error

	// Resume transitions needs_input → in_progress.
	Resume(ctx context.Context, id string) error

	// Reactivate transitions stopped → in_progress without changing sessionID.
	// Used for process-running detection (user sends message to stopped session).
	Reactivate(ctx context.Context, id string) error

	// ReactivateParent transitions done/closed → in_progress without
	// changing sessionID. Used exclusively for parent reactivation when
	// a child work item closes.
	ReactivateParent(ctx context.Context, id string) error

	// RollbackStart reverts a failed Start. Fresh starts roll back to open
	// (clearing sessionID); restarts roll back to stopped (preserving sessionID).
	RollbackStart(ctx context.Context, id string, wasRestart bool) error

	AddComment(ctx context.Context, workID, body string) (Comment, error)
	ListComments(workID string) ([]Comment, error)

	AddOnChangeListener(listener OnChangeListener)
	AddOnCommentChangeListener(listener OnCommentChangeListener)

	// StartWatching begins monitoring the index file for external changes (e.g. from MCP).
	StartWatching() error
	StopWatching()
}

// UpdateFields specifies which fields to update. Nil fields are left unchanged.
// Status and SessionID are not included — use the intent-based transition
// methods (Start, Stop, MarkDone, etc.) for status changes.
type UpdateFields struct {
	Title       *string `json:"title,omitempty"`
	Body        *string `json:"body,omitempty"`
	AgentRoleID *string `json:"agent_role_id,omitempty"`
}

type indexData struct {
	Works    []Work    `json:"works"`
	Comments []Comment `json:"comments,omitempty"`
}

// FileStore persists Work items to a JSON file with flock-based inter-process safety.
type FileStore struct {
	file             *filestore.File
	worksMu          sync.RWMutex
	works            []Work
	comments         []Comment
	listeners        []OnChangeListener
	commentListeners []OnCommentChangeListener
}

func NewFileStore(dataDir string) (*FileStore, error) {
	store := &FileStore{}

	f, err := filestore.New(filestore.Config{
		Path:     filepath.Join(dataDir, "works", "index.json"),
		Label:    "work",
		OnReload: store.reloadFromDisk,
	})
	if err != nil {
		return nil, err
	}
	store.file = f

	idx, err := store.readIndexFromDisk()
	if err != nil {
		return nil, err
	}
	store.works = idx.Works
	store.comments = idx.Comments

	return store, nil
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

func (s *FileStore) FindBySessionID(sessionID string) (Work, bool, error) {
	s.worksMu.RLock()
	defer s.worksMu.RUnlock()

	for _, w := range s.works {
		if w.SessionID == sessionID {
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

	if w.AgentRoleID == "" {
		s.worksMu.Unlock()
		return Work{}, fmt.Errorf("%w: agent_role_id is required", ErrInvalidWork)
	}

	now := time.Now()
	work := Work{
		ID:          uuid.Must(uuid.NewV7()).String(),
		Type:        w.Type,
		ParentID:    w.ParentID,
		AgentRoleID: w.AgentRoleID,
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
	w.UpdatedAt = now

	modified := map[string]bool{id: true}
	return s.persistAndNotifyUpdates(prev, modified)
}

func (s *FileStore) Delete(_ context.Context, id string) error {
	s.worksMu.Lock()

	idx := s.findIndex(id)
	if idx < 0 {
		s.worksMu.Unlock()
		return ErrWorkNotFound
	}

	// Collect the target and its children for cascade delete.
	deleteIDs := map[string]bool{id: true}
	for _, w := range s.works {
		if w.ParentID == id {
			deleteIDs[w.ID] = true
		}
	}

	var deleted []Work
	newWorks := make([]Work, 0, len(s.works)-len(deleteIDs))
	for _, w := range s.works {
		if deleteIDs[w.ID] {
			deleted = append(deleted, w)
		} else {
			newWorks = append(newWorks, w)
		}
	}

	prev := s.works
	s.works = newWorks

	if err := s.persistIndex(); err != nil {
		s.works = prev
		s.worksMu.Unlock()
		return err
	}

	listeners := s.copyListeners()
	s.worksMu.Unlock()

	for _, w := range deleted {
		notify(listeners, ChangeEvent{Op: OperationDelete, Work: w})
	}
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
	s.autoClose(w, now, modified)

	return s.persistAndNotifyUpdates(prev, modified)
}

func (s *FileStore) Start(_ context.Context, id string, sessionID string) (Work, error) {
	s.worksMu.Lock()

	idx := s.findIndex(id)
	if idx < 0 {
		s.worksMu.Unlock()
		return Work{}, ErrWorkNotFound
	}

	w := &s.works[idx]
	if !ValidateTransition(w.Status, StatusInProgress) {
		s.worksMu.Unlock()
		return Work{}, fmt.Errorf("%w: invalid transition %s → %s", ErrInvalidWork, w.Status, StatusInProgress)
	}

	prev := s.snapshotWorks()

	now := time.Now()
	w.Status = StatusInProgress
	w.SessionID = sessionID
	w.UpdatedAt = now

	result := *w // copy before persistAndNotifyUpdates releases the lock

	modified := map[string]bool{id: true}
	if err := s.persistAndNotifyUpdates(prev, modified); err != nil {
		return Work{}, err
	}

	return result, nil
}

func (s *FileStore) Stop(_ context.Context, id string) error {
	s.worksMu.Lock()

	idx := s.findIndex(id)
	if idx < 0 {
		s.worksMu.Unlock()
		return ErrWorkNotFound
	}

	w := &s.works[idx]
	if !ValidateTransition(w.Status, StatusStopped) {
		s.worksMu.Unlock()
		return fmt.Errorf("%w: invalid transition %s → %s", ErrInvalidWork, w.Status, StatusStopped)
	}

	prev := s.snapshotWorks()

	w.Status = StatusStopped
	w.UpdatedAt = time.Now()

	modified := map[string]bool{id: true}
	return s.persistAndNotifyUpdates(prev, modified)
}

func (s *FileStore) MarkNeedsInput(_ context.Context, id string) error {
	s.worksMu.Lock()

	idx := s.findIndex(id)
	if idx < 0 {
		s.worksMu.Unlock()
		return ErrWorkNotFound
	}

	w := &s.works[idx]
	if !ValidateTransition(w.Status, StatusNeedsInput) {
		s.worksMu.Unlock()
		return fmt.Errorf("%w: invalid transition %s → %s", ErrInvalidWork, w.Status, StatusNeedsInput)
	}

	prev := s.snapshotWorks()

	w.Status = StatusNeedsInput
	w.UpdatedAt = time.Now()

	modified := map[string]bool{id: true}
	return s.persistAndNotifyUpdates(prev, modified)
}

func (s *FileStore) Resume(_ context.Context, id string) error {
	s.worksMu.Lock()

	idx := s.findIndex(id)
	if idx < 0 {
		s.worksMu.Unlock()
		return ErrWorkNotFound
	}

	w := &s.works[idx]
	if w.Status != StatusNeedsInput {
		s.worksMu.Unlock()
		return fmt.Errorf("%w: invalid transition %s → %s (Resume requires needs_input)", ErrInvalidWork, w.Status, StatusInProgress)
	}

	prev := s.snapshotWorks()

	w.Status = StatusInProgress
	w.UpdatedAt = time.Now()

	modified := map[string]bool{id: true}
	return s.persistAndNotifyUpdates(prev, modified)
}

func (s *FileStore) Reactivate(_ context.Context, id string) error {
	s.worksMu.Lock()

	idx := s.findIndex(id)
	if idx < 0 {
		s.worksMu.Unlock()
		return ErrWorkNotFound
	}

	w := &s.works[idx]
	if w.Status != StatusStopped {
		s.worksMu.Unlock()
		return fmt.Errorf("%w: invalid transition %s → %s (Reactivate requires stopped)", ErrInvalidWork, w.Status, StatusInProgress)
	}

	prev := s.snapshotWorks()

	w.Status = StatusInProgress
	w.UpdatedAt = time.Now()

	modified := map[string]bool{id: true}
	return s.persistAndNotifyUpdates(prev, modified)
}

func (s *FileStore) ReactivateParent(_ context.Context, id string) error {
	s.worksMu.Lock()

	idx := s.findIndex(id)
	if idx < 0 {
		s.worksMu.Unlock()
		return ErrWorkNotFound
	}

	w := &s.works[idx]
	if w.Status != StatusDone && w.Status != StatusClosed {
		s.worksMu.Unlock()
		return fmt.Errorf("%w: invalid transition %s → %s (ReactivateParent requires done or closed)", ErrInvalidWork, w.Status, StatusInProgress)
	}

	prev := s.snapshotWorks()

	w.Status = StatusInProgress
	w.UpdatedAt = time.Now()

	modified := map[string]bool{id: true}
	return s.persistAndNotifyUpdates(prev, modified)
}

func (s *FileStore) RollbackStart(_ context.Context, id string, wasRestart bool) error {
	s.worksMu.Lock()

	idx := s.findIndex(id)
	if idx < 0 {
		s.worksMu.Unlock()
		return ErrWorkNotFound
	}

	w := &s.works[idx]
	prev := s.snapshotWorks()

	if wasRestart {
		// Restart rollback: in_progress → stopped, preserve sessionID
		if !ValidateTransition(w.Status, StatusStopped) {
			s.worksMu.Unlock()
			return fmt.Errorf("%w: invalid transition %s → %s", ErrInvalidWork, w.Status, StatusStopped)
		}
		w.Status = StatusStopped
	} else {
		// Fresh start rollback: in_progress → open, clear sessionID
		if !ValidateTransition(w.Status, StatusOpen) {
			s.worksMu.Unlock()
			return fmt.Errorf("%w: invalid transition %s → %s", ErrInvalidWork, w.Status, StatusOpen)
		}
		w.Status = StatusOpen
		w.SessionID = ""
	}
	w.UpdatedAt = time.Now()

	modified := map[string]bool{id: true}
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

// autoClose promotes a done item to closed when all its children (if any)
// are closed. This handles both leaf items (no children) and parents whose
// children have all completed.
// Caller must hold s.worksMu write lock.
func (s *FileStore) autoClose(w *Work, now time.Time, modified map[string]bool) {
	if w.Status != StatusDone {
		return
	}

	for _, child := range s.works {
		if child.ParentID == w.ID && child.Status != StatusClosed {
			return // has non-closed children → stay done
		}
	}

	w.Status = StatusClosed
	w.UpdatedAt = now
	modified[w.ID] = true
}

// --- Comments ---

func (s *FileStore) AddComment(_ context.Context, workID, body string) (Comment, error) {
	s.worksMu.Lock()

	if s.findIndex(workID) < 0 {
		s.worksMu.Unlock()
		return Comment{}, ErrWorkNotFound
	}

	comment := Comment{
		ID:        uuid.Must(uuid.NewV7()).String(),
		WorkID:    workID,
		Body:      body,
		CreatedAt: time.Now(),
	}

	s.comments = append(s.comments, comment)

	if err := s.persistIndex(); err != nil {
		s.comments = s.comments[:len(s.comments)-1]
		s.worksMu.Unlock()
		return Comment{}, err
	}

	commentListeners := s.copyCommentListeners()
	s.worksMu.Unlock()

	notifyComment(commentListeners, CommentEvent{Comment: comment})
	return comment, nil
}

func (s *FileStore) ListComments(workID string) ([]Comment, error) {
	s.worksMu.RLock()
	defer s.worksMu.RUnlock()

	var result []Comment
	for _, c := range s.comments {
		if c.WorkID == workID {
			result = append(result, c)
		}
	}
	if result == nil {
		result = []Comment{}
	}
	return result, nil
}

// --- Listener management ---

func (s *FileStore) AddOnChangeListener(listener OnChangeListener) {
	s.worksMu.Lock()
	defer s.worksMu.Unlock()
	s.listeners = append(s.listeners, listener)
}

func (s *FileStore) AddOnCommentChangeListener(listener OnCommentChangeListener) {
	s.worksMu.Lock()
	defer s.worksMu.Unlock()
	s.commentListeners = append(s.commentListeners, listener)
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

// Caller must hold s.worksMu (read or write).
func (s *FileStore) copyCommentListeners() []OnCommentChangeListener {
	out := make([]OnCommentChangeListener, len(s.commentListeners))
	copy(out, s.commentListeners)
	return out
}

// Must be called WITHOUT s.worksMu held.
func notifyComment(listeners []OnCommentChangeListener, event CommentEvent) {
	for _, l := range listeners {
		l.OnCommentChange(event)
	}
}

// --- File I/O ---

func (s *FileStore) readIndexFromDisk() (indexData, error) {
	data, err := s.file.Read()
	if err != nil {
		return indexData{}, err
	}
	if data == nil {
		return indexData{Works: []Work{}}, nil
	}

	var idx indexData
	if err := json.Unmarshal(data, &idx); err != nil {
		return indexData{}, err
	}
	if idx.Works == nil {
		idx.Works = []Work{}
	}
	if idx.Comments == nil {
		idx.Comments = []Comment{}
	}
	return idx, nil
}

func (s *FileStore) persistIndex() error {
	data, err := filestore.MarshalIndex(indexData{Works: s.works, Comments: s.comments})
	if err != nil {
		return err
	}
	return s.file.Write(data)
}

// --- fsnotify ---

func (s *FileStore) StartWatching() error { return s.file.StartWatching() }
func (s *FileStore) StopWatching()        { s.file.StopWatching() }

func (s *FileStore) reloadFromDisk() {
	genBefore := s.file.SnapshotGen()

	idx, err := s.readIndexFromDisk()
	if err != nil {
		slog.Error("failed to reload work index", "error", err)
		return
	}

	s.worksMu.Lock()

	if s.file.IsStale(genBefore) {
		s.worksMu.Unlock()
		return
	}

	old := s.works
	oldComments := s.comments
	s.works = idx.Works
	s.comments = idx.Comments
	listeners := s.copyListeners()
	commentListeners := s.copyCommentListeners()
	s.worksMu.Unlock()

	events := diffWorks(old, idx.Works)
	for i := range events {
		events[i].External = true
	}
	for _, e := range events {
		notify(listeners, e)
	}

	commentEvents := diffComments(oldComments, idx.Comments)
	for _, e := range commentEvents {
		notifyComment(commentListeners, e)
	}
}

func diffWorks(old, updated []Work) []ChangeEvent {
	return filestore.Diff(old, updated,
		func(w Work) string { return w.ID },
		workChanged,
		func(op filestore.Operation, w Work) ChangeEvent {
			return ChangeEvent{Op: Operation(op), Work: w}
		},
	)
}

// diffComments detects newly added comments.
// Comments are append-only, so only creates need to be detected.
func diffComments(old, updated []Comment) []CommentEvent {
	oldIDs := make(map[string]struct{}, len(old))
	for _, c := range old {
		oldIDs[c.ID] = struct{}{}
	}

	var events []CommentEvent
	for _, c := range updated {
		if _, exists := oldIDs[c.ID]; !exists {
			events = append(events, CommentEvent{Comment: c})
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
