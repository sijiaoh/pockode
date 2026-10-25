package schedule

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/pockode/server/agentrole"
	"github.com/pockode/server/filestore"
	"github.com/pockode/server/work"
)

// Store provides CRUD operations, run bookkeeping and change notifications for
// schedules.
type Store interface {
	List() ([]Schedule, error)
	Get(id string) (Schedule, bool, error)

	// Create validates s and adds it under a fresh id, computing its NextRunAt
	// if it is enabled. Only the settings fields of s are read.
	Create(ctx context.Context, s Schedule) (Schedule, error)
	// Update changes the given settings. NextRunAt is recomputed when the cron
	// expression, the time zone or the enabled flag changes, and left alone
	// otherwise.
	Update(ctx context.Context, id string, fields UpdateFields) (Schedule, error)
	// Delete removes the schedule and nothing else: its runs are job works of
	// their own, and they and their sessions stay.
	Delete(ctx context.Context, id string) error

	// RecordRun notes that run workID was just started for the schedule — by
	// its firing or by hand — clears LastFailure, and moves NextRunAt past now.
	RecordRun(ctx context.Context, id string, workID string) (Schedule, error)
	// RecordFailure notes that an attempt to run the schedule just failed with
	// message: the job could not be made (workID empty) or job workID could not
	// be started. NextRunAt moves past now, as for any other firing.
	RecordFailure(ctx context.Context, id string, workID string, message string) (Schedule, error)
	// RecordSkip notes that the schedule just fired without making a run
	// because its previous run was still active, and moves NextRunAt past now.
	RecordSkip(ctx context.Context, id string) (Schedule, error)
	// SkipMissedRuns moves every enabled schedule whose NextRunAt is not in the
	// future to its next firing after now. Firings missed while the server was
	// down are skipped rather than caught up, so this is called on startup
	// before anything fires.
	SkipMissedRuns(ctx context.Context) error

	AddOnChangeListener(listener OnChangeListener)
}

// UpdateFields specifies which settings to update. Nil fields are left unchanged.
type UpdateFields struct {
	Title       *string `json:"title,omitempty"`
	Prompt      *string `json:"prompt,omitempty"`
	AgentRoleID *string `json:"agent_role_id,omitempty"`
	Cron        *string `json:"cron,omitempty"`
	TimeZone    *string `json:"time_zone,omitempty"`
	Enabled     *bool   `json:"enabled,omitempty"`
	Worktree    *string `json:"worktree,omitempty"`
}

type indexData struct {
	Schedules []Schedule `json:"schedules"`
}

// FileStore persists schedules to a JSON file with file-lock-based
// inter-process safety.
type FileStore struct {
	file        *filestore.File
	roles       agentrole.Store
	schedulesMu sync.RWMutex
	schedules   []Schedule
	listeners   []OnChangeListener

	// now is the clock every NextRunAt is computed from; the zone each cron
	// expression is read in is the schedule's own, not this clock's.
	now func() time.Time
}

// NewFileStore loads the schedules of the project whose data directory is
// dataDir. roles is where the agent role a schedule names is checked.
func NewFileStore(dataDir string, roles agentrole.Store) (*FileStore, error) {
	f, err := filestore.New(filestore.Config{
		Path:  filepath.Join(dataDir, "schedules", "index.json"),
		Label: "schedule",
	})
	if err != nil {
		return nil, err
	}
	store := &FileStore{file: f, roles: roles, now: time.Now}

	idx, err := store.readIndexFromDisk()
	if err != nil {
		return nil, err
	}
	store.schedules = idx.Schedules
	return store, nil
}

// --- Read operations ---

func (s *FileStore) List() ([]Schedule, error) {
	s.schedulesMu.RLock()
	defer s.schedulesMu.RUnlock()

	result := make([]Schedule, len(s.schedules))
	copy(result, s.schedules)
	return result, nil
}

func (s *FileStore) Get(id string) (Schedule, bool, error) {
	s.schedulesMu.RLock()
	defer s.schedulesMu.RUnlock()

	if i := s.findIndex(id); i >= 0 {
		return s.schedules[i], true, nil
	}
	return Schedule{}, false, nil
}

// --- Write operations ---

func (s *FileStore) Create(_ context.Context, in Schedule) (Schedule, error) {
	now := s.now()
	sched := Schedule{
		ID:          uuid.Must(uuid.NewV7()).String(),
		Title:       in.Title,
		Prompt:      in.Prompt,
		AgentRoleID: in.AgentRoleID,
		Cron:        strings.TrimSpace(in.Cron),
		TimeZone:    in.TimeZone,
		Enabled:     in.Enabled,
		Worktree:    in.Worktree,
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	if err := validateSettings(sched); err != nil {
		return Schedule{}, err
	}
	if err := s.checkRole(sched.AgentRoleID); err != nil {
		return Schedule{}, err
	}
	reschedule(&sched, now)

	s.schedulesMu.Lock()
	s.schedules = append(s.schedules, sched)
	if err := s.persistIndex(); err != nil {
		s.schedules = s.schedules[:len(s.schedules)-1]
		s.schedulesMu.Unlock()
		return Schedule{}, err
	}
	listeners := s.copyListeners()
	s.schedulesMu.Unlock()

	notify(listeners, ChangeEvent{Op: OperationCreate, Schedule: sched})
	return sched, nil
}

func (s *FileStore) Update(_ context.Context, id string, fields UpdateFields) (Schedule, error) {
	return s.modify(id, func(sched *Schedule, now time.Time) error {
		timingChanged := false
		if fields.Title != nil {
			sched.Title = *fields.Title
		}
		if fields.Prompt != nil {
			sched.Prompt = *fields.Prompt
		}
		roleChanged := fields.AgentRoleID != nil && *fields.AgentRoleID != sched.AgentRoleID
		if fields.AgentRoleID != nil {
			sched.AgentRoleID = *fields.AgentRoleID
		}
		if fields.Cron != nil {
			cron := strings.TrimSpace(*fields.Cron)
			timingChanged = timingChanged || cron != sched.Cron
			sched.Cron = cron
		}
		if fields.TimeZone != nil {
			timingChanged = timingChanged || *fields.TimeZone != sched.TimeZone
			sched.TimeZone = *fields.TimeZone
		}
		if fields.Enabled != nil {
			timingChanged = timingChanged || *fields.Enabled != sched.Enabled
			sched.Enabled = *fields.Enabled
		}
		if fields.Worktree != nil {
			sched.Worktree = *fields.Worktree
		}
		if err := validateSettings(*sched); err != nil {
			return err
		}
		// The role is judged only when it changes, as a work's is
		// (agentrole.CheckReassignment): a role restricted away from jobs after
		// it was assigned does not make the schedule's other settings uneditable.
		if roleChanged {
			if err := s.checkRole(sched.AgentRoleID); err != nil {
				return err
			}
		}
		if timingChanged {
			reschedule(sched, now)
		}
		sched.UpdatedAt = now
		return nil
	})
}

func (s *FileStore) Delete(_ context.Context, id string) error {
	s.schedulesMu.Lock()

	idx := s.findIndex(id)
	if idx < 0 {
		s.schedulesMu.Unlock()
		return ErrNotFound
	}
	deleted := s.schedules[idx]

	prev := s.schedules
	s.schedules = make([]Schedule, 0, len(prev)-1)
	s.schedules = append(s.schedules, prev[:idx]...)
	s.schedules = append(s.schedules, prev[idx+1:]...)

	if err := s.persistIndex(); err != nil {
		s.schedules = prev
		s.schedulesMu.Unlock()
		return err
	}
	listeners := s.copyListeners()
	s.schedulesMu.Unlock()

	notify(listeners, ChangeEvent{Op: OperationDelete, Schedule: deleted})
	return nil
}

func (s *FileStore) RecordRun(_ context.Context, id string, workID string) (Schedule, error) {
	if workID == "" {
		return Schedule{}, fmt.Errorf("%w: a run needs the id of the work it made", ErrInvalidSchedule)
	}
	return s.modify(id, func(sched *Schedule, now time.Time) error {
		sched.LastRunAt = &now
		sched.LastRunWorkID = workID
		sched.LastFailure = nil
		reschedule(sched, now)
		return nil
	})
}

func (s *FileStore) RecordFailure(_ context.Context, id string, workID string, message string) (Schedule, error) {
	return s.modify(id, func(sched *Schedule, now time.Time) error {
		sched.LastFailure = &RunFailure{At: now, WorkID: workID, Error: message}
		reschedule(sched, now)
		return nil
	})
}

func (s *FileStore) RecordSkip(_ context.Context, id string) (Schedule, error) {
	return s.modify(id, func(sched *Schedule, now time.Time) error {
		sched.LastSkippedAt = &now
		reschedule(sched, now)
		return nil
	})
}

func (s *FileStore) SkipMissedRuns(_ context.Context) error {
	s.schedulesMu.Lock()

	now := s.now()
	prev := s.schedules
	s.schedules = make([]Schedule, len(prev))
	copy(s.schedules, prev)

	var changed []Schedule
	for i := range s.schedules {
		sched := &s.schedules[i]
		if !sched.Enabled || (sched.NextRunAt != nil && sched.NextRunAt.After(now)) {
			continue
		}
		reschedule(sched, now)
		changed = append(changed, *sched)
	}
	if len(changed) == 0 {
		s.schedulesMu.Unlock()
		return nil
	}

	if err := s.persistIndex(); err != nil {
		s.schedules = prev
		s.schedulesMu.Unlock()
		return err
	}
	listeners := s.copyListeners()
	s.schedulesMu.Unlock()

	for _, sched := range changed {
		notify(listeners, ChangeEvent{Op: OperationUpdate, Schedule: sched})
	}
	return nil
}

// modify applies mutate to schedule id under the lock and persists the result,
// restoring the schedule if mutate or the write fails.
func (s *FileStore) modify(id string, mutate func(sched *Schedule, now time.Time) error) (Schedule, error) {
	s.schedulesMu.Lock()

	idx := s.findIndex(id)
	if idx < 0 {
		s.schedulesMu.Unlock()
		return Schedule{}, ErrNotFound
	}
	sched := &s.schedules[idx]
	prev := *sched

	if err := mutate(sched, s.now()); err != nil {
		*sched = prev
		s.schedulesMu.Unlock()
		return Schedule{}, err
	}
	if err := s.persistIndex(); err != nil {
		*sched = prev
		s.schedulesMu.Unlock()
		return Schedule{}, err
	}

	updated := *sched
	listeners := s.copyListeners()
	s.schedulesMu.Unlock()

	notify(listeners, ChangeEvent{Op: OperationUpdate, Schedule: updated})
	return updated, nil
}

func (s *FileStore) checkRole(roleID string) error {
	return agentrole.CheckAssignmentWith(s.roles, roleID, work.WorkTypeJob, ErrInvalidSchedule)
}

func validateSettings(sched Schedule) error {
	if strings.TrimSpace(sched.Title) == "" {
		return fmt.Errorf("%w: title is required", ErrInvalidSchedule)
	}
	if strings.TrimSpace(sched.Prompt) == "" {
		return fmt.Errorf("%w: prompt is required", ErrInvalidSchedule)
	}
	if sched.AgentRoleID == "" {
		return fmt.Errorf("%w: agent_role_id is required", ErrInvalidSchedule)
	}
	if _, err := ParseCron(sched.Cron); err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidSchedule, err)
	}
	if _, err := loadZone(sched.TimeZone); err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidSchedule, err)
	}
	return nil
}

// reschedule sets NextRunAt to the schedule's first firing after now, read on
// the wall clock of the schedule's own zone, or clears it when the schedule is
// disabled. The cron expression and the zone have already been validated by
// the time any schedule reaches the store.
func reschedule(sched *Schedule, now time.Time) {
	if !sched.Enabled {
		sched.NextRunAt = nil
		return
	}
	cron, err := ParseCron(sched.Cron)
	if err != nil {
		// Only a hand-edited index can get here; such a schedule is left
		// without a next run rather than firing on a guess.
		sched.NextRunAt = nil
		return
	}
	loc, err := loadZone(sched.TimeZone)
	if err != nil {
		// As above: a zone is not guessed either.
		sched.NextRunAt = nil
		return
	}
	next := cron.Next(now.In(loc))
	if next.IsZero() {
		sched.NextRunAt = nil
		return
	}
	sched.NextRunAt = &next
}

// --- Listener management ---

func (s *FileStore) AddOnChangeListener(listener OnChangeListener) {
	s.schedulesMu.Lock()
	defer s.schedulesMu.Unlock()
	s.listeners = append(s.listeners, listener)
}

func (s *FileStore) copyListeners() []OnChangeListener {
	out := make([]OnChangeListener, len(s.listeners))
	copy(out, s.listeners)
	return out
}

func notify(listeners []OnChangeListener, event ChangeEvent) {
	for _, l := range listeners {
		l.OnScheduleChange(event)
	}
}

// --- File I/O ---

func (s *FileStore) readIndexFromDisk() (indexData, error) {
	data, err := s.file.Read()
	if err != nil {
		return indexData{}, err
	}
	if data == nil {
		return indexData{Schedules: []Schedule{}}, nil
	}

	var idx indexData
	if err := json.Unmarshal(data, &idx); err != nil {
		return indexData{}, err
	}
	if idx.Schedules == nil {
		idx.Schedules = []Schedule{}
	}
	return idx, nil
}

func (s *FileStore) persistIndex() error {
	data, err := filestore.MarshalIndex(indexData{Schedules: s.schedules})
	if err != nil {
		return err
	}
	return s.file.Write(data)
}

func (s *FileStore) findIndex(id string) int {
	for i, sched := range s.schedules {
		if sched.ID == id {
			return i
		}
	}
	return -1
}
