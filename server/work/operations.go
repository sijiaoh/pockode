package work

import (
	"context"
	"fmt"
	"log/slog"
)

// Notifier delivers the agent-facing follow-up messages that accompany a work
// transition (e.g. the reopen nudge). Satisfied by the AutoResumer.
type Notifier interface {
	NotifyReopen(w Work)
}

// Operations performs the request-driven work lifecycle actions that combine a
// store mutation with its agent-facing side effects (session kickoff, reopen
// nudge). Both transports — the WebSocket handler (user actions) and the MCP
// Executor (AI actions) — go through Operations, so a user-triggered action and
// an AI-triggered action have identical effects. The main server stays the
// single writer of work data.
type Operations struct {
	store    Store
	starter  WorkStartHandler
	notifier Notifier
}

// NewOperations builds an Operations. A nil notifier is tolerated (the reopen
// nudge is then skipped) for narrow tests where no session is live.
func NewOperations(store Store, starter WorkStartHandler, notifier Notifier) *Operations {
	return &Operations{store: store, starter: starter, notifier: notifier}
}

// StartWork claims a work item and launches its agent session. It transitions
// the work to in_progress with a session ID, then creates the session and sends
// the kickoff (or restart) message via the WorkStartHandler. On handler failure
// the claim is rolled back so the work never gets stuck in_progress with a
// dangling session. The returned Work is the claimed item.
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
		if rbErr := o.store.RollbackStart(startCtx, id, restart); rbErr != nil {
			slog.Error("failed to rollback work start", "workId", id, "restart", restart, "error", rbErr)
		}
		return Work{}, err
	}
	return w, nil
}

// ReopenWork transitions a closed work item back to in_progress and delivers the
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
