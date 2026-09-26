package work

import (
	"context"
	"encoding/json"
	"fmt"
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

	// Start transitions a work item to active and assigns an explicit sessionID.
	// Allowed from any status ValidateStartable admits — everything but active
	// and closed. Use Activate when the session is already live and only the
	// status is stale. To start an agent session use Claim, which decides the
	// sessionID atomically; Start is the lower-level primitive.
	Start(ctx context.Context, id string, sessionID string) (Work, error)

	// Claim atomically transitions a work item to active for starting an agent
	// session. The restart decision and sessionID assignment happen under the
	// store lock so concurrent claims cannot race: on restart (the work already
	// has a session) that sessionID is reused to preserve chat history;
	// otherwise a fresh sessionID is generated. The returned restart
	// flag tells the caller how to RollbackStart if the kickoff later fails.
	//
	// A non-nil watcher is recorded as the story's Watcher in the same write,
	// so nothing the story does after starting can happen before the watch is
	// in place; nil leaves any existing watcher alone. Only a story can be
	// watched. A rollback leaves the watch where it is: it is what the caller
	// asked for, and the next start honours it.
	Claim(ctx context.Context, id string, watcher *Watcher) (w Work, restart bool, err error)

	// Stop hands the work back to a person: the engine stops driving it and its
	// session loses its lease. Allowed from any live status.
	Stop(ctx context.Context, id string) error

	// Activate says a person or a child just handed this work something to go on:
	// it becomes active, its wait is cleared and its nudge allowance starts over.
	// SessionID is left untouched. Rejected only for open (never started; use
	// Start) and closed (use Reopen).
	Activate(ctx context.Context, id string) error

	// ClearNudges gives an active work its full nudge allowance back and changes
	// nothing else. It is the narrower half of Activate, for the one event that
	// is the user's attention without being a transition: an answer to a posted
	// question. The work was already active — the agent posted the question and
	// carried on — and a wait on its subtasks is not something the answer ended,
	// so neither may be touched.
	ClearNudges(ctx context.Context, id string) error

	// SetChildWait records a wait on child work, and refuses when no child of
	// the work is active — reporting whether it set one rather than returning an
	// error, because the caller is the one that can say why in the agent's
	// terms. Errors are the ordinary ones: a missing work, or a status that
	// admits no progress at all.
	//
	// Taken under the store lock, for the reason ClearChildWaitIfStranded is:
	// checking first and setting afterwards leaves a window in which the last
	// active child stops, the engine looks at a parent that is not waiting yet
	// and rightly does nothing, and the wait then lands with nothing left that
	// could ever end it. That is the exact failure both methods exist to
	// prevent, so neither may be assembled from a read and a write.
	SetChildWait(ctx context.Context, id string) (set bool, err error)

	// ClearChildWaitIfStranded ends a wait on child work when no child of the
	// work is active, and reports whether this call was the one that ended it.
	// The work is left active with its nudge allowance reset, exactly as
	// Activate leaves it; a work that is not waiting on children, or still has
	// one running, is left alone and the answer is false.
	//
	// The whole method exists to take one decision under one lock. The engine
	// clears such a wait and tells the agent so in the same breath, and both
	// halves of the condition can move underneath it: another subtask can be
	// started while the check runs, and several subtasks leaving active at once
	// each ask the same question. Split into a read and a write, the first
	// produces a message claiming nothing is running when something is, and the
	// second produces the same message twice.
	ClearChildWaitIfStranded(ctx context.Context, id string) (cleared bool, err error)

	// RecordNudge counts one nudge against the work and returns the new count.
	// The engine compares it against its own limit; the store only keeps score,
	// so that "how many is too many" is decided in one place and not two.
	RecordNudge(ctx context.Context, id string) (int, error)

	// StepDone marks current work progress as complete.
	// Work advances CurrentStep while more steps remain; otherwise it closes.
	// Returns hasMoreSteps=true if there are remaining steps after advancement.
	// Allowed from any live status: the calling agent is proof its session runs,
	// so an advance also clears a stale wait or a stale stopped back to active.
	StepDone(ctx context.Context, id string, totalSteps int) (hasMoreSteps bool, err error)

	// RollbackStart reverts a failed Start. Fresh starts roll back to open
	// (clearing sessionID); restarts roll back to stopped (preserving sessionID).
	//
	// sessionID is the one the failed start claimed, and it is what identifies
	// the start being undone: a work that has since moved on to another session
	// is not the one this caller acted on.
	RollbackStart(ctx context.Context, id string, sessionID string, wasRestart bool) error

	// Reopen transitions a closed work item back to active.
	// This allows users to add more tasks or continue working.
	Reopen(ctx context.Context, id string) error

	// SetWorktree records the worktree a story will run in and pins its tasks to
	// that worktree too. Only permitted before the work has started (status
	// open); once started the worktree is immutable. Tasks normally inherit
	// their worktree at create time, but one created before its story started
	// still holds the empty default, so this also propagates the worktree down
	// to those.
	SetWorktree(ctx context.Context, id string, worktree string) error

	AddComment(ctx context.Context, workID, body string) (Comment, error)
	UpdateComment(ctx context.Context, commentID, body string) (Comment, error)
	ListComments(workID string) ([]Comment, error)

	AddOnChangeListener(listener OnChangeListener)
	AddOnCommentChangeListener(listener OnCommentChangeListener)
}

// UpdateFields specifies which fields to update. Nil fields are left unchanged.
// Status and SessionID are not included — use the intent-based transition
// methods (Start, Stop, StepDone, etc.) for status changes.
type UpdateFields struct {
	Title       *string `json:"title,omitempty"`
	Body        *string `json:"body,omitempty"`
	AgentRoleID *string `json:"agent_role_id,omitempty"`
}

type indexData struct {
	Works    []Work    `json:"works"`
	Comments []Comment `json:"comments,omitempty"`
}

// FileStore persists Work items to a JSON file with file-lock-based inter-process safety.
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
		Path:  filepath.Join(dataDir, "works", "index.json"),
		Label: "work",
	})
	if err != nil {
		return nil, err
	}
	store.file = f

	idx, err := store.readIndexFromDisk()
	if err != nil {
		return nil, err
	}
	// Old values are brought up to the current model as they are read, which is
	// the whole of the migration: see Work.Normalize. Nothing is written back —
	// a normalised record persists the next time something changes it, and a
	// work nobody touches again costs nothing to normalise on every start.
	store.works = make([]Work, len(idx.Works))
	for i, w := range idx.Works {
		store.works[i] = w.Normalize()
	}
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
	if w.Title == "" {
		return Work{}, fmt.Errorf("%w: title is required", ErrInvalidWork)
	}

	s.worksMu.Lock()

	var story *Work
	if w.StoryID != "" {
		for i := range s.works {
			if s.works[i].ID == w.StoryID {
				story = &s.works[i]
				break
			}
		}
		if story == nil {
			s.worksMu.Unlock()
			return Work{}, fmt.Errorf("%w: story %q not found", ErrInvalidWork, w.StoryID)
		}
		if err := ValidateStory(*story); err != nil {
			s.worksMu.Unlock()
			return Work{}, err
		}
		if story.Status == StatusClosed {
			s.worksMu.Unlock()
			return Work{}, fmt.Errorf("%w: story %s is closed; reopen it first to add tasks", ErrInvalidWork, story.ID)
		}
	}

	if w.AgentRoleID == "" {
		s.worksMu.Unlock()
		return Work{}, fmt.Errorf("%w: agent_role_id is required", ErrInvalidWork)
	}

	// A task inherits its story's worktree. Since tasks are created by the
	// story's running agent, the story already has its worktree fixed.
	worktree := w.Worktree
	if story != nil {
		worktree = story.Worktree
	}

	now := time.Now()
	work := Work{
		ID:          uuid.Must(uuid.NewV7()).String(),
		StoryID:     w.StoryID,
		AgentRoleID: w.AgentRoleID,
		Title:       w.Title,
		Body:        w.Body,
		Status:      StatusOpen,
		Worktree:    worktree,
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

	// Collect the target and its tasks for cascade delete.
	deleteIDs := subtreeIDs(s.works, id)

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

func (s *FileStore) Start(_ context.Context, id string, sessionID string) (Work, error) {
	s.worksMu.Lock()

	idx := s.findIndex(id)
	if idx < 0 {
		s.worksMu.Unlock()
		return Work{}, ErrWorkNotFound
	}

	w := &s.works[idx]
	if err := ValidateStartable(w.Status); err != nil {
		s.worksMu.Unlock()
		return Work{}, fmt.Errorf("cannot start work %s: %w", id, err)
	}

	prev := s.snapshotWorks()

	now := time.Now()
	w.Status = StatusActive
	w.SessionID = sessionID
	w.clearDrive()
	w.UpdatedAt = now

	result := *w // copy before persistAndNotifyUpdates releases the lock

	modified := map[string]bool{id: true}
	if err := s.persistAndNotifyUpdates(prev, modified); err != nil {
		return Work{}, err
	}

	return result, nil
}

func (s *FileStore) Claim(_ context.Context, id string, watcher *Watcher) (Work, bool, error) {
	s.worksMu.Lock()

	idx := s.findIndex(id)
	if idx < 0 {
		s.worksMu.Unlock()
		return Work{}, false, ErrWorkNotFound
	}

	w := &s.works[idx]
	if err := ValidateStartable(w.Status); err != nil {
		s.worksMu.Unlock()
		return Work{}, false, fmt.Errorf("cannot start work %s: %w", id, err)
	}
	if watcher != nil && w.Type() != WorkTypeStory {
		s.worksMu.Unlock()
		return Work{}, false, fmt.Errorf("%w: work %s is a task, and only a story can be watched", ErrInvalidWork, id)
	}

	// Any work that already owns a session is a restart: reusing that session
	// preserves the chat history. Only a never-started work (or one rolled back
	// to open, which clears the session) gets a fresh one. Decided under the
	// lock so a concurrent transition cannot make us act on a stale snapshot.
	sessionID := w.SessionID
	restart := sessionID != ""
	if !restart {
		sessionID = uuid.Must(uuid.NewV7()).String()
	}

	prev := s.snapshotWorks()

	w.Status = StatusActive
	w.SessionID = sessionID
	w.clearDrive()
	if watcher != nil {
		watched := *watcher
		w.Watcher = &watched
	}
	w.UpdatedAt = time.Now()

	result := *w // copy before persistAndNotifyUpdates releases the lock

	modified := map[string]bool{id: true}
	if err := s.persistAndNotifyUpdates(prev, modified); err != nil {
		return Work{}, false, err
	}

	return result, restart, nil
}

// setLiveStatus moves a work between the live statuses. Every live status is a
// valid source (see ValidateProgress); action names the intent for the error
// message. mutate is handed a copy and reports whether anything moved, so a
// repeated liveness signal — and those repeat constantly — neither writes the
// index nor wakes a subscriber with a change event that carries no news.
func (s *FileStore) setLiveStatus(id string, action string, mutate func(*Work) bool) error {
	s.worksMu.Lock()

	idx := s.findIndex(id)
	if idx < 0 {
		s.worksMu.Unlock()
		return ErrWorkNotFound
	}

	if err := ValidateProgress(s.works[idx].Status); err != nil {
		s.worksMu.Unlock()
		return fmt.Errorf("cannot %s work %s: %w", action, id, err)
	}

	// On a copy, so that a mutate which decides nothing moved leaves the record
	// it was deciding about untouched.
	next := s.works[idx]
	if !mutate(&next) {
		s.worksMu.Unlock()
		return nil
	}
	next.UpdatedAt = time.Now()

	prev := s.snapshotWorks()
	s.works[idx] = next

	modified := map[string]bool{id: true}
	return s.persistAndNotifyUpdates(prev, modified)
}

// clearDrive drops everything that only means something while the engine is
// driving this work: what it was waiting for, and how many nudges it has had.
//
// Every transition into or out of active goes through it, with one deliberate
// exception — SetChildWait, whose whole purpose is to *state* a wait and which
// therefore assigns it instead. So no path leaves a stale wait behind for the
// next one to trip over: each one either clears the wait or says what it is.
//
// That one leaves the nudge count where it is, and nothing can spend it there: a
// work with a wait is never nudged (Engine.HandleTurnEnded returns on it), and
// every other way a wait ends comes back through clearDrive, which zeroes the
// count in the same breath.
func (w *Work) clearDrive() {
	w.Wait, w.NudgeCount = WaitNone, 0
}

func (s *FileStore) Stop(_ context.Context, id string) error {
	return s.setLiveStatus(id, "stop", func(w *Work) bool {
		if w.Status == StatusStopped {
			return false
		}
		w.Status = StatusStopped
		// A stopped work waits for a person, and that is the whole of what
		// stopped means — keeping a wait here would be a second way to say it,
		// disagreeing with the first as soon as the reason went stale.
		w.clearDrive()
		return true
	})
}

func (s *FileStore) Activate(_ context.Context, id string) error {
	return s.setLiveStatus(id, "activate", func(w *Work) bool {
		if w.Status == StatusActive && w.Wait == WaitNone && w.NudgeCount == 0 {
			return false
		}
		w.Status = StatusActive
		w.clearDrive()
		return true
	})
}

func (s *FileStore) ClearNudges(_ context.Context, id string) error {
	return s.setLiveStatus(id, "clear the nudge count of", func(w *Work) bool {
		if w.Status != StatusActive || w.NudgeCount == 0 {
			return false
		}
		w.NudgeCount = 0
		return true
	})
}

// SetChildWait and ClearChildWaitIfStranded are the two transitions here not
// written through setLiveStatus: their condition spans the work *and its
// tasks*, and setLiveStatus hands a mutate func the one record it is changing.
// Reading the tasks outside the lock is the bug they exist to remove, so each
// takes the lock itself.
//
// HasActiveTask is the condition, and it is written once for both. "Is there
// still something that could close" is one question; a wait set on one answer
// and cleared on another would be a wait that argues with itself.
func (s *FileStore) SetChildWait(_ context.Context, id string) (bool, error) {
	s.worksMu.Lock()

	idx := s.findIndex(id)
	if idx < 0 {
		s.worksMu.Unlock()
		return false, ErrWorkNotFound
	}
	if err := ValidateProgress(s.works[idx].Status); err != nil {
		s.worksMu.Unlock()
		return false, fmt.Errorf("cannot set the wait of work %s: %w", id, err)
	}
	if !HasActiveTask(s.works, id) {
		s.worksMu.Unlock()
		return false, nil
	}

	// Already exactly this wait: a repeat is not news, and re-announcing an
	// unchanged record would wake every subscriber with a change event that
	// carries none.
	if w := s.works[idx]; w.Status == StatusActive && w.Wait == WaitChild {
		s.worksMu.Unlock()
		return true, nil
	}

	next := s.works[idx]
	// Declaring a wait is the agent reporting on a work it is running, so it
	// also says the work is active — the same reason StepDone does.
	next.Status = StatusActive
	next.Wait = WaitChild
	next.UpdatedAt = time.Now()

	prev := s.snapshotWorks()
	s.works[idx] = next

	if err := s.persistAndNotifyUpdates(prev, map[string]bool{id: true}); err != nil {
		return false, err
	}
	return true, nil
}

func (s *FileStore) ClearChildWaitIfStranded(_ context.Context, id string) (bool, error) {
	s.worksMu.Lock()

	idx := s.findIndex(id)
	if idx < 0 {
		s.worksMu.Unlock()
		return false, ErrWorkNotFound
	}
	if w := s.works[idx]; w.Status != StatusActive || w.Wait != WaitChild || HasActiveTask(s.works, id) {
		s.worksMu.Unlock()
		return false, nil
	}

	next := s.works[idx]
	next.clearDrive()
	next.UpdatedAt = time.Now()

	prev := s.snapshotWorks()
	s.works[idx] = next

	if err := s.persistAndNotifyUpdates(prev, map[string]bool{id: true}); err != nil {
		return false, err
	}
	return true, nil
}

// HasActiveTask reports whether any task of storyID is active. It is the one
// condition a wait on tasks depends on, so it is written once and read both by
// the store (under its lock) and by whoever is holding a listing already.
//
// The empty id answers false, for the reason TasksOf gives at length.
func HasActiveTask(works []Work, storyID string) bool {
	if storyID == "" {
		return false
	}
	for _, w := range works {
		if w.StoryID == storyID && w.Status == StatusActive {
			return true
		}
	}
	return false
}

func (s *FileStore) RecordNudge(_ context.Context, id string) (int, error) {
	count := 0
	err := s.setLiveStatus(id, "nudge", func(w *Work) bool {
		w.NudgeCount++
		count = w.NudgeCount
		return true
	})
	if err != nil {
		return 0, err
	}
	return count, nil
}

func (s *FileStore) StepDone(_ context.Context, id string, totalSteps int) (bool, error) {
	s.worksMu.Lock()

	idx := s.findIndex(id)
	if idx < 0 {
		s.worksMu.Unlock()
		return false, ErrWorkNotFound
	}

	w := &s.works[idx]
	if err := ValidateProgress(w.Status); err != nil {
		s.worksMu.Unlock()
		return false, fmt.Errorf("cannot complete a step of work %s: %w", id, err)
	}

	prev := s.snapshotWorks()

	if totalSteps > 0 && w.CurrentStep < totalSteps-1 {
		w.CurrentStep++
		// The agent just reported progress, so it is running whatever a stale
		// wait or a stale stopped says — and a new step is a new context, which
		// is why the nudge allowance starts over with it.
		w.Status = StatusActive
		w.clearDrive()
		w.UpdatedAt = time.Now()

		modified := map[string]bool{id: true}
		if err := s.persistAndNotifyUpdates(prev, modified); err != nil {
			return false, err
		}
		return true, nil
	}

	w.Status = StatusClosed
	w.clearDrive()
	// In the same write as the close, so no later start — a reopen, a restart
	// from the web — can find the old watch still in place and wake a chat that
	// has long moved on. The close itself still reaches it: the change event
	// carries the released watcher as PrevWatcher.
	w.Watcher = nil
	w.UpdatedAt = time.Now()

	modified := map[string]bool{id: true}
	if err := s.persistAndNotifyUpdates(prev, modified); err != nil {
		return false, err
	}
	return false, nil
}

func (s *FileStore) RollbackStart(_ context.Context, id string, sessionID string, wasRestart bool) error {
	s.worksMu.Lock()

	idx := s.findIndex(id)
	if idx < 0 {
		s.worksMu.Unlock()
		return ErrWorkNotFound
	}

	w := &s.works[idx]
	// The session is what identifies the start being undone, and the status is
	// what says nobody has taken the work somewhere a rollback would clobber.
	//
	// `stopped` is admitted beside `active` for one reason, and it is not
	// hypothetical: a kickoff that fails deletes the session it created, and the
	// engine stops the work of a deleted session — so the stop and this rollback
	// race, in either order. Both orders now converge on the same answer,
	// because the session id still names this start. What is refused is a work
	// the agent has moved on (closed), or one already started again on a
	// different session.
	if w.SessionID != sessionID || (w.Status != StatusActive && w.Status != StatusStopped) {
		s.worksMu.Unlock()
		return fmt.Errorf("%w: cannot roll back start of work %s: it is %s on session %q, not the start that failed",
			ErrInvalidWork, id, w.Status, w.SessionID)
	}

	prev := s.snapshotWorks()

	if wasRestart {
		// Restart rollback preserves the sessionID so the chat history survives.
		w.Status = StatusStopped
	} else {
		w.Status = StatusOpen
		w.SessionID = ""
	}
	// Leaving active goes through clearDrive here as everywhere else. Claim has
	// already cleared it, so today this undoes nothing; keeping the rule without
	// exceptions is what stops the next status written here from being the one
	// that leaves a wait behind.
	w.clearDrive()
	w.UpdatedAt = time.Now()

	modified := map[string]bool{id: true}
	return s.persistAndNotifyUpdates(prev, modified)
}

func (s *FileStore) Reopen(_ context.Context, id string) error {
	s.worksMu.Lock()

	idx := s.findIndex(id)
	if idx < 0 {
		s.worksMu.Unlock()
		return ErrWorkNotFound
	}

	w := &s.works[idx]
	if w.Status != StatusClosed {
		s.worksMu.Unlock()
		return fmt.Errorf("%w: Reopen requires closed status, got %s", ErrInvalidWork, w.Status)
	}

	prev := s.snapshotWorks()

	w.Status = StatusActive
	w.clearDrive()
	w.UpdatedAt = time.Now()

	modified := map[string]bool{id: true}
	return s.persistAndNotifyUpdates(prev, modified)
}

func (s *FileStore) SetWorktree(_ context.Context, id string, worktree string) error {
	s.worksMu.Lock()

	idx := s.findIndex(id)
	if idx < 0 {
		s.worksMu.Unlock()
		return ErrWorkNotFound
	}

	root := &s.works[idx]
	// A work's worktree is fixed the moment it starts; only an unstarted (open)
	// work may still change it. Re-assigning the same worktree is a harmless
	// no-op even after start, which keeps a main story's open→start→stop→start
	// cycle idempotent.
	if root.Worktree != worktree && root.Status != StatusOpen {
		s.worksMu.Unlock()
		return fmt.Errorf("%w: worktree is immutable once work %s has started (status %s)", ErrInvalidWork, id, root.Status)
	}

	// Pin the story and its tasks to one worktree. Tasks normally inherit at
	// create time, but an open task created before its story started still holds
	// the empty default; bring those along so "a story and its tasks share one
	// worktree" holds regardless of create ordering. Started tasks keep their
	// fixed worktree and are left untouched.
	subtree := subtreeIDs(s.works, id)

	prev := s.snapshotWorks()
	now := time.Now()
	modified := map[string]bool{}
	for i := range s.works {
		w := &s.works[i]
		if !subtree[w.ID] || w.Worktree == worktree || w.Status != StatusOpen {
			continue
		}
		w.Worktree = worktree
		w.UpdatedAt = now
		modified[w.ID] = true
	}

	if len(modified) == 0 {
		s.worksMu.Unlock()
		return nil
	}
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

	before := make(map[string]Work, len(modified))
	for _, w := range prev {
		if modified[w.ID] {
			before[w.ID] = w
		}
	}
	var events []ChangeEvent
	for _, w := range s.works {
		if modified[w.ID] {
			events = append(events, ChangeEvent{
				Op:          OperationUpdate,
				Work:        w,
				PrevStatus:  before[w.ID].Status,
				PrevWatcher: before[w.ID].Watcher,
			})
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

func (s *FileStore) UpdateComment(_ context.Context, commentID, body string) (Comment, error) {
	s.worksMu.Lock()

	idx := -1
	for i, c := range s.comments {
		if c.ID == commentID {
			idx = i
			break
		}
	}
	if idx < 0 {
		s.worksMu.Unlock()
		return Comment{}, ErrCommentNotFound
	}

	prev := make([]Comment, len(s.comments))
	copy(prev, s.comments)

	s.comments[idx].Body = body
	updated := s.comments[idx]

	if err := s.persistIndex(); err != nil {
		s.comments = prev
		s.worksMu.Unlock()
		return Comment{}, err
	}

	commentListeners := s.copyCommentListeners()
	s.worksMu.Unlock()

	notifyComment(commentListeners, CommentEvent{Comment: updated})
	return updated, nil
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

// --- Helpers ---

// IDsBySession indexes work items by the session each one runs, for the readers
// that resolve a whole list of sessions and would otherwise look each one up
// separately. Work with no session is left out; session ids are unique across
// worktrees, so the index needs no worktree filter.
//
// Work.SessionID is the relation itself — a session never stores which work it
// belongs to (rpc.SessionListItem.WorkID) — so this is the one place that
// inverts it.
func IDsBySession(works []Work) map[string]string {
	byID := make(map[string]string, len(works))
	for _, item := range works {
		if item.SessionID != "" {
			byID[item.SessionID] = item.ID
		}
	}
	return byID
}

// UnclosedWorkByWorktree returns the works assigned to the given worktree whose
// status is not closed, preserving list order. A worktree with any such work
// must not be deleted, since its sessions are still live or resumable.
func UnclosedWorkByWorktree(works []Work, worktree string) []Work {
	var unclosed []Work
	for _, w := range works {
		if w.Worktree == worktree && w.Status != StatusClosed {
			unclosed = append(unclosed, w)
		}
	}
	return unclosed
}

// TasksOf returns the tasks belonging to storyID, in listing order. The
// hierarchy is two levels by construction — a work with a StoryID is a task and
// holds none of its own — so this one query is the whole of "what is below this
// work", and nothing here walks or closes over anything.
//
// It replaced a transitive-closure walk that no caller had a third level to
// feed. Passing a task's id is not an error: it simply has no tasks.
//
// The empty id answers with nothing, and that is the one case worth spelling
// out: "" is how a story spells its *own* StoryID, so matching on it would
// answer "every story in the project" to a question that meant "the tasks of no
// story" — and subtreeIDs would hand that to a cascade delete. Writing
// TasksOf(works, w.StoryID) to find a work's siblings is the natural way to
// reach it.
func TasksOf(works []Work, storyID string) []Work {
	if storyID == "" {
		return nil
	}
	var tasks []Work
	for _, w := range works {
		if w.StoryID == storyID {
			tasks = append(tasks, w)
		}
	}
	return tasks
}

// subtreeIDs returns id together with the ids of its tasks — everything a
// cascade over one work covers.
func subtreeIDs(works []Work, id string) map[string]bool {
	ids := map[string]bool{id: true}
	for _, t := range TasksOf(works, id) {
		ids[t.ID] = true
	}
	return ids
}

func (s *FileStore) findIndex(id string) int {
	for i, w := range s.works {
		if w.ID == id {
			return i
		}
	}
	return -1
}
