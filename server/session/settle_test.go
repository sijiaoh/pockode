package session

import (
	"testing"
	"time"
)

// Nearly every test here uses a delay no timer will ever reach, and asserts on
// the decision the settler made synchronously instead (TurnSettler.waitingOn).
// The alternative — a short delay and a channel — is a test that assumes a
// schedule: every case below cancels an ending that is already armed, so under
// load the timer can win the race and the failure looks like a bug in the
// settler (docs/testing.md). Only the one case that has to watch an
// announcement actually arrive waits on the clock, and it has nothing to cancel.
const (
	settleNeverDelay = time.Hour
	settleFireDelay  = 50 * time.Millisecond
)

func newTestSettler(t *testing.T, delay time.Duration) (*TurnSettler, chan TurnEnd) {
	t.Helper()
	ends := make(chan TurnEnd, 4)
	settler := NewTurnSettler(delay)
	settler.SetListener(func(end TurnEnd) { ends <- end })
	t.Cleanup(settler.Stop)
	return settler, ends
}

func endedTransition(outcome TurnOutcome) TurnTransition {
	signal := SignalDone
	switch outcome {
	case OutcomeFailed:
		signal = SignalFailed
	case OutcomeAborted:
		signal = SignalInterrupted
	}
	state := drive(TurnState{}, in(SignalPrompt, 0))
	return ReduceTurn(state, in(signal, 1))
}

func runningTransition() TurnTransition {
	return ReduceTurn(TurnState{}, in(SignalPrompt, 0))
}

// expectWaitingOn asserts which ending, if any, the settler is holding. An empty
// outcome means it must be holding none.
func expectWaitingOn(t *testing.T, settler *TurnSettler, sessionID string, want TurnOutcome) {
	t.Helper()
	end, held := settler.waitingOn(sessionID)
	if want == "" {
		if held {
			t.Fatalf("%s: an ending is still waiting to be announced: %+v", sessionID, end)
		}
		return
	}
	if !held {
		t.Fatalf("%s: no ending is waiting, want %q", sessionID, want)
	}
	if end.Outcome != want {
		t.Fatalf("%s: waiting on %q, want %q", sessionID, end.Outcome, want)
	}
	if end.SessionID != sessionID {
		t.Fatalf("the ending names %q, want %q", end.SessionID, sessionID)
	}
}

// The one case that watches the clock: an ending nothing takes back is
// announced. Nothing here cancels, so there is no race to lose.
func TestTurnSettlerAnnouncesAnEndingThatSticks(t *testing.T) {
	settler, ends := newTestSettler(t, settleFireDelay)

	settler.Observe("sess-1", endedTransition(OutcomeCompleted))

	select {
	case end := <-ends:
		if end.SessionID != "sess-1" || end.Outcome != OutcomeCompleted {
			t.Fatalf("end = %+v, want sess-1/completed", end)
		}
	// A backstop, not the subject: the wait itself is settleFireDelay, and this
	// only has to outlast the scheduling delay of a package running alongside
	// every other one under `go test ./...` (docs/testing.md).
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for the turn to be announced as over")
	}

	expectWaitingOn(t, settler, "sess-1", "")
}

// The case the delay exists for: an aborted turn is followed straight away by
// the one that replaced it, and announcing the abort then would stop work that
// is running right now.
func TestTurnSettlerDropsAnEndingTheSessionCameBackFrom(t *testing.T) {
	settler, _ := newTestSettler(t, settleNeverDelay)

	settler.Observe("sess-1", endedTransition(OutcomeAborted))
	expectWaitingOn(t, settler, "sess-1", OutcomeAborted)

	settler.Observe("sess-1", runningTransition())
	expectWaitingOn(t, settler, "sess-1", "")
}

// A session blocked on the user has not ended its turn, and must not be
// announced as having done so — the wait can outlast any delay.
func TestTurnSettlerIgnoresABlockedTurn(t *testing.T) {
	settler, _ := newTestSettler(t, settleNeverDelay)

	state := drive(TurnState{}, in(SignalPrompt, 0))
	settler.Observe("sess-1", ReduceTurn(state, inReq(SignalPermissionRaised, "req-1", 1)))

	expectWaitingOn(t, settler, "sess-1", "")
}

// The newest ending is the one that describes the session. A turn that ends
// twice with different outcomes must be announced with the second one.
func TestTurnSettlerAnnouncesTheLatestOutcome(t *testing.T) {
	settler, _ := newTestSettler(t, settleNeverDelay)

	settler.Observe("sess-1", endedTransition(OutcomeCompleted))
	settler.Observe("sess-1", runningTransition())
	settler.Observe("sess-1", endedTransition(OutcomeAborted))

	expectWaitingOn(t, settler, "sess-1", OutcomeAborted)
}

func TestTurnSettlerForgetsADeletedSession(t *testing.T) {
	settler, _ := newTestSettler(t, settleNeverDelay)

	settler.Observe("sess-1", endedTransition(OutcomeCompleted))
	settler.OnSessionChange(SessionChangeEvent{Op: OperationDelete, Session: SessionMeta{ID: "sess-1"}})

	expectWaitingOn(t, settler, "sess-1", "")
}

func TestTurnSettlerKeepsAnEndingThroughAnOrdinaryUpdate(t *testing.T) {
	settler, _ := newTestSettler(t, settleNeverDelay)

	settler.Observe("sess-1", endedTransition(OutcomeCompleted))
	settler.OnSessionChange(SessionChangeEvent{Op: OperationUpdate, Session: SessionMeta{ID: "sess-1"}})

	expectWaitingOn(t, settler, "sess-1", OutcomeCompleted)
}

func TestTurnSettlerStopAbandonsPendingAnnouncements(t *testing.T) {
	settler, _ := newTestSettler(t, settleNeverDelay)

	settler.Observe("sess-1", endedTransition(OutcomeCompleted))
	settler.Stop()

	expectWaitingOn(t, settler, "sess-1", "")
}

// Sessions settle independently: one coming back must not cancel another's
// ending.
func TestTurnSettlerKeepsSessionsApart(t *testing.T) {
	settler, _ := newTestSettler(t, settleNeverDelay)

	settler.Observe("sess-1", endedTransition(OutcomeCompleted))
	settler.Observe("sess-2", runningTransition())

	expectWaitingOn(t, settler, "sess-1", OutcomeCompleted)
	expectWaitingOn(t, settler, "sess-2", "")
}

// With nothing listening there is nothing to announce, and no timer is worth
// arming.
func TestTurnSettlerWithoutAListenerArmsNothing(t *testing.T) {
	settler := NewTurnSettler(settleNeverDelay)
	defer settler.Stop()

	settler.Observe("sess-1", endedTransition(OutcomeCompleted))

	expectWaitingOn(t, settler, "sess-1", "")
}
