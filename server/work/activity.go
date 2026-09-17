package work

import (
	"log/slog"

	"github.com/pockode/server/session"
)

// Activity is what a work item is doing, as one value. It is derived, never
// stored: a work record says what the engine may do with the item (Status) and
// what it is waiting for (Wait), and the session it runs in says what is
// happening right now. Nothing on screen may spell a state out of those parts
// itself — see docs/lifecycle-ui.md.
//
// Ten leaves, and there is never more than one: the layers it is derived from
// are each exclusive.
type Activity string

const (
	// ActivityOpen is a work that exists and was never started.
	ActivityOpen Activity = "open"
	// ActivityRunning is a turn producing output.
	ActivityRunning Activity = "running"
	// ActivityNeedsAnswer is a turn blocked on a question the user has to answer.
	ActivityNeedsAnswer Activity = "needs_answer"
	// ActivityNeedsPermission is a turn blocked on a permission request.
	ActivityNeedsPermission Activity = "needs_permission"
	// ActivityNeedsMessage is the work itself waiting on the user, because its
	// agent said so (work_needs_input). Unlike the two above, nothing in the
	// session is holding a turn open for it.
	ActivityNeedsMessage Activity = "needs_message"
	// ActivityBackground is a turn parked on work that outlives the tool call
	// that started it. Nothing for the user to do, and nothing is stuck.
	ActivityBackground Activity = "background"
	// ActivityWaitingChildren is a story waiting for its subtasks to close.
	ActivityWaitingChildren Activity = "waiting_children"
	// ActivityIdle is an engine-driven work with nothing happening in it right
	// now — between turns, or waiting for the nudge that follows one.
	ActivityIdle Activity = "idle"
	// ActivityStopped is a work the engine does not touch until a person acts.
	ActivityStopped Activity = "stopped"
	// ActivityClosed is a finished work.
	ActivityClosed Activity = "closed"
)

// NeedsUser reports whether the user is the one holding this work up. It is the
// single predicate behind every attention dot, and it is exactly the three
// "needs you" leaves — a background wait and a wait on children are things
// happening, not things to do.
func (a Activity) NeedsUser() bool {
	switch a {
	case ActivityNeedsAnswer, ActivityNeedsPermission, ActivityNeedsMessage:
		return true
	}
	return false
}

// DeriveActivity is the rule, and the whole of it:
//
//	The session says what is happening; the work's wait says what it is waiting
//	for when nothing is happening.
//
// turn is the state of the session the work runs in, or the zero value when it
// has no session — which reads as idle, the same as a session sitting between
// turns, because for a work item the two are the same nothing.
//
// Phase outranks wait rather than the other way round: a wait is a standing
// intention, a phase is a fact about this second. An agent that calls
// work_needs_input and then keeps writing for another ten seconds *is* running,
// and the row should say so; the moment the turn settles the wait takes over.
// The alternative needs a priority table between two kinds of waiting that can
// legitimately coexist, and every entry in such a table is an arbitrary choice
// someone later "fixes".
//
// The client has the same function for sessions (web/src/lib/activity.ts). The
// two are checked against one shared table of cases — work/testdata/
// activity_cases.json — so that the rule has one definition even though it is
// evaluated in two places, for the reason docs/lifecycle-ui.md §1.3 gives: a
// work list spans worktrees, and a client cannot hold the turn state of a
// session in a worktree it has not opened.
func DeriveActivity(w Work, turn session.TurnState) Activity {
	switch w.Status {
	case StatusOpen:
		return ActivityOpen
	case StatusClosed:
		return ActivityClosed
	case StatusStopped:
		return ActivityStopped
	}

	switch turn.Phase {
	case session.PhaseRunning:
		return ActivityRunning
	case session.PhaseBlocked:
		return blockedActivity(turn)
	}

	// Idle, or no session at all.
	switch w.Wait {
	case WaitUser:
		return ActivityNeedsMessage
	case WaitChild:
		return ActivityWaitingChildren
	}
	return ActivityIdle
}

// blockedActivity picks the leaf for a blocked turn. Permission outranks
// question because a permission request cannot be answered late — it expires as
// a denial — so it is the wait with something to lose. Background is last
// because it is the only one nobody can act on.
func blockedActivity(turn session.TurnState) Activity {
	leaf := ActivityBackground
	for _, b := range turn.Blockers {
		switch b.Kind {
		case session.BlockerPermission:
			return ActivityNeedsPermission
		case session.BlockerQuestion:
			leaf = ActivityNeedsAnswer
		}
	}
	return leaf
}

// TurnSource resolves the turn state of every session in a worktree.
// Implemented by worktree.Manager, which answers for worktrees nobody has
// opened as well — that is the whole reason a work's activity is computed on the
// server (docs/lifecycle-ui.md §1.3).
type TurnSource interface {
	// SessionTurns returns the turn state of every session in the named
	// worktree, keyed by session id; "" names the main one. A worktree with no
	// sessions yet returns an empty map and no error.
	SessionTurns(worktree string) (map[string]session.TurnState, error)
}

// ActivityResolver derives activities for work items, reading each worktree's
// turn state at most once.
//
// It is built per batch, not kept: turn state changes with every event an agent
// produces, so a resolver that outlived the answer it was built for would hand
// out states the sessions have already left.
type ActivityResolver struct {
	source TurnSource
	turns  map[string]map[string]session.TurnState
}

// NewActivityResolver builds a resolver over one turn source. A nil source
// answers with no turns at all, which reads every active work as idle — the
// honest answer for a server that cannot see the session layer, and the shape
// narrow tests want.
func NewActivityResolver(source TurnSource) *ActivityResolver {
	return &ActivityResolver{
		source: source,
		turns:  make(map[string]map[string]session.TurnState),
	}
}

// Activity derives one work item's activity.
func (r *ActivityResolver) Activity(w Work) Activity {
	return DeriveActivity(w, r.turnFor(w))
}

func (r *ActivityResolver) turnFor(w Work) session.TurnState {
	if w.SessionID == "" || r.source == nil {
		return session.TurnState{}
	}
	turns, cached := r.turns[w.Worktree]
	if !cached {
		var err error
		turns, err = r.source.SessionTurns(w.Worktree)
		if err != nil {
			// A worktree that cannot be read is not a reason to blank a row: the
			// work's own status still says whether the engine is driving it, and
			// "idle" is what a work with no readable session looks like anyway.
			slog.Warn("failed to read session turns for work activity",
				"worktree", w.Worktree, "workId", w.ID, "error", err)
			turns = nil
		}
		r.turns[w.Worktree] = turns
	}
	return turns[w.SessionID]
}
