package session

import "time"

// LeaseKind is what a session is holding its process for. One per TurnPhase,
// except that "blocked" splits in two: a person clearing a prompt and a CLI
// coming back from background work are cleared by different things, expire into
// different actions, and deserve different budgets.
type LeaseKind string

const (
	// LeaseIdle is a process kept alive only for the next message.
	LeaseIdle LeaseKind = "the next message"
	// LeaseTurn is a turn under way: the agent is off doing something that
	// produces no events, and collecting the process throws that work away.
	LeaseTurn LeaseKind = "a turn in progress"
	// LeaseAnswer is a turn blocked on a prompt only a person can clear.
	// Collecting the process answers the agent's question by killing it.
	LeaseAnswer LeaseKind = "a user answer"
	// LeaseBackground is a turn parked on work that outlives the tool call that
	// started it. Collecting the process kills that work.
	LeaseBackground LeaseKind = "background work"
)

// Lease is the claim a session currently has on its process: what it is waiting
// for, when that wait started, and how long it may go on.
//
// Every process has exactly one, and it is derived — never stored. The process
// itself holds no lifecycle state at all; it exists, it produces events, and
// what it is allowed to wait for is read off the session's TurnState. This is
// the whole of the reaper's rule; the table and the reasoning behind each budget
// are in docs/code/agent-integration.md, "The Lease Table".
type Lease struct {
	Kind LeaseKind
	// Since is what the budget is measured from: the moment the phase was
	// entered, or — for a blocked turn — the moment the oldest blocker in the
	// way was raised. Those are usually the same instant and differ when a
	// second prompt is raised on top of a first: the budget belongs to the wait
	// that has gone on longest, because that is the one that runs out first.
	Since time.Time
	// Budget is how long Kind may hold the process. Non-positive means no
	// budget: the wait is held until whatever clears it does.
	Budget time.Duration
}

// Expired reports whether the budget has run out as of now. A lease without a
// budget never expires.
func (l Lease) Expired(now time.Time) bool {
	return l.Budget > 0 && now.Sub(l.Since) > l.Budget
}

// Waited is how long this lease has been held. Reported to the user when a
// budget runs out, so the message says a number the user can check against the
// transcript rather than "a while".
func (l Lease) Waited(now time.Time) time.Duration {
	return now.Sub(l.Since).Round(time.Second)
}

// LeaseBudgets is how long each kind of wait may hold a process. One value per
// LeaseKind and no others: a budget that applied to something narrower would be
// a second rule about process lifetime, which is what this table replaces.
//
// Every field is configurable (--turn-timeout, --answer-timeout,
// --background-timeout, --idle-timeout), and the constants below are what they
// default to.
type LeaseBudgets struct {
	Turn       time.Duration
	Answer     time.Duration
	Background time.Duration
	Idle       time.Duration
}

// Where the default budgets come from.
const (
	// DefaultTurnBudget is none. A turn is the agent working, and a build, a
	// test run or a long-running tool call can legitimately take any amount of
	// time; a budget here would kill real work for the crime of being slow. It
	// exists as a knob for an operator who would rather cap it than be surprised
	// by a machine held overnight.
	DefaultTurnBudget = time.Duration(0)
	// DefaultAnswerBudget is an hour. Not because an answer stops being useful —
	// it does not: killing the process costs one cold resume and nothing else,
	// which was measured rather than assumed (both CLIs resume cleanly from a
	// SIGKILL that left a dangling tool_use in the transcript, and a late answer
	// sent as an ordinary message is understood). What the hour buys is the
	// other side of that trade: a person who has not answered within an hour is
	// not in the middle of answering, and until they do the process is a CLI
	// holding memory to wait.
	//
	// Deliberately not day-scale. The resume behaviour was only verified across
	// a process death, not across a day of one — transcript expiry and
	// provider-side session retention were not tested — so a budget that assumes
	// a session is still resumable tomorrow would be assuming something nobody
	// checked.
	DefaultAnswerBudget = time.Hour
	// DefaultBackgroundBudget is a day, and it is far longer than the answer
	// budget for two reasons.
	//
	// Running out costs more. An unanswered prompt can still be answered
	// afterwards; background work that is killed is gone, and all the user gets
	// is a loss report on the next start. The budget only has to be short enough
	// to catch the two shapes of background work that never finish on their own —
	// a session-scoped monitor, and a model that started a task and considers
	// itself done — and a day catches both.
	//
	// And it measures something stricter than what it replaces. The CLI adapter
	// used to hold a parked turn on a timer of its own that a task reporting
	// progress pushed out, so a chatty task could park a turn indefinitely; this
	// is a flat cap on how long a turn may stay parked, because the model now
	// knows when a turn is parked rather than inferring it from silence. A number
	// in the old timer's range (30 minutes to two hours) would therefore be a cut,
	// not a translation.
	DefaultBackgroundBudget = 24 * time.Hour
	// DefaultIdleBudget is the five minutes the --idle-timeout flag has always
	// defaulted to. An idle process holds nothing anyone is waiting for; the
	// only cost of collecting it is the resume the next message pays for.
	DefaultIdleBudget = 5 * time.Minute
)

// DefaultLeaseBudgets is the one place the defaults are written down.
func DefaultLeaseBudgets() LeaseBudgets {
	return LeaseBudgets{
		Turn:       DefaultTurnBudget,
		Answer:     DefaultAnswerBudget,
		Background: DefaultBackgroundBudget,
		Idle:       DefaultIdleBudget,
	}
}

// TickInterval is how often the reaper should look, given these budgets: often
// enough that the shortest budget is not overshot by much, and never so often
// that a long-budget-only configuration spins.
//
// Zero when nothing is budgeted at all, which is an operator saying "never
// collect anything": the reaper does not run then, rather than waking up to
// decide nothing.
func (b LeaseBudgets) TickInterval() time.Duration {
	shortest := time.Duration(0)
	for _, budget := range []time.Duration{b.Turn, b.Answer, b.Background, b.Idle} {
		if budget > 0 && (shortest == 0 || budget < shortest) {
			shortest = budget
		}
	}
	if shortest == 0 {
		return 0
	}
	// A quarter of the shortest budget, which is what the idle reaper always
	// used: a wait is collected between one and one-and-a-quarter budgets after
	// it started, and nothing in this table is precise enough for that to matter.
	tick := shortest / 4
	if tick < time.Second {
		tick = time.Second
	}
	return tick
}

// LeaseFor names the lease a session holds right now.
//
// The order is the order the waits nest in, not a preference: a blocked turn is
// also a turn in progress, and an idle session is what is left when none of the
// three applies. Prompts come before background work because a session can hold
// both at once — an agent can park on background work and then ask something —
// and the person is the one being kept waiting.
//
// lastActive is only read for the idle lease, and that is deliberate. For every
// other kind, silence is the normal condition of the wait, so "nothing has
// happened lately" says "busy" and "abandoned" in exactly the same words. An
// idle session is the one case where it says what it looks like, and where a
// user answering a prompt or opening the chat should postpone collection.
func (b LeaseBudgets) LeaseFor(turn TurnState, lastActive time.Time) Lease {
	if raised, ok := oldestBlocker(turn.Blockers, isPrompt); ok {
		return Lease{Kind: LeaseAnswer, Since: raised, Budget: b.Answer}
	}
	if raised, ok := oldestBlocker(turn.Blockers, isBackground); ok {
		return Lease{Kind: LeaseBackground, Since: raised, Budget: b.Background}
	}
	if turn.InProgress() {
		return Lease{Kind: LeaseTurn, Since: turn.Since, Budget: b.Turn}
	}
	return Lease{Kind: LeaseIdle, Since: lastActive, Budget: b.Idle}
}

// oldestBlocker reports when the matching blocker that has been in the way
// longest was raised, which is the one whose budget runs out first.
func oldestBlocker(blockers []Blocker, matches func(BlockerKind) bool) (time.Time, bool) {
	var oldest time.Time
	found := false
	for _, b := range blockers {
		if !matches(b.Kind) {
			continue
		}
		if !found || b.RaisedAt.Before(oldest) {
			oldest, found = b.RaisedAt, true
		}
	}
	return oldest, found
}

// isPrompt is the pair of blockers a person clears. They share a lease because
// they share the thing being waited for; what they do not share is what an
// expiry costs, which is why only one of them is recoverable afterwards (see
// DefaultAnswerBudget).
func isPrompt(kind BlockerKind) bool {
	return kind == BlockerPermission || kind == BlockerQuestion
}

func isBackground(kind BlockerKind) bool {
	return kind == BlockerBackground
}
