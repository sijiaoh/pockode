package process

import (
	"testing"

	"github.com/pockode/server/session"
)

// viewTurn is what the unread mark reads: idle is a session calling for
// someone. A request under review calls nobody, even once the turn behind it
// has ended; one nobody else answers calls the person, whatever is under review
// beside it.
func TestViewTurn(t *testing.T) {
	permission := func(id string, reviewing bool) session.Blocker {
		return session.Blocker{Kind: session.BlockerPermission, RequestID: id, Reviewing: reviewing}
	}
	cases := []struct {
		name string
		turn session.TurnState
		want ProcessState
	}{
		{"no turn", session.TurnState{}, ProcessStateIdle},
		{"running", session.TurnState{Open: true}, ProcessStateRunning},
		{"background", session.TurnState{Open: true, Blockers: []session.Blocker{{Kind: session.BlockerBackground}}}, ProcessStateRunning},
		{"permission", session.TurnState{Open: true, Blockers: []session.Blocker{permission("a", false)}}, ProcessStateIdle},
		{"under review", session.TurnState{Open: true, Blockers: []session.Blocker{permission("a", true)}}, ProcessStateRunning},
		{"under review past the turn", session.TurnState{Blockers: []session.Blocker{permission("a", true)}}, ProcessStateRunning},
		{"one of two under review", session.TurnState{Open: true, Blockers: []session.Blocker{permission("a", true), permission("b", false)}}, ProcessStateIdle},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := viewTurn(c.turn); got != c.want {
				t.Errorf("viewTurn = %q, want %q", got, c.want)
			}
		})
	}
}
