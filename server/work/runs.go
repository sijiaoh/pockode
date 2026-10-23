package work

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
)

// ErrRunActive refuses to start a job while another run of the same schedule
// is active: a schedule has at most one run going at a time, whoever asked and
// whichever run they asked for.
var ErrRunActive = errors.New("previous run is still active")

// RunRecorder notes on a schedule that one of its runs has just started.
// Satisfied by the scheduler, which owns the schedule's bookkeeping; the work
// package names it here so that it does not import the schedule package.
//
// It reports nothing back: the run is going whatever happens to the
// bookkeeping, so a failure to write it is the recorder's to log. Reporting the
// start as failed would invite a retry that starts a second run.
type RunRecorder interface {
	RecordRun(ctx context.Context, scheduleID, workID string)
}

// runGuard is the one critical section every start of a job goes through:
// the check that no other run of its schedule is active, the start itself and
// recording it as the schedule's latest run. Per schedule, so one schedule's
// slow session start does not hold up another's.
//
// It is here, on the start path every caller shares, rather than in the
// scheduler, because a job is started by hand too (work.start on a run that
// failed to start, or a Restart of a stopped one) and a check taken outside
// the scheduler's lock could race its firing into two active runs.
type runGuard struct {
	locksMu sync.Mutex
	// locks is never pruned: there is one entry per schedule ever run since
	// the server started, and a user has a handful of schedules.
	locks map[string]*sync.Mutex
}

func (g *runGuard) lock(scheduleID string) func() {
	g.locksMu.Lock()
	if g.locks == nil {
		g.locks = map[string]*sync.Mutex{}
	}
	l, ok := g.locks[scheduleID]
	if !ok {
		l = &sync.Mutex{}
		g.locks[scheduleID] = l
	}
	g.locksMu.Unlock()

	l.Lock()
	return l.Unlock
}

// SetRunRecorder installs where a started job is recorded. Left unset, jobs
// start without their schedule hearing of it, which is what the narrow tests in
// this package want; the server always sets it.
func (o *Operations) SetRunRecorder(r RunRecorder) {
	o.runs = r
}

// StartRun makes a run of schedule job.ScheduleID from job and starts it, as
// one step under the schedule's guard: no other start of the schedule can pass
// the check between the two. It is refused with ErrRunActive, before anything
// is made, while another run of the schedule is active.
//
// When the job is made but cannot be started it is returned beside the error,
// left open where a person can start it by hand; when it cannot be made, the
// returned Work is empty.
func (o *Operations) StartRun(ctx context.Context, job Work) (Work, error) {
	unlock := o.runGuard.lock(job.ScheduleID)
	defer unlock()

	if err := o.refuseIfRunActive(job.ScheduleID, ""); err != nil {
		return Work{}, err
	}
	made, err := o.store.CreateJob(ctx, job)
	if err != nil {
		return Work{}, err
	}
	started, err := o.start(ctx, made.ID, nil)
	if err != nil {
		return made, err
	}
	o.recordRun(ctx, started)
	return started, nil
}

// startJob is StartWork for a job that already exists: guarded and recorded
// exactly as a run StartRun makes.
func (o *Operations) startJob(ctx context.Context, job Work, watcher *Watcher) (Work, error) {
	unlock := o.runGuard.lock(job.ScheduleID)
	defer unlock()

	if err := o.refuseIfRunActive(job.ScheduleID, job.ID); err != nil {
		return Work{}, err
	}
	started, err := o.start(ctx, job.ID, watcher)
	if err != nil {
		return Work{}, err
	}
	o.recordRun(ctx, started)
	return started, nil
}

// reopenJob is ReopenWork for a job: reopening makes a run active again, so it
// is refused on the same terms as starting one. It is not recorded as the
// schedule's latest run — that is the latest run *started* — but the check
// reads every run, so the next firing still sees it going.
func (o *Operations) reopenJob(ctx context.Context, job Work) error {
	unlock := o.runGuard.lock(job.ScheduleID)
	defer unlock()

	if err := o.refuseIfRunActive(job.ScheduleID, job.ID); err != nil {
		return err
	}
	return o.reopen(ctx, job.ID)
}

// refuseIfRunActive reports ErrRunActive when a run of scheduleID other than
// except is active. Every run is read, not only the one the schedule names as
// its latest: a run can be active without being the latest — reopened, or
// woken by a message in its chat — and the schedule's record of its latest run
// is only as good as the last write of it.
// Caller holds the schedule's guard.
func (o *Operations) refuseIfRunActive(scheduleID, except string) error {
	runs, err := o.store.ListBySchedule(scheduleID)
	if err != nil {
		return fmt.Errorf("look up the runs of schedule %s: %w", scheduleID, err)
	}
	var active []string
	for _, run := range runs {
		if run.ID != except && run.Status == StatusActive {
			active = append(active, run.ID)
		}
	}
	if len(active) == 0 {
		return nil
	}
	return fmt.Errorf("%w: run %s of schedule %s", ErrRunActive, strings.Join(active, ", "), scheduleID)
}

func (o *Operations) recordRun(ctx context.Context, job Work) {
	if o.runs != nil {
		o.runs.RecordRun(ctx, job.ScheduleID, job.ID)
	}
}
