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
// Eight leaves, and there is never more than one: the layers it is derived from
// are each exclusive.
//
// It is not the whole of what a row draws. "This work has questions waiting for
// an answer" is a second, independent dimension — an agent that posted one and
// carried on is *running* and has something for the user — and it is counted
// beside this rather than folded into it (RowState).
type Activity string

const (
	// ActivityOpen is a work that exists and was never started.
	ActivityOpen Activity = "open"
	// ActivityRunning is a turn producing output.
	ActivityRunning Activity = "running"
	// ActivityNeedsPermission is a turn blocked on a permission request.
	ActivityNeedsPermission Activity = "needs_permission"
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

// NeedsUser reports whether the user is the one holding this work up. It is
// exactly one leaf now — a permission request — because a background wait and a
// wait on children are things happening rather than things to do, and a question
// an agent posted holds nothing up at all.
//
// It is therefore not the whole of the attention dot: a work with unanswered
// questions needs the user too, and no activity can say so (see RowState). The
// dot is the one place the two dimensions are merged, and that merge belongs to
// whatever is drawing it, not here.
func (a Activity) NeedsUser() bool {
	return a == ActivityNeedsPermission
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
// intention, a phase is a fact about this second. An agent that calls story_wait
// and then keeps writing for another ten seconds *is* running, and the row
// should say so; the moment the turn settles the wait takes over. The
// alternative needs a priority table between two kinds of waiting that can
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
	if w.Wait == WaitChild {
		return ActivityWaitingChildren
	}
	return ActivityIdle
}

// blockedActivity picks the leaf for a blocked turn. Permission outranks
// background because background is the one nobody can act on — and those are
// the only two blockers left, now that a question belongs to the session rather
// than to a turn.
func blockedActivity(turn session.TurnState) Activity {
	for _, b := range turn.Blockers {
		if b.Kind == session.BlockerPermission {
			return ActivityNeedsPermission
		}
	}
	return ActivityBackground
}

// RowState is everything a work row draws that the work record does not know:
// what the item is doing, and how many of its questions are waiting for the
// user.
//
// The two travel together because they are read from one place — the turn of
// the session the work runs in — and because a row that pushed only when the
// first of them moved would go stale the moment the second did.
//
// A count rather than the questions themselves. A row prints "2 to answer" and
// nothing more, while every subscriber holds the whole project's list and is
// sent a row whenever any item changes; the questions themselves are on the
// detail, for the one item a client has open (rpc.WorkDetailSubscribeResult).
type RowState struct {
	Activity Activity
	// UnansweredQuestions is how many questions the work's session has asked
	// and nobody has answered.
	UnansweredQuestions int
}

// NeedsAttention reports whether the user is the one this work is waiting on,
// across both dimensions: a turn stuck on something only they can clear, or a
// question of the agent's that nobody has answered.
//
// This is the merge, and it happens once, here. Activity.NeedsUser is half of
// it and cannot be the whole: an agent that posted a question and carried on is
// *running*, and a predicate reading only the activity would say nobody is
// needed.
func (s RowState) NeedsAttention() bool {
	return s.Activity.NeedsUser() || s.UnansweredQuestions > 0
}

// RowStateFor derives a row's state from a work item and the turn of the
// session it runs in — the zero turn when it has no session.
func RowStateFor(w Work, turn session.TurnState) RowState {
	state := RowState{Activity: DeriveActivity(w, turn)}
	if w.Status == StatusActive || w.Status == StatusStopped {
		// A closed or never-started work draws no count. Closing withdraws the
		// questions beneath it (worktree.Manager.RetireSession), and an open one
		// has no session to have asked any — so a non-zero count on either would
		// be a leftover rather than something to act on.
		state.UnansweredQuestions = len(turn.Unanswered)
	}
	return state
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

// RowState derives everything one work item's row draws from the session layer.
func (r *ActivityResolver) RowState(w Work) RowState {
	return RowStateFor(w, r.turnFor(w))
}

// PendingQuestions are the questions one work item's session is waiting on
// answers to, for the detail view that lists them in full.
func (r *ActivityResolver) PendingQuestions(w Work) []session.PendingQuestion {
	return r.turnFor(w).Unanswered
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
