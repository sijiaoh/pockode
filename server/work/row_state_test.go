package work

import (
	"testing"
	"time"

	"github.com/pockode/server/session"
)

func turnWith(n int) session.TurnState {
	questions := make([]session.PendingQuestion, n)
	for i := range questions {
		questions[i] = session.PendingQuestion{RequestID: string(rune('a' + i)), AskedAt: time.Now()}
	}
	return session.TurnState{Phase: session.PhaseIdle, Unanswered: questions}
}

// TestRowStateFor_CountsAlongsideTheActivity is the second dimension a row
// draws. It is beside the activity, not folded into it: an agent that posted a
// question and carried on is *running* and has something waiting for the user,
// and a row that had to pick one of those would be wrong either way.
func TestRowStateFor_CountsAlongsideTheActivity(t *testing.T) {
	turn := turnWith(2)
	turn.Phase = session.PhaseRunning
	turn.Open = true

	state := RowStateFor(Work{Status: StatusActive, SessionID: "s"}, turn)
	if state.Activity != ActivityRunning {
		t.Errorf("activity = %q, want running", state.Activity)
	}
	if state.UnansweredQuestions != 2 {
		t.Errorf("unanswered = %d, want 2", state.UnansweredQuestions)
	}
}

// TestRowStateFor_OnlyWhereThereIsSomethingToDo: closing a work withdraws the
// questions beneath it, and an open work has no session to have asked any — so a
// count on either would be a leftover the user cannot act on.
func TestRowStateFor_OnlyWhereThereIsSomethingToDo(t *testing.T) {
	tests := []struct {
		status WorkStatus
		want   int
	}{
		{StatusOpen, 0},
		{StatusActive, 1},
		{StatusStopped, 1},
		{StatusClosed, 0},
	}
	for _, tt := range tests {
		t.Run(string(tt.status), func(t *testing.T) {
			state := RowStateFor(Work{Status: tt.status, SessionID: "s"}, turnWith(1))
			if state.UnansweredQuestions != tt.want {
				t.Errorf("unanswered = %d, want %d", state.UnansweredQuestions, tt.want)
			}
		})
	}
}

func TestRowStateFor_NoSession(t *testing.T) {
	state := RowStateFor(Work{Status: StatusActive}, session.TurnState{})
	if state.Activity != ActivityIdle || state.UnansweredQuestions != 0 {
		t.Errorf("state = %+v, want idle with nothing waiting", state)
	}
}
