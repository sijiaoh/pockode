package session

import (
	"testing"
	"time"
)

// testBudgets are deliberately all different and all short, so that a test
// asserting "this expired" is asserting it against the right one: a table where
// two entries share a value cannot tell a correct lookup from a lucky one.
var testBudgets = LeaseBudgets{
	Turn:       10 * time.Minute,
	Answer:     20 * time.Minute,
	Background: 30 * time.Minute,
	Idle:       40 * time.Minute,
}

// Every phase holds the process for a different thing, and each names the
// instant its own budget is measured from. This is the whole table.
func TestLeaseForNamesWhatHoldsTheProcess(t *testing.T) {
	prompted := drive(TurnState{}, in(SignalPrompt, 1))
	blocked := drive(prompted, inReq(SignalQuestionRaised, "req-1", 2))
	parked := drive(prompted, in(SignalBackgroundParked, 3))
	ended := drive(prompted, in(SignalDone, 4))

	tests := []struct {
		name  string
		turn  TurnState
		want  LeaseKind
		since time.Time
	}{
		{"never run", TurnState{}, LeaseIdle, at(9)},
		{"turn in progress", prompted, LeaseTurn, at(1)},
		{"blocked on a person", blocked, LeaseAnswer, at(2)},
		{"parked on background work", parked, LeaseBackground, at(3)},
		{"turn over", ended, LeaseIdle, at(9)},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			lease := testBudgets.LeaseFor(tt.turn, at(9))
			if lease.Kind != tt.want {
				t.Errorf("kind = %q, want %q", lease.Kind, tt.want)
			}
			if !lease.Since.Equal(tt.since) {
				t.Errorf("measured from %v, want %v", lease.Since, tt.since)
			}
		})
	}
}

// A person being kept waiting outranks background work, because a session can
// hold both at once: an agent can park on a task and then ask something.
func TestLeaseForPutsThePersonFirst(t *testing.T) {
	turn := drive(TurnState{},
		in(SignalPrompt, 1),
		in(SignalBackgroundParked, 2),
		inReq(SignalPermissionRaised, "req-1", 3),
	)

	if lease := testBudgets.LeaseFor(turn, at(9)); lease.Kind != LeaseAnswer {
		t.Errorf("kind = %q, want %q", lease.Kind, LeaseAnswer)
	}
}

// Two prompts on screen are one lease, and it belongs to the older: that is the
// wait that runs out first, and the budget is about how long someone has been
// kept waiting rather than about how many things they were asked.
func TestLeaseForMeasuresFromTheOldestBlocker(t *testing.T) {
	turn := drive(TurnState{},
		in(SignalPrompt, 1),
		inReq(SignalQuestionRaised, "req-1", 2),
		inReq(SignalPermissionRaised, "req-2", 5),
	)

	if lease := testBudgets.LeaseFor(turn, at(9)); !lease.Since.Equal(at(2)) {
		t.Errorf("measured from %v, want the older prompt at %v", lease.Since, at(2))
	}
}

// The idle lease is the one measured from activity rather than from the phase,
// because it is the one case where silence means what it looks like — and it is
// what lets a user reading the chat postpone the collection.
func TestLeaseForIdleFollowsActivity(t *testing.T) {
	lease := testBudgets.LeaseFor(TurnState{}, at(7))

	if !lease.Since.Equal(at(7)) {
		t.Errorf("idle lease measured from %v, want the last activity at %v", lease.Since, at(7))
	}
	if lease.Expired(at(7).Add(testBudgets.Idle / 2)) {
		t.Error("an idle session was collected inside its budget")
	}
	if !lease.Expired(at(7).Add(2 * testBudgets.Idle)) {
		t.Error("an idle session past its budget was not collected")
	}
}

// A blocked session going quiet is the normal condition of the wait, so nothing
// a user does to it — and nothing that touched it before — may shorten or extend
// the budget the wait itself sets.
func TestLeaseForIgnoresActivityWhileWaiting(t *testing.T) {
	turn := drive(TurnState{}, in(SignalPrompt, 1), inReq(SignalQuestionRaised, "req-1", 2))

	lease := testBudgets.LeaseFor(turn, at(8))
	if !lease.Since.Equal(at(2)) {
		t.Errorf("measured from %v, want the moment the prompt was raised at %v", lease.Since, at(2))
	}
}

// A non-positive budget is an operator saying "hold this for as long as it
// takes". Read literally it says the opposite, since every wait is older than a
// zero budget the instant it starts.
func TestLeaseWithoutABudgetNeverExpires(t *testing.T) {
	turn := drive(TurnState{}, in(SignalPrompt, 1))
	budgets := LeaseBudgets{Turn: 0}

	if budgets.LeaseFor(turn, at(1)).Expired(at(1).Add(1000 * time.Hour)) {
		t.Error("a turn with no budget was interrupted anyway")
	}
}

func TestLeaseExpiresOnlyPastTheBudget(t *testing.T) {
	lease := Lease{Kind: LeaseAnswer, Since: at(0), Budget: 10 * time.Minute}

	if lease.Expired(at(10)) {
		t.Error("a lease expired exactly at its budget; the budget is how long it may be held")
	}
	if !lease.Expired(at(11)) {
		t.Error("a lease past its budget did not expire")
	}
}

// The reaper's interval comes from the shortest budget, so the entry that
// matters soonest is not overshot by the entries measured in hours.
func TestTickIntervalFollowsTheShortestBudget(t *testing.T) {
	tests := []struct {
		name    string
		budgets LeaseBudgets
		want    time.Duration
	}{
		{"shortest wins", testBudgets, testBudgets.Turn / 4},
		{"zeroes are not budgets", LeaseBudgets{Turn: 0, Idle: time.Hour}, 15 * time.Minute},
		{"nothing budgeted, no reaper", LeaseBudgets{}, 0},
		{"never spins", LeaseBudgets{Idle: time.Millisecond}, time.Second},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.budgets.TickInterval(); got != tt.want {
				t.Errorf("TickInterval() = %v, want %v", got, tt.want)
			}
		})
	}
}

// What is locked here is the shape of the default policy, not the four numbers:
// those are a tuning choice, argued next to them in lease.go, and a test that
// spelled them out again would only make retuning noisier. The relations are the
// part that has to survive any retuning — get one of them backwards and the
// table is collecting the wrong thing first.
func TestDefaultLeaseBudgets(t *testing.T) {
	budgets := DefaultLeaseBudgets()

	if budgets.Turn != 0 {
		t.Errorf("a turn is budgeted by default (%v); real work has no upper bound", budgets.Turn)
	}
	if budgets.Answer >= budgets.Background {
		t.Errorf("answer budget %v is not shorter than the background budget %v, although an "+
			"unanswered prompt can still be answered later and killed background work cannot",
			budgets.Answer, budgets.Background)
	}
	if budgets.Idle >= budgets.Answer {
		t.Errorf("idle budget %v is not the shortest wait (%v); nothing is waiting on an idle process",
			budgets.Idle, budgets.Answer)
	}
	if budgets.TickInterval() <= 0 {
		t.Error("the default table collects nothing at all")
	}
}
