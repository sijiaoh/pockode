package work

import (
	"context"
	"fmt"
	"log/slog"
)

// Notifier delivers the agent-facing follow-up messages that accompany a work
// transition. Satisfied by the Engine.
type Notifier interface {
	NotifyReopen(w Work)
	NotifyStepDone(w Work)
}

// StepCounter reports how many steps a work's role defines. Satisfied by the
// agent role store adapter; the work package uses it to avoid importing
// agentrole.
type StepCounter interface {
	GetSteps(agentRoleID string) ([]string, error)
}

// Operations is the whole command surface of a work item: the six things a
// person or an agent can ask for, each with its store transition and its
// agent-facing side effects.
//
// Both transports go through it — the WebSocket handler (user actions) and the
// MCP Executor (AI actions) — so a user-triggered command and an AI-triggered
// one are the same command and cannot drift apart. That is not a tidiness
// argument: the two entry points had separate implementations of stop and of
// needs_input, and each bug found in one had to be found again in the other.
//
// What is deliberately *not* here is process termination. A work leaving active
// is what takes its session's lease away, and that is hung on the transition
// itself (Engine.enforceSessionLease) so that the rule holds for the engine's
// own stops as much as for a user's.
type Operations struct {
	store    Store
	starter  WorkStartHandler
	notifier Notifier
	steps    StepCounter
}

// NewOperations builds an Operations. A nil notifier is tolerated (the reopen
// and step-advance nudges are then skipped) for narrow tests where no session is
// live; a nil steps counter makes every work stepless, which closes it on the
// first step_done.
func NewOperations(store Store, starter WorkStartHandler, notifier Notifier, steps StepCounter) *Operations {
	return &Operations{store: store, starter: starter, notifier: notifier, steps: steps}
}

// StartWork claims a work item and launches its agent session. It transitions
// the work to active with a session ID, then creates the session and sends the
// kickoff (or restart) message via the WorkStartHandler. On handler failure the
// claim is rolled back so the work never gets stuck active with a dangling
// session. The returned Work is the claimed item.
func (o *Operations) StartWork(ctx context.Context, id string) (Work, error) {
	// Precondition: a startable work must have an agent role. Checked before the
	// claim; a stale read here is harmless (worst case a rare spurious reject),
	// unlike the status/session decision which Claim makes under the store lock.
	current, found, err := o.store.Get(id)
	if err != nil {
		return Work{}, err
	}
	if !found {
		return Work{}, ErrWorkNotFound
	}
	if current.AgentRoleID == "" {
		return Work{}, fmt.Errorf("%w: work %s has no agent_role_id", ErrInvalidWork, id)
	}

	// Detach from the caller's context: an HTTP request timeout or a disconnected
	// client/AI CLI must not cancel session creation midway, which would orphan a
	// half-created session. The claim and kickoff run to completion regardless.
	startCtx := context.WithoutCancel(ctx)
	w, restart, err := o.store.Claim(startCtx, id)
	if err != nil {
		return Work{}, err
	}
	if err := o.starter.HandleWorkStart(startCtx, w); err != nil {
		if rbErr := o.store.RollbackStart(startCtx, id, w.SessionID, restart); rbErr != nil {
			slog.Error("failed to rollback work start", "workId", id, "restart", restart, "error", rbErr)
		}
		return Work{}, err
	}
	return w, nil
}

// StopWork hands a work item back to a person. The process behind it ends with
// the transition, which is what "the engine does not touch it" means for the
// machine as well as for the model.
func (o *Operations) StopWork(ctx context.Context, id string) error {
	return o.store.Stop(ctx, id)
}

// ReopenWork transitions a closed work item back to active and delivers the
// reopen nudge to its agent session.
func (o *Operations) ReopenWork(ctx context.Context, id string) error {
	if err := o.store.Reopen(ctx, id); err != nil {
		return err
	}
	if o.notifier != nil {
		if w, found, err := o.store.Get(id); err == nil && found {
			o.notifier.NotifyReopen(w)
		}
	}
	return nil
}

// StepDone marks the current step complete: the work advances to the next step,
// or closes if that was the last one.
//
// It reports whether more steps remain and how many the work's role defines, so
// the caller can tell the agent which of the two happened and where it is. The
// count is returned rather than looked up again by the caller because it is the
// number this call actually used — a role edited in between would otherwise make
// the answer describe a different work than the one that moved.
func (o *Operations) StepDone(ctx context.Context, id string) (hasMoreSteps bool, totalSteps int, err error) {
	totalSteps, err = o.stepCount(id)
	if err != nil {
		return false, 0, err
	}

	hasMoreSteps, err = o.store.StepDone(ctx, id, totalSteps)
	if err != nil {
		return false, totalSteps, err
	}
	if !hasMoreSteps || o.notifier == nil {
		return hasMoreSteps, totalSteps, nil
	}

	// Re-read: the step index the next-step prompt is built from is the advanced
	// one, and only the store knows what it advanced to.
	if w, found, getErr := o.store.Get(id); getErr == nil && found {
		o.notifier.NotifyStepDone(w)
	}
	return hasMoreSteps, totalSteps, nil
}

// NeedsInput parks a work on the user, in the agent's own words. The reason is
// shown verbatim on the work's detail page — it is the only place the user can
// read what the agent actually wants.
func (o *Operations) NeedsInput(ctx context.Context, id, reason string) error {
	return o.store.SetWait(ctx, id, WaitUser, reason)
}

// Wait parks a work on its children. Same shape as NeedsInput and deliberately
// so: the two differ in who clears the wait, not in what waiting is.
func (o *Operations) Wait(ctx context.Context, id, reason string) error {
	return o.store.SetWait(ctx, id, WaitChild, reason)
}

// stepCount reports how many steps the work's role defines. A work whose role
// has none is stepless, and its first step_done closes it.
func (o *Operations) stepCount(id string) (int, error) {
	if o.steps == nil {
		return 0, nil
	}
	w, found, err := o.store.Get(id)
	if err != nil {
		return 0, err
	}
	if !found {
		return 0, ErrWorkNotFound
	}
	steps, err := o.steps.GetSteps(w.AgentRoleID)
	if err != nil {
		return 0, fmt.Errorf("failed to get agent role: %w", err)
	}
	return len(steps), nil
}
