package agent

import "testing"

// The read point has to answer all four of the state predicates deliberately —
// it is a record of something that happened, and nothing more than that.
//
// ActivatesSession is the one that would bite twice over. A session whose only
// agent-side record was a read point must still be switchable to another agent,
// because nothing of the agent's own is in the conversation yet; and the same
// predicate is what the process reads as the CLI producing content again, which
// is the one thing that ends a background wait (process.turnInputFor). For the
// agent that reports no read point of its own, Pockode writes this record
// itself, and Pockode writing a record is not the CLI coming back.
//
// IndicatesAgentActivity is the weaker of the two — it only says the turn is
// alive (session.SignalNoise) — and is false here for the same reason: a record
// Pockode may have written itself says nothing about the CLI.
func TestMessageIngested_AnswersTheStatePredicates(t *testing.T) {
	e := EventTypeMessageIngested

	// The whole point of the signal: the split it marks has to survive a reload.
	if !e.Persisted() {
		t.Error("the read point is not recorded, so it cannot be replayed")
	}
	if e.AwaitsUserInput() {
		t.Error("the read point blocks nothing: the turn carries straight on")
	}
	if e.IndicatesAgentActivity() {
		t.Error("the read point must not read as the CLI producing output")
	}
	if e.ActivatesSession() {
		t.Error("the read point puts nothing of the agent's into the conversation")
	}
}
