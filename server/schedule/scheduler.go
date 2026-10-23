package schedule

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/pockode/server/work"
)

// ErrRunActive refuses a run by hand while the schedule's previous run is
// still active: a schedule has at most one run going at a time, whoever asked.
var ErrRunActive = errors.New("previous run is still active")

// RunStore is where a schedule's runs are made and looked up. Satisfied by the
// work FileStore.
type RunStore interface {
	Get(id string) (work.Work, bool, error)
	CreateJob(ctx context.Context, w work.Work) (work.Work, error)
}

// RunStarter starts a run once it is made. Satisfied by work.Operations, so a
// run is started exactly as any other work is.
type RunStarter interface {
	StartWork(ctx context.Context, id string, watcher *work.Watcher) (work.Work, error)
}

// recheckInterval caps how long the scheduler sleeps before looking at the
// wall clock again. A timer counts elapsed time, not wall time, so a machine
// that sleeps or has its clock set forward would otherwise fire hours late. A
// clock set back is waited out rather than followed: NextRunAt stays where it
// was, because recomputing it from the earlier clock would fire again a wall
// time that has already fired — after every small correction NTP makes.
const recheckInterval = time.Minute

// Scheduler fires due schedules and makes runs by hand. Every run — fired or
// by hand — is a fresh job made from the schedule and started through the work
// operations.
type Scheduler struct {
	store   Store
	runs    RunStore
	starter RunStarter

	// runMu serialises making runs, so a firing and a run by hand cannot both
	// find the previous run finished and start two.
	runMu sync.Mutex

	// wake is signalled by every schedule change, so an edit reschedules the
	// wait rather than the scheduler sleeping on a stale timer.
	wake chan struct{}
	// handled is the firing (NextRunAt) each schedule was last fired for. A
	// firing whose bookkeeping could not be written is not fired again: its
	// NextRunAt stays in the past, and without this every loop would make
	// another run. Only the loop goroutine touches it.
	handled map[string]time.Time
	// started is the run each schedule last started, by schedule id. It
	// backs up LastRunWorkID for the overlap check: a run whose RecordRun could
	// not be written is still going, and the schedule's record does not name
	// it. Guarded by runMu.
	started map[string]string

	cancel context.CancelFunc
	done   chan struct{}

	now      func() time.Time
	newTimer func(d time.Duration) (<-chan time.Time, func())
	recheck  time.Duration
}

func NewScheduler(store Store, runs RunStore, starter RunStarter) *Scheduler {
	s := &Scheduler{
		store:    store,
		runs:     runs,
		starter:  starter,
		wake:     make(chan struct{}, 1),
		handled:  map[string]time.Time{},
		started:  map[string]string{},
		now:      time.Now,
		newTimer: realTimer,
		recheck:  recheckInterval,
	}
	store.AddOnChangeListener(s)
	return s
}

func realTimer(d time.Duration) (<-chan time.Time, func()) {
	t := time.NewTimer(d)
	return t.C, func() { t.Stop() }
}

// Start skips the firings missed while the server was down and begins firing.
// Call it once the work operations can start sessions.
func (s *Scheduler) Start() error {
	if err := s.store.SkipMissedRuns(context.Background()); err != nil {
		return fmt.Errorf("skip missed schedule runs: %w", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.cancel = cancel
	s.done = make(chan struct{})
	go s.loop(ctx)
	return nil
}

// Stop ends the loop and waits for a firing in progress to finish, so nothing
// is starting a session when the worktree manager shuts down.
func (s *Scheduler) Stop() {
	if s.cancel == nil {
		return
	}
	s.cancel()
	<-s.done
}

func (s *Scheduler) OnScheduleChange(ChangeEvent) {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

func (s *Scheduler) loop(ctx context.Context) {
	defer close(s.done)
	for {
		s.fireDue(ctx)
		// The changes fireDue made itself are already accounted for: the wait
		// below is computed from the store as it is now.
		select {
		case <-s.wake:
		default:
		}
		timer, stop := s.newTimer(s.untilNext())
		select {
		case <-ctx.Done():
			stop()
			return
		case <-s.wake:
			stop()
		case <-timer:
		}
	}
}

func (s *Scheduler) fireDue(ctx context.Context) {
	all, err := s.store.List()
	if err != nil {
		slog.Error("failed to list schedules", "error", err)
		return
	}
	now := s.now()
	handled := map[string]time.Time{}
	for _, sched := range all {
		// Stopping does not wait for every due schedule, only for the firing in
		// progress; the rest are missed runs to the next start.
		if ctx.Err() != nil {
			return
		}
		if !due(sched, now) {
			continue
		}
		at := *sched.NextRunAt
		if prev, ok := s.handled[sched.ID]; ok && prev.Equal(at) {
			handled[sched.ID] = at
			continue
		}
		handled[sched.ID] = at
		s.fire(ctx, sched.ID, at)
	}
	s.handled = handled
}

// untilNext is how long to wait for the earliest firing not yet handled.
func (s *Scheduler) untilNext() time.Duration {
	wait := s.recheck
	all, err := s.store.List()
	if err != nil {
		slog.Error("failed to list schedules", "error", err)
		return wait
	}
	now := s.now()
	for _, sched := range all {
		if !sched.Enabled || sched.NextRunAt == nil {
			continue
		}
		if prev, ok := s.handled[sched.ID]; ok && prev.Equal(*sched.NextRunAt) {
			continue
		}
		wait = min(wait, max(sched.NextRunAt.Sub(now), 0))
	}
	return wait
}

func due(sched Schedule, now time.Time) bool {
	return sched.Enabled && sched.NextRunAt != nil && !sched.NextRunAt.After(now)
}

// fire makes the run of schedule id due at at, or records why it made none.
func (s *Scheduler) fire(ctx context.Context, id string, at time.Time) {
	s.runMu.Lock()
	defer s.runMu.Unlock()

	// Read again under runMu: a run by hand or an edit since the list may have
	// moved the firing, and a delete may have removed the schedule.
	sched, found, err := s.store.Get(id)
	if err != nil {
		slog.Error("failed to read schedule", "scheduleId", id, "error", err)
		return
	}
	if !found || !sched.Enabled || sched.NextRunAt == nil || !sched.NextRunAt.Equal(at) {
		return
	}

	activeRun, err := s.activeRun(sched)
	if err != nil {
		s.recordFailure(ctx, sched.ID, "", err)
		return
	}
	if activeRun != "" {
		slog.Info("schedule firing skipped: previous run still active", "scheduleId", sched.ID, "workId", activeRun)
		if _, err := s.store.RecordSkip(ctx, sched.ID); err != nil {
			slog.Error("failed to record skipped schedule firing", "scheduleId", sched.ID, "error", err)
		}
		return
	}
	// A failure is already logged and recorded on the schedule by startRun;
	// there is nobody else to report it to.
	_, _ = s.startRun(ctx, sched)
}

// RunNow makes and starts a run of schedule id now, whether or not the
// schedule is enabled. It is refused with ErrRunActive while the previous run
// is still active, the same rule a firing follows; the schedule's next firing
// is unaffected unless it was already due.
func (s *Scheduler) RunNow(ctx context.Context, id string) (work.Work, error) {
	s.runMu.Lock()
	defer s.runMu.Unlock()

	sched, found, err := s.store.Get(id)
	if err != nil {
		return work.Work{}, err
	}
	if !found {
		return work.Work{}, ErrNotFound
	}
	activeRun, err := s.activeRun(sched)
	if err != nil {
		return work.Work{}, err
	}
	if activeRun != "" {
		return work.Work{}, fmt.Errorf("%w: run %s of schedule %s", ErrRunActive, activeRun, sched.ID)
	}
	return s.startRun(ctx, sched)
}

// activeRun is the id of the schedule's previous run if it is still active,
// or "" if there is none or it has finished.
// Caller holds runMu.
func (s *Scheduler) activeRun(sched Schedule) (string, error) {
	for _, id := range []string{sched.LastRunWorkID, s.started[sched.ID]} {
		if id == "" {
			continue
		}
		w, found, err := s.runs.Get(id)
		if err != nil {
			return "", fmt.Errorf("look up previous run %s: %w", id, err)
		}
		if found && w.Status == work.StatusActive {
			return w.ID, nil
		}
	}
	return "", nil
}

// startRun makes a job from sched and starts it. A failure is recorded on the
// schedule as well as returned. Caller holds runMu.
func (s *Scheduler) startRun(ctx context.Context, sched Schedule) (work.Work, error) {
	job, err := s.runs.CreateJob(ctx, work.Work{
		ScheduleID:  sched.ID,
		AgentRoleID: sched.AgentRoleID,
		Title:       sched.Title,
		Body:        sched.Prompt,
		Worktree:    sched.Worktree,
	})
	if err != nil {
		err = fmt.Errorf("create run: %w", err)
		s.recordFailure(ctx, sched.ID, "", err)
		return work.Work{}, err
	}
	started, err := s.starter.StartWork(ctx, job.ID, nil)
	if err != nil {
		err = fmt.Errorf("start run %s: %w", job.ID, err)
		s.recordFailure(ctx, sched.ID, job.ID, err)
		return work.Work{}, err
	}
	s.started[sched.ID] = job.ID
	// The run is going whatever happens to the bookkeeping, so a failure to
	// write it is logged rather than returned: reporting the run as failed
	// would invite a retry that starts a second one.
	if _, err := s.store.RecordRun(ctx, sched.ID, job.ID); err != nil {
		slog.Error("failed to record schedule run", "scheduleId", sched.ID, "workId", job.ID, "error", err)
	}
	slog.Info("schedule run started", "scheduleId", sched.ID, "workId", job.ID)
	return started, nil
}

func (s *Scheduler) recordFailure(ctx context.Context, id, workID string, cause error) {
	slog.Error("schedule run failed", "scheduleId", id, "workId", workID, "error", cause)
	if _, err := s.store.RecordFailure(ctx, id, workID, cause.Error()); err != nil {
		slog.Error("failed to record schedule run failure", "scheduleId", id, "error", err)
	}
}
