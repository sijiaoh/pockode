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

// RunStarter makes and starts a run, refusing with work.ErrRunActive while
// another run of the schedule is active, and records it on the schedule through
// the RunRecorder it was given. Satisfied by work.Operations, so a run is
// started exactly as any other work is — and through the same guard a run
// started by hand goes through.
type RunStarter interface {
	StartRun(ctx context.Context, job work.Work) (work.Work, error)
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
	starter RunStarter

	// runMu serialises the scheduler's own decisions to run, so a firing re-reads
	// a schedule after a Run now has moved its firing on. A work.start by hand
	// does not take it; fire looks again when refused instead (stoodDown).
	// Keeping two runs from going at once is not its job: that is the starter's
	// guard, which every start of a job goes through.
	runMu sync.Mutex

	// wake is signalled by every schedule change, so an edit reschedules the
	// wait rather than the scheduler sleeping on a stale timer.
	wake chan struct{}
	// handled is the firing (NextRunAt) each schedule was last fired for. A
	// firing whose bookkeeping could not be written is not fired again: its
	// NextRunAt stays in the past, and without this every loop would make
	// another run. Only the loop goroutine touches it.
	handled map[string]time.Time

	cancel context.CancelFunc
	done   chan struct{}

	now      func() time.Time
	newTimer func(d time.Duration) (<-chan time.Time, func())
	recheck  time.Duration
}

// NewScheduler builds the scheduler. The starter is expected to record the
// runs it starts on the scheduler (work.Operations.SetRunRecorder).
func NewScheduler(store Store, starter RunStarter) *Scheduler {
	s := &Scheduler{
		store:    store,
		starter:  starter,
		wake:     make(chan struct{}, 1),
		handled:  map[string]time.Time{},
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

	_, err = s.startRun(ctx, sched)
	if errors.Is(err, work.ErrRunActive) {
		if s.stoodDown(sched.ID, at) {
			return
		}
		slog.Info("schedule firing skipped: previous run still active", "scheduleId", sched.ID, "error", err)
		if _, err := s.store.RecordSkip(ctx, sched.ID); err != nil {
			slog.Error("failed to record skipped schedule firing", "scheduleId", sched.ID, "error", err)
		}
	}
	// Any other failure is already logged and recorded on the schedule by
	// startRun; there is nobody else to report it to.
}

// stoodDown reports whether a firing refused for an active run was overtaken
// rather than skipped: a run started by hand while the firing waited for the
// starter's guard was recorded, which moved the firing on. That run is the
// firing's run, and recording a skip beside it would say one was missed.
func (s *Scheduler) stoodDown(id string, at time.Time) bool {
	sched, found, err := s.store.Get(id)
	if err != nil {
		slog.Error("failed to read schedule", "scheduleId", id, "error", err)
		return false
	}
	return !found || sched.NextRunAt == nil || !sched.NextRunAt.Equal(at)
}

// RunNow makes and starts a run of schedule id now, whether or not the
// schedule is enabled. It is refused with work.ErrRunActive while another run
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
	return s.startRun(ctx, sched)
}

// startRun makes a job from sched and starts it. A failure other than the
// refusal of an active run is recorded on the schedule as well as returned.
// Caller holds runMu.
func (s *Scheduler) startRun(ctx context.Context, sched Schedule) (work.Work, error) {
	started, err := s.starter.StartRun(ctx, work.Work{
		ScheduleID:  sched.ID,
		AgentRoleID: sched.AgentRoleID,
		Title:       sched.Title,
		Body:        sched.Prompt,
		Worktree:    sched.Worktree,
	})
	switch {
	case errors.Is(err, work.ErrRunActive):
		return work.Work{}, err
	case err != nil && started.ID == "":
		err = fmt.Errorf("create run: %w", err)
		s.recordFailure(ctx, sched.ID, "", err)
		return work.Work{}, err
	case err != nil:
		err = fmt.Errorf("start run %s: %w", started.ID, err)
		s.recordFailure(ctx, sched.ID, started.ID, err)
		return work.Work{}, err
	}
	slog.Info("schedule run started", "scheduleId", sched.ID, "workId", started.ID)
	return started, nil
}

// RecordRun implements work.RunRecorder: every job that starts, fired or by
// hand, is recorded here as its schedule's latest run. A run of a deleted
// schedule has nothing to be recorded on — deleting a schedule keeps its runs,
// and they can still be started — so that is not a failure.
func (s *Scheduler) RecordRun(ctx context.Context, scheduleID, workID string) {
	if _, err := s.store.RecordRun(ctx, scheduleID, workID); errors.Is(err, ErrNotFound) {
		slog.Debug("run started for a deleted schedule", "scheduleId", scheduleID, "workId", workID)
	} else if err != nil {
		slog.Error("failed to record schedule run", "scheduleId", scheduleID, "workId", workID, "error", err)
	}
}

func (s *Scheduler) recordFailure(ctx context.Context, id, workID string, cause error) {
	slog.Error("schedule run failed", "scheduleId", id, "workId", workID, "error", cause)
	if _, err := s.store.RecordFailure(ctx, id, workID, cause.Error()); err != nil {
		slog.Error("failed to record schedule run failure", "scheduleId", id, "error", err)
	}
}
