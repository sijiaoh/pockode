package work

import (
	"context"
	"errors"
	"time"
)

type Comment struct {
	ID        string    `json:"id"`
	WorkID    string    `json:"work_id"`
	Body      string    `json:"body"`
	CreatedAt time.Time `json:"created_at"`
}

var (
	ErrWorkNotFound    = errors.New("work not found")
	ErrCommentNotFound = errors.New("comment not found")
	ErrInvalidWork     = errors.New("invalid work")
)

type WorkType string

const (
	WorkTypeStory WorkType = "story"
	WorkTypeTask  WorkType = "task"
)

// WorkStatus is what the engine is allowed to do with a work item, and nothing
// else. Four values, all of them intent:
//
//   - open: never started. No session, nothing to drive.
//   - active: the engine drives it. Whether anything is happening right now is
//     the session's business, not this field's — see Activity.
//   - stopped: the engine does not touch it; a person has to act.
//   - closed: finished.
//
// What the agent is *doing* used to be spelled out here as in_progress /
// needs_input / waiting, which made this field a cache of process events that
// went stale every time one was missed. It is derived now (DeriveActivity), from
// this status, the Wait below, and the session's own turn state.
type WorkStatus string

const (
	StatusOpen    WorkStatus = "open"
	StatusActive  WorkStatus = "active"
	StatusStopped WorkStatus = "stopped"
	StatusClosed  WorkStatus = "closed"
)

// WorkWait is what an active work is waiting for, as the agent itself declared
// it. It is orthogonal to status: a work waiting on something is still active —
// the engine still owns it — it simply must not be nudged to carry on.
//
// One thing can be waited for, and it is cleared by something that arrives from
// outside the session: a child work closing. A turn's own blockers (a permission
// request on screen, a background task) are the session's business and are never
// recorded here.
//
// Waiting on the *user* used to be the second value, and it is gone. An agent
// that needs something from a person posts a question instead (the question_post
// tool): the question is state on the session, the answer arrives as an ordinary
// message, and the agent is free to carry on in the meantime — none of which a
// flag on the work could say. What the flag was actually for — "do not nudge
// this" — is read off the session's unanswered list now, which is the thing that
// knows (Engine.HandleTurnEnded).
type WorkWait string

const (
	// WaitNone is the zero value on purpose: a work that declared no wait is
	// simply working.
	WaitNone  WorkWait = ""
	WaitChild WorkWait = "child"
)

type Work struct {
	ID          string     `json:"id"`
	Type        WorkType   `json:"type"`
	ParentID    string     `json:"parent_id,omitempty"`
	AgentRoleID string     `json:"agent_role_id,omitempty"`
	Title       string     `json:"title"`
	Body        string     `json:"body,omitempty"`
	Status      WorkStatus `json:"status"`
	// Wait is what this work is waiting for while active; empty when it is
	// waiting for nothing. Meaningless on any other status, and cleared by every
	// transition that leaves active.
	Wait WorkWait `json:"wait,omitempty"`
	// NudgeCount is how many times in a row the engine has told this work's agent
	// to carry on without the agent moving the work along. When it runs out the
	// work is stopped rather than nudged forever.
	//
	// It is cleared by every transition into or out of active (clearDrive), which
	// is exactly what counts as progress here: a step advance, a user message, a
	// reopen, a child closing under a parent that was waiting for one. An answer
	// to a posted question clears it too, but by itself (ClearNudges): the answer
	// is the user's attention, which is what the allowance was counting down to,
	// and it is not a transition — the work was never anything but active.
	//
	// A child closing under a parent that was *not* waiting for it is deliberately
	// not on that list — the parent is told, but it was already being nudged for
	// going quiet, and the news does not answer the question the allowance is
	// counting.
	//
	// Persisted rather than kept in memory per session, so that a server restart
	// does not hand a stuck agent a fresh allowance.
	NudgeCount  int    `json:"nudge_count,omitempty"`
	SessionID   string `json:"session_id,omitempty"`
	CurrentStep int    `json:"current_step,omitempty"` // 0-indexed; used only when agent role has Steps
	// Worktree the work's session runs in (empty = main). Captured from the
	// frontend's current worktree when a top-level work first starts, or
	// inherited from the parent at create time; immutable once the work starts.
	Worktree  string    `json:"worktree,omitempty"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type Operation string

const (
	OperationCreate Operation = "create"
	OperationUpdate Operation = "update"
	OperationDelete Operation = "delete"
)

type ChangeEvent struct {
	Op   Operation
	Work Work
}

// OnChangeListener receives notifications when Work items change.
//
// Contract: OnWorkChange is called outside the store's mutex, but listeners
// that call back into the store (e.g. Engine.notifyParentOfChild)
// MUST do so in a separate goroutine to avoid re-entrant deadlock:
// notify → listener → store.Update → notify would deadlock if synchronous.
type OnChangeListener interface {
	OnWorkChange(event ChangeEvent)
}

type CommentEvent struct {
	Comment Comment
}

// OnCommentChangeListener receives notifications when comments are added.
// Same mutex contract as OnChangeListener applies.
type OnCommentChangeListener interface {
	OnCommentChange(event CommentEvent)
}

// WorkStartHandler handles the full lifecycle of starting a work session
// (create session, set title, send kickoff message).
// For restarts (reused sessionID), the implementation should detect the
// existing session and send a restart message instead.
// Satisfied by worktree integration code in the main server.
type WorkStartHandler interface {
	HandleWorkStart(ctx context.Context, w Work) error
}

// Normalize brings a work record read from disk up to the current model, and is
// why there is no migration script for the work index.
//
// The statuses it replaces were exactly this model flattened: in_progress,
// needs_input and waiting were one status (active) and three waits, which is
// what made them a single enum in the first place. So the old values are not
// guessed at — each maps to the pair it always meant, except needs_input, whose
// wait no longer exists.
//
// An unrecognised status is left alone rather than repaired: a hand-edited or
// corrupted index is not something to silently rewrite, and every guard in this
// package names the statuses it rejects rather than the ones it admits.
func (w Work) Normalize() Work {
	switch string(w.Status) {
	case "in_progress", "needs_input":
		// The two were distinct once: needs_input meant a `user` wait, which no
		// longer exists. There is nothing to map it to and nothing lost — what
		// such a work was waiting for was a message, and a message wakes it either
		// way.
		w.Status, w.Wait = StatusActive, WaitNone
	case "waiting":
		w.Status, w.Wait = StatusActive, WaitChild
	}
	// A wait only means anything while the engine is driving the work. Anywhere
	// else it is a leftover that would show the user a work "waiting for you"
	// that nothing will ever resume.
	if w.Status != StatusActive {
		w.Wait = WaitNone
	}
	return w
}
