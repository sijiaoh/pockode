package agent

import "testing"

// The two halves of thinking answer the state predicates differently, and that
// difference is the design: the record is history the model wrote, the delta is
// a live signal that the turn is alive.
func TestThinking_AnswersTheStatePredicates(t *testing.T) {
	record, delta := EventTypeThinking, EventTypeThinkingDelta

	// A thinking row has to come back on replay; "is thinking now" must not.
	if !record.Persisted() {
		t.Error("a thinking is not recorded, so a replayed transcript loses it")
	}
	if delta.Persisted() {
		t.Error("the thinking signal is recorded, so a transcript would claim a thinking that is long over")
	}

	for _, e := range []EventType{record, delta} {
		if e.AwaitsUserInput() {
			t.Errorf("%s blocks nothing: the turn carries on", e)
		}
		if !e.IndicatesAgentActivity() {
			t.Errorf("%s only arrives while a turn is under way", e)
		}
	}

	// Only the model writes a thinking, so the turn reached it. The signal is
	// not proof of that, and counting it would let a background task's
	// bookkeeping end a background wait (process.turnInputFor).
	if !record.ActivatesSession() {
		t.Error("a thinking is the model's own output and starts the session")
	}
	if delta.ActivatesSession() {
		t.Error("the thinking signal must not read as the CLI producing content")
	}
}
