// Package schedule stores the schedules that start job works: a fixed prompt,
// the agent role that runs it and the period that says when.
package schedule

import (
	"errors"
	"time"
)

var (
	ErrNotFound = errors.New("schedule not found")
	// ErrInvalidSchedule marks the caller's mistake: a missing field, a
	// malformed period, a one-time run in the past, a role that does not take
	// jobs.
	ErrInvalidSchedule = errors.New("invalid schedule")
)

type Schedule struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	// Prompt is what every run is asked to do; it becomes the job's body.
	Prompt      string `json:"prompt"`
	AgentRoleID string `json:"agent_role_id"`
	Period      Period `json:"period"`
	// TimeZone is the IANA name (such as "Asia/Tokyo") of the zone whose wall
	// clock Period is read on. It belongs to the schedule rather than to the
	// server, which may be a machine in another zone than the person who wrote
	// "09:00"; it changes only when it is set explicitly.
	TimeZone string `json:"time_zone"`
	Enabled  bool   `json:"enabled"`
	// Worktree the runs are made in (empty = main).
	Worktree string `json:"worktree,omitempty"`

	// NextRunAt is when the schedule fires next; nil when it is disabled, and
	// when it is done: a once period whose firing has been made (run, failed
	// or skipped). A recurring period always has a next run, so an enabled
	// once schedule without one is done; anything else enabled without one is
	// a hand-edited index whose period or zone cannot be read (reschedule).
	// The store keeps it in the future of every change it makes — creating,
	// enabling or re-timing a schedule, recording a firing, SkipMissedRuns —
	// with one exception: SkipMissedRuns leaves a once period's missed firing
	// due, so that it is made late rather than never.
	NextRunAt *time.Time `json:"next_run_at,omitempty"`
	// LastRunAt and LastRunWorkID describe the latest run started, whether by
	// the schedule firing or by hand.
	LastRunAt     *time.Time `json:"last_run_at,omitempty"`
	LastRunWorkID string     `json:"last_run_work_id,omitempty"`
	// LastSkippedAt is the latest firing that made no run because the previous
	// run was still active. It is earlier than LastRunAt once a later run has
	// been made, which is how a reader tells a skip that still matters from one
	// that has since been followed by a run.
	LastSkippedAt *time.Time `json:"last_skipped_at,omitempty"`
	// LastFailure is the latest run that could not be made or started. A run
	// started after it clears it, so while it is set it is the schedule's
	// current state: its last attempt failed.
	LastFailure *RunFailure `json:"last_failure,omitempty"`

	CreatedAt time.Time `json:"created_at"`
	// UpdatedAt moves with edits to the schedule's own settings, not with its
	// run bookkeeping.
	UpdatedAt time.Time `json:"updated_at"`
}

// RunFailure is a run that could not be made or started.
type RunFailure struct {
	At time.Time `json:"at"`
	// WorkID is the job that was made but failed to start; empty when the job
	// could not even be made. A job that failed to start is left open, where a
	// person can start it by hand.
	WorkID string `json:"work_id,omitempty"`
	Error  string `json:"error"`
}

type Operation string

const (
	OperationCreate Operation = "create"
	OperationUpdate Operation = "update"
	OperationDelete Operation = "delete"
)

type ChangeEvent struct {
	Op       Operation
	Schedule Schedule
}

// OnChangeListener receives notifications when schedules change.
//
// Contract: OnScheduleChange is called outside the store's mutex, but
// listeners that call back into the store MUST do so in a separate goroutine
// to avoid re-entrant deadlock.
type OnChangeListener interface {
	OnScheduleChange(event ChangeEvent)
}
