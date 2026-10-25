package schedule

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pockode/server/work"
)

// fakeClock hands the scheduler a clock the test moves by hand. Every timer
// the scheduler sets is published on timers, which is how a test knows the
// loop has finished what it was doing and gone back to waiting.
type fakeClock struct {
	nowMu  sync.Mutex
	now    time.Time
	timers chan fakeTimer
}

type fakeTimer struct {
	at time.Time
	c  chan time.Time
}

func (c *fakeClock) Now() time.Time {
	c.nowMu.Lock()
	defer c.nowMu.Unlock()
	return c.now
}

func (c *fakeClock) set(t time.Time) {
	c.nowMu.Lock()
	defer c.nowMu.Unlock()
	c.now = t
}

func (c *fakeClock) newTimer(d time.Duration) (<-chan time.Time, func()) {
	t := fakeTimer{at: c.Now().Add(d), c: make(chan time.Time, 1)}
	c.timers <- t
	return t.c, func() {}
}

// starter records the works it is asked to start and fails when told to.
type starter struct {
	startedMu sync.Mutex
	started   []string
	fail      error
}

func (s *starter) HandleWorkStart(_ context.Context, w work.Work) error {
	s.startedMu.Lock()
	defer s.startedMu.Unlock()
	if s.fail != nil {
		return s.fail
	}
	s.started = append(s.started, w.ID)
	return nil
}

func (s *starter) count() int {
	s.startedMu.Lock()
	defer s.startedMu.Unlock()
	return len(s.started)
}

// failingRuns is a work store that cannot make a run.
type failingRuns struct {
	work.Store
	err error
}

func (f failingRuns) CreateJob(context.Context, work.Work) (work.Work, error) {
	return work.Work{}, f.err
}

// unrecordedRuns is a schedule store that cannot write a run down.
type unrecordedRuns struct {
	Store
}

func (unrecordedRuns) RecordRun(context.Context, string, string) (Schedule, error) {
	return Schedule{}, errors.New("disk full")
}

type schedulerEnv struct {
	*testEnv
	clock     *fakeClock
	works     *work.FileStore
	ops       *work.Operations
	starter   *starter
	scheduler *Scheduler
}

func newSchedulerEnv(t *testing.T) *schedulerEnv {
	t.Helper()
	env := &schedulerEnv{testEnv: newTestEnv(t), starter: &starter{}}
	env.clock = &fakeClock{now: env.testEnv.clock, timers: make(chan fakeTimer, 16)}
	env.store.now = env.clock.Now

	works, err := work.NewFileStore(env.dataDir)
	if err != nil {
		t.Fatalf("work.NewFileStore: %v", err)
	}
	env.works = works
	env.ops = work.NewOperations(works, env.starter, nil, nil)

	env.scheduler = NewScheduler(env.store, env.ops)
	env.ops.SetRunRecorder(env.scheduler)
	env.scheduler.now = env.clock.Now
	env.scheduler.newTimer = env.clock.newTimer
	// Far enough out that every timer the loop sets is for a real firing.
	env.scheduler.recheck = 365 * 24 * time.Hour
	return env
}

func (env *schedulerEnv) get(t *testing.T, id string) Schedule {
	t.Helper()
	s, found, err := env.store.Get(id)
	if err != nil || !found {
		t.Fatalf("Get %s: found=%v err=%v", id, found, err)
	}
	return s
}

func (env *schedulerEnv) runs(t *testing.T, id string) []work.Work {
	t.Helper()
	runs, err := env.works.ListBySchedule(id)
	if err != nil {
		t.Fatalf("ListBySchedule: %v", err)
	}
	return runs
}

// fireAt moves the clock to t and fires whatever is due then, as the loop
// does when its timer goes off.
func (env *schedulerEnv) fireAt(t time.Time) {
	env.clock.set(t)
	env.scheduler.fireDue(bgCtx)
}

// nextTimer waits for the loop to set its next timer.
func (env *schedulerEnv) nextTimer(t *testing.T) fakeTimer {
	t.Helper()
	select {
	case timer := <-env.clock.timers:
		return timer
	case <-time.After(5 * time.Second):
		t.Fatal("the scheduler set no timer")
		return fakeTimer{}
	}
}

func day(d, hour, minute int) time.Time {
	return time.Date(2026, 1, d, hour, minute, 0, 0, time.UTC)
}

func TestFire_MakesAndStartsAJobAndAdvances(t *testing.T) {
	env := newSchedulerEnv(t)
	in := env.valid()
	in.Worktree = "feature"
	s := env.create(t, in)

	env.fireAt(day(1, 8, 59))
	if runs := env.runs(t, s.ID); len(runs) != 0 {
		t.Fatalf("runs before the firing = %v, want none", runs)
	}

	env.fireAt(day(1, 9, 0))
	runs := env.runs(t, s.ID)
	if len(runs) != 1 {
		t.Fatalf("runs = %v, want one", runs)
	}
	run := runs[0]
	if run.Title != in.Title || run.Body != in.Prompt || run.AgentRoleID != in.AgentRoleID || run.Worktree != "feature" {
		t.Errorf("run = %+v, want it made from the schedule", run)
	}
	if run.Status != work.StatusActive || run.SessionID == "" || env.starter.count() != 1 {
		t.Errorf("run status=%s session=%q starts=%d, want it started", run.Status, run.SessionID, env.starter.count())
	}
	got := env.get(t, s.ID)
	if got.LastRunWorkID != run.ID || !sameTime(got.NextRunAt, at(day(2, 9, 0))) {
		t.Errorf("schedule = %+v, want the run recorded and next run tomorrow", got)
	}

	// Firing again at the same moment makes nothing: the firing has moved on.
	env.scheduler.fireDue(bgCtx)
	if runs := env.runs(t, s.ID); len(runs) != 1 {
		t.Errorf("runs after a second look = %d, want 1", len(runs))
	}
}

func TestFire_SkipsWhileThePreviousRunIsActive(t *testing.T) {
	env := newSchedulerEnv(t)
	s := env.create(t, env.valid())

	env.fireAt(day(1, 9, 0))
	first := env.get(t, s.ID).LastRunWorkID

	env.fireAt(day(2, 9, 0))
	got := env.get(t, s.ID)
	if runs := env.runs(t, s.ID); len(runs) != 1 {
		t.Fatalf("runs = %d, want the firing skipped", len(runs))
	}
	if !sameTime(got.LastSkippedAt, at(day(2, 9, 0))) || got.LastRunWorkID != first || !sameTime(got.NextRunAt, at(day(3, 9, 0))) {
		t.Errorf("schedule = %+v, want the skip recorded and next run the day after", got)
	}

	if err := env.works.Stop(bgCtx, first); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	env.fireAt(day(3, 9, 0))
	if runs := env.runs(t, s.ID); len(runs) != 2 {
		t.Errorf("runs = %d once the previous run is no longer active, want 2", len(runs))
	}
}

func TestFire_DisabledDoesNotFire(t *testing.T) {
	env := newSchedulerEnv(t)
	in := env.valid()
	in.Enabled = false
	s := env.create(t, in)

	env.fireAt(day(5, 9, 0))
	if runs := env.runs(t, s.ID); len(runs) != 0 {
		t.Errorf("runs = %v, want none from a disabled schedule", runs)
	}
}

func TestFire_StartFailureIsRecorded(t *testing.T) {
	env := newSchedulerEnv(t)
	s := env.create(t, env.valid())
	env.starter.fail = errors.New("worktree not found")

	env.fireAt(day(1, 9, 0))
	runs := env.runs(t, s.ID)
	if len(runs) != 1 || runs[0].Status != work.StatusOpen {
		t.Fatalf("runs = %+v, want one job left open", runs)
	}
	got := env.get(t, s.ID)
	if got.LastFailure == nil || got.LastFailure.WorkID != runs[0].ID || got.LastFailure.Error == "" {
		t.Errorf("failure = %+v, want the job that failed to start and why", got.LastFailure)
	}
	if got.LastRunWorkID != "" || !sameTime(got.NextRunAt, at(day(2, 9, 0))) {
		t.Errorf("schedule = %+v, want no run recorded and next run tomorrow", got)
	}
}

func TestFire_CreateFailureIsRecorded(t *testing.T) {
	env := newSchedulerEnv(t)
	s := env.create(t, env.valid())
	ops := work.NewOperations(failingRuns{Store: env.works, err: errors.New("disk full")}, env.starter, nil, nil)
	ops.SetRunRecorder(env.scheduler)
	env.scheduler.starter = ops

	env.fireAt(day(1, 9, 0))
	if runs := env.runs(t, s.ID); len(runs) != 0 {
		t.Fatalf("runs = %v, want none", runs)
	}
	got := env.get(t, s.ID)
	if got.LastFailure == nil || got.LastFailure.WorkID != "" || !strings.Contains(got.LastFailure.Error, "disk full") {
		t.Errorf("failure = %+v, want the cause with no job", got.LastFailure)
	}
}

func TestRunNow(t *testing.T) {
	env := newSchedulerEnv(t)
	in := env.valid()
	in.Enabled = false
	s := env.create(t, in)

	run, err := env.scheduler.RunNow(bgCtx, s.ID)
	if err != nil {
		t.Fatalf("RunNow on a disabled schedule: %v", err)
	}
	if run.ScheduleID != s.ID || run.Status != work.StatusActive {
		t.Errorf("run = %+v, want an active job of the schedule", run)
	}
	got := env.get(t, s.ID)
	if got.LastRunWorkID != run.ID || got.NextRunAt != nil {
		t.Errorf("schedule = %+v, want the run recorded and still no next run", got)
	}

	if _, err := env.scheduler.RunNow(bgCtx, s.ID); !errors.Is(err, work.ErrRunActive) {
		t.Errorf("RunNow while the run is active: err = %v, want ErrRunActive", err)
	}
	if runs := env.runs(t, s.ID); len(runs) != 1 {
		t.Errorf("runs = %d, want the refused run not made", len(runs))
	}

	if _, err := env.scheduler.RunNow(bgCtx, "missing"); !errors.Is(err, ErrNotFound) {
		t.Errorf("RunNow on a missing schedule: err = %v, want ErrNotFound", err)
	}
}

func TestStart_SkipsMissedRuns(t *testing.T) {
	env := newSchedulerEnv(t)
	s := env.create(t, env.valid())

	// The server comes back three days after the schedule was due.
	env.clock.set(day(4, 12, 0))
	if err := env.scheduler.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer env.scheduler.Stop()

	if timer := env.nextTimer(t); !timer.at.Equal(day(5, 9, 0)) {
		t.Errorf("first timer at %v, want the next firing after now", timer.at)
	}
	if runs := env.runs(t, s.ID); len(runs) != 0 {
		t.Errorf("runs = %v, want the missed firings not caught up", runs)
	}
}

func TestLoop_FiresOnTimeAndFollowsEdits(t *testing.T) {
	env := newSchedulerEnv(t)
	s := env.create(t, env.valid())
	if err := env.scheduler.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer env.scheduler.Stop()

	if timer := env.nextTimer(t); !timer.at.Equal(day(1, 9, 0)) {
		t.Fatalf("timer at %v, want 09:00", timer.at)
	}

	// An edit moves the wait without the old timer going off.
	if _, err := env.store.Update(bgCtx, s.ID, UpdateFields{Period: &Period{Kind: PeriodDaily, Time: "08:30"}}); err != nil {
		t.Fatalf("Update: %v", err)
	}
	timer := env.nextTimer(t)
	if !timer.at.Equal(day(1, 8, 30)) {
		t.Fatalf("timer after the edit at %v, want 08:30", timer.at)
	}

	env.clock.set(timer.at)
	timer.c <- timer.at
	if next := env.nextTimer(t); !next.at.Equal(day(2, 8, 30)) {
		t.Errorf("timer after the firing at %v, want tomorrow 08:30", next.at)
	}
	if runs := env.runs(t, s.ID); len(runs) != 1 {
		t.Errorf("runs = %d, want the firing made one", len(runs))
	}

	disabled := false
	if _, err := env.store.Update(bgCtx, s.ID, UpdateFields{Enabled: &disabled}); err != nil {
		t.Fatalf("Update: %v", err)
	}
	if next := env.nextTimer(t); !next.at.Equal(env.clock.Now().Add(env.scheduler.recheck)) {
		t.Errorf("timer after disabling at %v, want only the recheck", next.at)
	}
}

func TestRunNow_RefusedWhileAnUnrecordedRunIsActive(t *testing.T) {
	env := newSchedulerEnv(t)
	s := env.create(t, env.valid())
	env.scheduler.store = unrecordedRuns{Store: env.store}

	env.fireAt(day(1, 9, 0))
	if got := env.get(t, s.ID); got.LastRunWorkID != "" {
		t.Fatalf("LastRunWorkID = %q, want the run left unrecorded", got.LastRunWorkID)
	}
	if runs := env.runs(t, s.ID); len(runs) != 1 {
		t.Fatalf("runs = %d, want the firing to have started one", len(runs))
	}

	if _, err := env.scheduler.RunNow(bgCtx, s.ID); !errors.Is(err, work.ErrRunActive) {
		t.Errorf("RunNow: err = %v, want ErrRunActive for the run the schedule does not name", err)
	}
	if runs := env.runs(t, s.ID); len(runs) != 1 {
		t.Errorf("runs = %d, want no second run alongside the first", len(runs))
	}
}

// countingRuns is a schedule store that counts the runs written down.
type countingRuns struct {
	Store
	recordedMu sync.Mutex
	recorded   []string
}

func (c *countingRuns) RecordRun(ctx context.Context, id string, workID string) (Schedule, error) {
	c.recordedMu.Lock()
	c.recorded = append(c.recorded, workID)
	c.recordedMu.Unlock()
	return c.Store.RecordRun(ctx, id, workID)
}

func TestFire_RecordsTheRunOnce(t *testing.T) {
	env := newSchedulerEnv(t)
	s := env.create(t, env.valid())
	counting := &countingRuns{Store: env.store}
	env.scheduler.store = counting

	env.fireAt(day(1, 9, 0))
	runs := env.runs(t, s.ID)
	if len(runs) != 1 {
		t.Fatalf("runs = %d, want 1", len(runs))
	}
	if len(counting.recorded) != 1 || counting.recorded[0] != runs[0].ID {
		t.Errorf("recorded = %v, want the one run recorded once", counting.recorded)
	}
}

// A run that failed to start is left open for a person to start; starting it
// is a run like any other, so the schedule records it and the next firing sees
// it going.
func TestStartWork_AJobThatFailedToStartIsRecordedWhenStartedByHand(t *testing.T) {
	env := newSchedulerEnv(t)
	s := env.create(t, env.valid())
	env.starter.fail = errors.New("worktree not found")
	env.fireAt(day(1, 9, 0))
	failed := env.get(t, s.ID).LastFailure
	if failed == nil || failed.WorkID == "" {
		t.Fatalf("failure = %+v, want the job that failed to start", failed)
	}

	env.starter.fail = nil
	if _, err := env.ops.StartWork(bgCtx, failed.WorkID, nil); err != nil {
		t.Fatalf("StartWork: %v", err)
	}
	got := env.get(t, s.ID)
	if got.LastFailure != nil || got.LastRunWorkID != failed.WorkID {
		t.Errorf("schedule = %+v, want the failure cleared and the job recorded as the latest run", got)
	}

	env.fireAt(day(2, 9, 0))
	if runs := env.runs(t, s.ID); len(runs) != 1 {
		t.Errorf("runs = %d, want the firing skipped while the job started by hand runs", len(runs))
	}
	if got := env.get(t, s.ID); !sameTime(got.LastSkippedAt, at(day(2, 9, 0))) {
		t.Errorf("LastSkippedAt = %v, want the firing recorded as skipped", got.LastSkippedAt)
	}
}

func TestStartWork_AnOlderRunIsRefusedWhileAnotherIsActive(t *testing.T) {
	env := newSchedulerEnv(t)
	s := env.create(t, env.valid())
	env.fireAt(day(1, 9, 0))
	older := env.get(t, s.ID).LastRunWorkID
	if err := env.works.Stop(bgCtx, older); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	env.fireAt(day(2, 9, 0))
	latest := env.get(t, s.ID).LastRunWorkID

	if _, err := env.ops.StartWork(bgCtx, older, nil); !errors.Is(err, work.ErrRunActive) {
		t.Fatalf("restarting the older run: err = %v, want ErrRunActive", err)
	}
	if got := env.get(t, s.ID); got.LastRunWorkID != latest {
		t.Errorf("LastRunWorkID = %s, want the refused restart not recorded", got.LastRunWorkID)
	}

	// Once nothing else is going, the restart is a run and becomes the latest.
	if err := env.works.Stop(bgCtx, latest); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	if _, err := env.ops.StartWork(bgCtx, older, nil); err != nil {
		t.Fatalf("restarting the older run once nothing is active: %v", err)
	}
	if got := env.get(t, s.ID); got.LastRunWorkID != older {
		t.Errorf("LastRunWorkID = %s, want the restarted run %s", got.LastRunWorkID, older)
	}
}

func TestReopenWork_AClosedRunIsRefusedWhileAnotherIsActive(t *testing.T) {
	env := newSchedulerEnv(t)
	s := env.create(t, env.valid())
	env.fireAt(day(1, 9, 0))
	older := env.get(t, s.ID).LastRunWorkID
	if _, _, err := env.ops.StepDone(bgCtx, older); err != nil {
		t.Fatalf("StepDone: %v", err)
	}
	env.fireAt(day(2, 9, 0))

	if err := env.ops.ReopenWork(bgCtx, older); !errors.Is(err, work.ErrRunActive) {
		t.Fatalf("ReopenWork: err = %v, want ErrRunActive", err)
	}
	if w, _, _ := env.works.Get(older); w.Status != work.StatusClosed {
		t.Errorf("older run status = %s, want it left closed", w.Status)
	}
}

// A run made active some other way than being started — here reopened while
// nothing else was going — is not the schedule's latest run, and is still the
// run a firing must not start a second one beside.
func TestFire_SkipsWhileARunThatIsNotTheLatestIsActive(t *testing.T) {
	env := newSchedulerEnv(t)
	s := env.create(t, env.valid())
	env.fireAt(day(1, 9, 0))
	older := env.get(t, s.ID).LastRunWorkID
	if _, _, err := env.ops.StepDone(bgCtx, older); err != nil {
		t.Fatalf("StepDone: %v", err)
	}
	env.fireAt(day(2, 9, 0))
	latest := env.get(t, s.ID).LastRunWorkID
	if _, _, err := env.ops.StepDone(bgCtx, latest); err != nil {
		t.Fatalf("StepDone: %v", err)
	}
	if err := env.ops.ReopenWork(bgCtx, older); err != nil {
		t.Fatalf("ReopenWork: %v", err)
	}

	env.fireAt(day(3, 9, 0))
	if runs := env.runs(t, s.ID); len(runs) != 2 {
		t.Errorf("runs = %d, want the firing skipped beside the reopened run", len(runs))
	}
}

// overtakingStarter starts a run by hand just before the firing's own start
// reaches the guard: the order a work.start wins when it lands while a firing
// is between reading its schedule and starting.
type overtakingStarter struct {
	ops    *work.Operations
	byHand string
}

func (o overtakingStarter) StartRun(ctx context.Context, job work.Work) (work.Work, error) {
	if _, err := o.ops.StartWork(ctx, o.byHand, nil); err != nil {
		return work.Work{}, err
	}
	return o.ops.StartRun(ctx, job)
}

func TestFire_OvertakenByARunStartedByHandIsNotASkip(t *testing.T) {
	env := newSchedulerEnv(t)
	s := env.create(t, env.valid())
	env.fireAt(day(1, 9, 0))
	older := env.get(t, s.ID).LastRunWorkID
	if err := env.works.Stop(bgCtx, older); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	env.scheduler.starter = overtakingStarter{ops: env.ops, byHand: older}

	env.fireAt(day(2, 9, 0))
	got := env.get(t, s.ID)
	if got.LastSkippedAt != nil {
		t.Errorf("LastSkippedAt = %v, want no skip: the run started by hand is the firing's run", got.LastSkippedAt)
	}
	if got.LastRunWorkID != older || !sameTime(got.NextRunAt, at(day(3, 9, 0))) {
		t.Errorf("schedule = %+v, want the run by hand recorded and the firing moved on", got)
	}
	if runs := env.runs(t, s.ID); len(runs) != 1 {
		t.Errorf("runs = %d, want no second run", len(runs))
	}
}

// The guard is what keeps a start by hand and a Run now from both passing the
// check; racing them must always end with exactly one run going.
func TestStartWork_RacingRunNowLeavesOneRunActive(t *testing.T) {
	for i := range 20 {
		env := newSchedulerEnv(t)
		s := env.create(t, env.valid())
		first, err := env.scheduler.RunNow(bgCtx, s.ID)
		if err != nil {
			t.Fatalf("RunNow: %v", err)
		}
		if err := env.works.Stop(bgCtx, first.ID); err != nil {
			t.Fatalf("Stop: %v", err)
		}

		var wg sync.WaitGroup
		wg.Add(2)
		go func() { defer wg.Done(); _, _ = env.ops.StartWork(bgCtx, first.ID, nil) }()
		go func() { defer wg.Done(); _, _ = env.scheduler.RunNow(bgCtx, s.ID) }()
		wg.Wait()

		var active []string
		for _, run := range env.runs(t, s.ID) {
			if run.Status == work.StatusActive {
				active = append(active, run.ID)
			}
		}
		if len(active) != 1 {
			t.Fatalf("attempt %d: active runs = %v, want exactly one", i, active)
		}
		if got := env.get(t, s.ID).LastRunWorkID; got != active[0] {
			t.Fatalf("attempt %d: LastRunWorkID = %s, want the active run %s", i, got, active[0])
		}
	}
}

func TestRecordRun_ARunOfADeletedScheduleIsNotAFailure(t *testing.T) {
	env := newSchedulerEnv(t)
	s := env.create(t, env.valid())
	run, err := env.scheduler.RunNow(bgCtx, s.ID)
	if err != nil {
		t.Fatalf("RunNow: %v", err)
	}
	if err := env.works.Stop(bgCtx, run.ID); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	if err := env.store.Delete(bgCtx, s.ID); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err := env.ops.StartWork(bgCtx, run.ID, nil); err != nil {
		t.Errorf("restarting a run of a deleted schedule: %v", err)
	}
}

func TestLoop_OnceFiresOnceAndIsDone(t *testing.T) {
	env := newSchedulerEnv(t) // 2026-01-01 08:00 UTC
	in := env.valid()
	in.Period = Period{Kind: PeriodOnce, At: "2026-01-01T09:00"}
	s := env.create(t, in)
	if err := env.scheduler.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer env.scheduler.Stop()

	timer := env.nextTimer(t)
	if !timer.at.Equal(day(1, 9, 0)) {
		t.Fatalf("timer at %v, want 09:00", timer.at)
	}
	env.clock.set(timer.at)
	timer.c <- timer.at
	if next := env.nextTimer(t); !next.at.Equal(env.clock.Now().Add(env.scheduler.recheck)) {
		t.Errorf("timer after the firing at %v, want only the recheck", next.at)
	}
	if runs := env.runs(t, s.ID); len(runs) != 1 {
		t.Errorf("runs = %d, want one", len(runs))
	}
	if got := env.get(t, s.ID); !got.Enabled || got.NextRunAt != nil {
		t.Errorf("schedule = %+v, want it done: enabled with no next run", got)
	}
}

func TestStart_CatchesUpAMissedOnce(t *testing.T) {
	env := newSchedulerEnv(t)
	in := env.valid()
	in.Period = Period{Kind: PeriodOnce, At: "2026-01-01T09:00"}
	s := env.create(t, in)

	env.clock.set(day(4, 12, 0))
	if err := env.scheduler.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer env.scheduler.Stop()

	env.nextTimer(t)
	if runs := env.runs(t, s.ID); len(runs) != 1 {
		t.Errorf("runs = %d, want the missed one-time run made on start", len(runs))
	}
	if got := env.get(t, s.ID); got.NextRunAt != nil {
		t.Errorf("next run = %v, want none: done", got.NextRunAt)
	}
}
