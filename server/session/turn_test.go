package session

import (
	"testing"
	"time"
)

// at is a readable instant generator: at(1) is one minute after at(0), so a test
// can say "the blocker was raised before the process died" without arithmetic.
func at(minute int) time.Time {
	return time.Date(2026, 9, 16, 12, 0, 0, 0, time.UTC).Add(time.Duration(minute) * time.Minute)
}

// drive folds a sequence of signals into a state, which is how nearly every
// test here sets up: the reducer has no other way in, and that is the point.
func drive(state TurnState, inputs ...TurnInput) TurnState {
	for _, in := range inputs {
		state = ReduceTurn(state, in).State
	}
	return state
}

func in(signal TurnSignal, minute int) TurnInput {
	return TurnInput{Signal: signal, At: at(minute)}
}

func inReq(signal TurnSignal, requestID string, minute int) TurnInput {
	return TurnInput{Signal: signal, RequestID: requestID, At: at(minute)}
}

func TestReduceTurnStartsIdle(t *testing.T) {
	var zero TurnState
	if zero.InProgress() {
		t.Fatal("a session that has never run has no turn in progress")
	}
	if zero.AwaitingUserAnswer() || zero.WaitingForBackground() {
		t.Fatal("a session that has never run is waiting for nothing")
	}
	// An absent phase is how every session stored before this field reads back,
	// and it has to mean idle without the file being rewritten first.
	if zero.withPhaseDefaulted().Phase != PhaseIdle {
		t.Fatalf("an absent phase must read as idle, got %q", zero.withPhaseDefaulted().Phase)
	}
}

func TestReduceTurnPromptStartsTurn(t *testing.T) {
	got := ReduceTurn(TurnState{}, in(SignalPrompt, 0))

	if got.State.Phase != PhaseRunning {
		t.Fatalf("phase = %q, want running", got.State.Phase)
	}
	if !got.State.Since.Equal(at(0)) {
		t.Fatalf("Since = %v, want %v", got.State.Since, at(0))
	}
	if !got.Changed {
		t.Fatal("starting a turn changes the state")
	}
	if got.Ended {
		t.Fatal("starting a turn does not end one")
	}
	if !got.Started {
		t.Fatal("a prompt on an idle session starts the turn")
	}
}

// Started is what the send path asks instead of looking at the turn state
// beforehand, so it has to be false for every prompt that joined a turn rather
// than opening one — that is the message whose read point has to be recorded
// (agent.MessageIngestedEvent). A background wait counts as a turn under way:
// the content above the message was produced for the message before it.
func TestReduceTurnPromptJoiningATurnDoesNotStartOne(t *testing.T) {
	tests := []struct {
		name  string
		state TurnState
	}{
		{"running", drive(TurnState{}, in(SignalPrompt, 0))},
		{"parked on background work", drive(TurnState{}, in(SignalPrompt, 0), in(SignalBackgroundParked, 1))},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if !tt.state.InProgress() {
				t.Fatalf("setup: the turn is not under way: %+v", tt.state)
			}
			if got := ReduceTurn(tt.state, in(SignalPrompt, 2)); got.Started {
				t.Error("a prompt handed to a turn already under way did not start it")
			}
		})
	}
}

// A prompt after the turn ended opens a new one, which is the case that keeps
// this from being "has this session ever run".
func TestReduceTurnPromptAfterAnEndingStartsANewTurn(t *testing.T) {
	state := drive(TurnState{}, in(SignalPrompt, 0), in(SignalDone, 1))

	if got := ReduceTurn(state, in(SignalPrompt, 2)); !got.Started {
		t.Error("a prompt to an idle session starts a turn, whatever came before")
	}
}

func TestReduceTurnSinceHoldsWhileThePhaseDoes(t *testing.T) {
	state := drive(TurnState{}, in(SignalPrompt, 0))

	got := ReduceTurn(state, in(SignalOutput, 5))

	if !got.State.Since.Equal(at(0)) {
		t.Fatalf("Since = %v, want the turn's start %v", got.State.Since, at(0))
	}
	if got.Changed {
		t.Fatal("output during a running turn says nothing new, so nothing is written")
	}
}

func TestReduceTurnDoneEndsTheTurnOnce(t *testing.T) {
	state := drive(TurnState{}, in(SignalPrompt, 0), in(SignalOutput, 1))

	first := ReduceTurn(state, in(SignalDone, 2))
	if !first.Ended || first.State.LastOutcome != OutcomeCompleted {
		t.Fatalf("first done: ended=%v outcome=%q, want true/completed", first.Ended, first.State.LastOutcome)
	}
	if first.State.Phase != PhaseIdle || !first.State.Since.Equal(at(2)) {
		t.Fatalf("first done: phase=%q since=%v", first.State.Phase, first.State.Since)
	}

	// Codex answers an aborted call itself while Pockode synthesizes a response
	// for the same call, so the same ending can arrive twice.
	second := ReduceTurn(first.State, in(SignalDone, 3))
	if second.Ended {
		t.Fatal("a second done must not report a second ending")
	}
	if second.Changed {
		t.Fatal("a second done changes nothing")
	}
}

func TestReduceTurnOutcomes(t *testing.T) {
	cases := []struct {
		signal TurnSignal
		want   TurnOutcome
	}{
		{SignalDone, OutcomeCompleted},
		{SignalFailed, OutcomeFailed},
		{SignalAuthFailed, OutcomeAuthFailed},
		{SignalInterrupted, OutcomeAborted},
		{SignalProcessEnded, OutcomeAborted},
	}
	for _, tc := range cases {
		t.Run(string(tc.signal), func(t *testing.T) {
			state := drive(TurnState{}, in(SignalPrompt, 0))
			got := ReduceTurn(state, in(tc.signal, 1))
			if got.State.LastOutcome != tc.want {
				t.Fatalf("outcome = %q, want %q", got.State.LastOutcome, tc.want)
			}
			if got.State.Phase != PhaseIdle {
				t.Fatalf("phase = %q, want idle", got.State.Phase)
			}
		})
	}
}

func TestReduceTurnNewTurnClearsTheLastOutcome(t *testing.T) {
	state := drive(TurnState{}, in(SignalPrompt, 0), in(SignalInterrupted, 1))
	if state.LastOutcome != OutcomeAborted {
		t.Fatalf("setup: outcome = %q", state.LastOutcome)
	}

	got := ReduceTurn(state, in(SignalPrompt, 2))

	if got.State.LastOutcome != "" {
		t.Fatalf("outcome = %q, want it cleared by the new turn", got.State.LastOutcome)
	}
}

// Output arriving while idle starts a turn: a CLI can resume on its own after an
// interrupt, with nothing on the send path to say so.
func TestReduceTurnOutputRestartsAnIdleTurn(t *testing.T) {
	state := drive(TurnState{}, in(SignalPrompt, 0), in(SignalDone, 1))

	got := ReduceTurn(state, in(SignalOutput, 2))

	if got.State.Phase != PhaseRunning {
		t.Fatalf("phase = %q, want running", got.State.Phase)
	}
	if got.State.LastOutcome != "" {
		t.Fatalf("outcome = %q, want it cleared", got.State.LastOutcome)
	}
}

// --- Blockers ---

func TestReduceTurnPermissionBlocks(t *testing.T) {
	state := drive(TurnState{}, in(SignalPrompt, 0))

	got := ReduceTurn(state, inReq(SignalPermissionRaised, "req-1", 1))

	if got.State.Phase != PhaseBlocked {
		t.Fatalf("phase = %q, want blocked", got.State.Phase)
	}
	if !got.State.AwaitingUserAnswer() {
		t.Fatal("a permission request is something only a person can clear")
	}
	if len(got.State.Blockers) != 1 || got.State.Blockers[0].RequestID != "req-1" {
		t.Fatalf("blockers = %+v", got.State.Blockers)
	}
	if !got.State.Blockers[0].RaisedAt.Equal(at(1)) {
		t.Fatalf("RaisedAt = %v, want %v", got.State.Blockers[0].RaisedAt, at(1))
	}
}

func TestReduceTurnAnswerResumesTheTurn(t *testing.T) {
	state := drive(TurnState{},
		in(SignalPrompt, 0),
		inReq(SignalPermissionRaised, "req-1", 1),
	)

	got := ReduceTurn(state, inReq(SignalAnswered, "req-1", 2))

	if got.State.Phase != PhaseRunning {
		t.Fatalf("phase = %q, want running", got.State.Phase)
	}
	if len(got.Expired) != 0 {
		t.Fatalf("an answered blocker was resolved, not expired: %+v", got.Expired)
	}
	if got.Ended {
		t.Fatal("answering does not end the turn")
	}
}

// The agent withdrawing a prompt ends the wait without ending the turn — the one
// case the old model needed a separate flag for, because "the turn is over" and
// "nothing is waiting for an answer" are not each other's inverse.
func TestReduceTurnWithdrawnPromptLeavesTheTurnRunning(t *testing.T) {
	state := drive(TurnState{},
		in(SignalPrompt, 0),
		inReq(SignalPermissionRaised, "req-1", 1),
	)

	got := ReduceTurn(state, inReq(SignalRequestCancelled, "req-1", 2))

	if got.State.Phase != PhaseRunning {
		t.Fatalf("phase = %q, want running", got.State.Phase)
	}
	if len(got.Expired) != 0 {
		t.Fatalf("a withdrawn blocker was resolved, not expired: %+v", got.Expired)
	}
}

func TestReduceTurnTwoPromptsNeedTwoAnswers(t *testing.T) {
	state := drive(TurnState{},
		in(SignalPrompt, 0),
		inReq(SignalPermissionRaised, "req-1", 1),
		inReq(SignalPermissionRaised, "req-2", 2),
	)
	if len(state.Blockers) != 2 {
		t.Fatalf("setup: blockers = %+v", state.Blockers)
	}

	got := ReduceTurn(state, inReq(SignalAnswered, "req-1", 3))

	if got.State.Phase != PhaseBlocked {
		t.Fatalf("phase = %q, want blocked — one prompt is still on screen", got.State.Phase)
	}
	if len(got.State.Blockers) != 1 || got.State.Blockers[0].RequestID != "req-2" {
		t.Fatalf("blockers = %+v", got.State.Blockers)
	}
}

// A request raised under review is still a request blocking the turn and
// taking an answer — a person's too — but it is not one a person is the only
// one answering. One that is outranks it: the turn waits on every request.
func TestReduceTurnRaisedUnderReview(t *testing.T) {
	state := drive(TurnState{}, in(SignalPrompt, 0))
	reviewing := inReq(SignalPermissionRaised, "req-1", 1)
	reviewing.Reviewing = true

	got := ReduceTurn(state, reviewing)

	if got.State.Phase != PhaseBlocked || !got.State.AwaitingAnswerTo("req-1") || !got.State.AwaitingUserAnswer() {
		t.Fatalf("state = %+v, want a turn blocked on req-1", got.State)
	}
	if !got.State.Blockers[0].Reviewing || got.State.AwaitingPerson() {
		t.Fatalf("blockers = %+v, want req-1 under review and nobody called", got.State.Blockers)
	}

	repeat := ReduceTurn(got.State, inReq(SignalPermissionRaised, "req-1", 2))
	if repeat.Changed || !repeat.State.Blockers[0].Reviewing {
		t.Fatalf("a re-sent request is the same request, still under review: %+v", repeat.State.Blockers)
	}

	mixed := ReduceTurn(got.State, inReq(SignalPermissionRaised, "req-2", 2))
	if !mixed.State.AwaitingPerson() {
		t.Fatal("a request nobody reviews waits on a person, whatever the reviewer does with the other")
	}
	answered := ReduceTurn(mixed.State, inReq(SignalAnswered, "req-2", 3))
	if answered.State.AwaitingPerson() || !answered.State.AwaitingUserAnswer() {
		t.Fatalf("state = %+v, want only req-1 left, under review", answered.State)
	}
}

// Under review is part of the turn every client draws: a change to it alone
// is news.
func TestTurnStateEqualComparesReviewing(t *testing.T) {
	plain := drive(TurnState{}, in(SignalPrompt, 0), inReq(SignalPermissionRaised, "req-1", 1))
	reviewed := plain
	reviewed.Blockers = []Blocker{plain.Blockers[0]}
	reviewed.Blockers[0].Reviewing = true
	if plain.equal(reviewed) {
		t.Fatal("two turns differing in what is under review compare equal")
	}
}

// A CLI that has not had an answer re-sends the same control request.
func TestReduceTurnRepeatedRequestIDIsOneBlocker(t *testing.T) {
	state := drive(TurnState{},
		in(SignalPrompt, 0),
		inReq(SignalPermissionRaised, "req-1", 1),
	)

	repeat := ReduceTurn(state, inReq(SignalPermissionRaised, "req-1", 2))
	if len(repeat.State.Blockers) != 1 {
		t.Fatalf("blockers = %+v, want the one prompt", repeat.State.Blockers)
	}
	if repeat.Changed {
		t.Fatal("a repeat of a prompt already on screen says nothing new")
	}
	if !repeat.State.Blockers[0].RaisedAt.Equal(at(1)) {
		t.Fatal("a repeat must not restart the blocker's clock")
	}

	answered := ReduceTurn(repeat.State, inReq(SignalAnswered, "req-1", 3))
	if answered.State.Phase != PhaseRunning {
		t.Fatalf("phase = %q, want running — one answer clears one prompt", answered.State.Phase)
	}
}

// A prompt raised after the turn already reported its end has no turn behind it,
// and is still a prompt waiting for an answer.
func TestReduceTurnPromptAfterTheTurnEndedStillBlocks(t *testing.T) {
	state := drive(TurnState{}, in(SignalPrompt, 0), in(SignalDone, 1))

	got := ReduceTurn(state, inReq(SignalPermissionRaised, "req-1", 2))

	if got.State.Phase != PhaseBlocked {
		t.Fatalf("phase = %q, want blocked", got.State.Phase)
	}
	if !got.State.AwaitingUserAnswer() {
		t.Fatal("the prompt is still waiting for an answer")
	}
	if got.State.InProgress() {
		t.Fatal("there is no turn behind the prompt; the one it belonged to ended")
	}
}

// The pair of the case above, and the reason TurnState.Open exists: withdrawing
// a prompt that outlived its turn leaves the session idle. Reading a withdrawal
// as "the turn carries on" would leave a session running with nothing to end it
// — which is a process the reaper can never collect.
func TestReduceTurnWithdrawingAPostTurnPromptLeavesTheSessionIdle(t *testing.T) {
	state := drive(TurnState{},
		in(SignalPrompt, 0),
		in(SignalDone, 1),
		inReq(SignalPermissionRaised, "req-1", 2),
	)

	got := ReduceTurn(state, inReq(SignalRequestCancelled, "req-1", 3))

	if got.State.Phase != PhaseIdle {
		t.Fatalf("phase = %q, want idle", got.State.Phase)
	}
	if got.State.InProgress() {
		t.Fatal("withdrawing a prompt must not invent a turn")
	}
	if got.Ended {
		t.Fatal("nothing ended: the turn was already over")
	}
}

// A cancellation for a prompt nobody raised — a CLI withdrawing a request the
// session never saw — must not start a turn either.
func TestReduceTurnCancellationThatClearsNothingChangesNothing(t *testing.T) {
	got := ReduceTurn(TurnState{}, inReq(SignalRequestCancelled, "req-1", 0))

	if got.Changed {
		t.Fatalf("state = %+v, want it untouched", got.State)
	}
}

// --- Background ---

func TestReduceTurnBackgroundBlocksRatherThanLooksBusy(t *testing.T) {
	state := drive(TurnState{}, in(SignalPrompt, 0))

	got := ReduceTurn(state, in(SignalBackgroundParked, 1))

	if got.State.Phase != PhaseBlocked {
		t.Fatalf("phase = %q, want blocked", got.State.Phase)
	}
	if !got.State.WaitingForBackground() {
		t.Fatal("the turn is parked on background work")
	}
	if got.State.AwaitingUserAnswer() {
		t.Fatal("there is nothing for the user to answer")
	}
}

// The whole reason `system` is a signal of its own: the background task list
// changing is a `system` frame, so reading it as resumption would make a task
// finishing look like the turn coming back.
func TestReduceTurnNoiseDoesNotEndABackgroundWait(t *testing.T) {
	state := drive(TurnState{}, in(SignalPrompt, 0), in(SignalBackgroundParked, 1))

	got := ReduceTurn(state, in(SignalNoise, 2))

	if got.State.Phase != PhaseBlocked || !got.State.WaitingForBackground() {
		t.Fatalf("phase = %q blockers = %+v, want still parked", got.State.Phase, got.State.Blockers)
	}
	if got.Changed {
		t.Fatal("noise during a background wait changes nothing")
	}
}

func TestReduceTurnOutputEndsABackgroundWait(t *testing.T) {
	state := drive(TurnState{}, in(SignalPrompt, 0), in(SignalBackgroundParked, 1))

	got := ReduceTurn(state, in(SignalOutput, 2))

	if got.State.Phase != PhaseRunning {
		t.Fatalf("phase = %q, want running", got.State.Phase)
	}
	if !got.State.Since.Equal(at(2)) {
		t.Fatalf("Since = %v, want the moment the wait ended %v", got.State.Since, at(2))
	}
	if len(got.Expired) != 0 {
		t.Fatalf("a background wait the CLI resumed from was resolved, not expired: %+v", got.Expired)
	}
}

// Output clears the background wait and leaves a prompt alone: the two are
// cleared by different things, and a turn can hold both at once.
func TestReduceTurnOutputDoesNotClearAPrompt(t *testing.T) {
	state := drive(TurnState{},
		in(SignalPrompt, 0),
		in(SignalBackgroundParked, 1),
		inReq(SignalPermissionRaised, "req-1", 2),
	)

	got := ReduceTurn(state, in(SignalOutput, 3))

	if got.State.Phase != PhaseBlocked {
		t.Fatalf("phase = %q, want blocked", got.State.Phase)
	}
	if got.State.WaitingForBackground() {
		t.Fatal("output ends the background wait")
	}
	if !got.State.AwaitingUserAnswer() {
		t.Fatal("output does not answer a permission request")
	}
}

func TestReduceTurnOneBackgroundBlockerPerSession(t *testing.T) {
	state := drive(TurnState{},
		in(SignalPrompt, 0),
		in(SignalBackgroundParked, 1),
		in(SignalBackgroundParked, 2),
	)

	if len(state.Blockers) != 1 {
		t.Fatalf("blockers = %+v, want one background blocker", state.Blockers)
	}
	if !state.Blockers[0].RaisedAt.Equal(at(1)) {
		t.Fatal("a second park must not restart the wait's clock")
	}
}

// --- Process death ---

func TestReduceTurnProcessDeathExpiresBlockersAndAbortsTheTurn(t *testing.T) {
	state := drive(TurnState{},
		in(SignalPrompt, 0),
		inReq(SignalPermissionRaised, "req-1", 1),
		in(SignalBackgroundParked, 2),
	)

	got := ReduceTurn(state, in(SignalProcessEnded, 3))

	if got.State.Phase != PhaseIdle {
		t.Fatalf("phase = %q, want idle", got.State.Phase)
	}
	if len(got.State.Blockers) != 0 {
		t.Fatalf("blockers = %+v, want none — they belonged to the dead process", got.State.Blockers)
	}
	if len(got.Expired) != 2 {
		t.Fatalf("expired = %+v, want both blockers reported", got.Expired)
	}
	if !got.Ended || got.State.LastOutcome != OutcomeAborted {
		t.Fatalf("ended=%v outcome=%q, want true/aborted", got.Ended, got.State.LastOutcome)
	}
}

func TestReduceTurnProcessDeathWhileIdleEndsNothing(t *testing.T) {
	state := drive(TurnState{}, in(SignalPrompt, 0), in(SignalDone, 1))

	got := ReduceTurn(state, in(SignalProcessEnded, 2))

	if got.Ended {
		t.Fatal("a process reaped while idle did not abort a turn")
	}
	if got.State.LastOutcome != OutcomeCompleted {
		t.Fatalf("outcome = %q, want the completed turn's own outcome", got.State.LastOutcome)
	}
	if got.Changed {
		t.Fatal("nothing about the session changed")
	}
}

// A prompt still on screen when the process dies expires even though no turn was
// running behind it — the case that has no turn to notice the death for it.
func TestReduceTurnProcessDeathExpiresAPromptWithNoTurn(t *testing.T) {
	state := drive(TurnState{},
		in(SignalPrompt, 0),
		in(SignalDone, 1),
		inReq(SignalPermissionRaised, "req-1", 2),
	)

	got := ReduceTurn(state, in(SignalProcessEnded, 3))

	if len(got.Expired) != 1 || got.Expired[0].RequestID != "req-1" {
		t.Fatalf("expired = %+v, want the unanswered prompt", got.Expired)
	}
	if got.State.AwaitingUserAnswer() {
		t.Fatal("nothing can answer a prompt whose process is gone")
	}
}

// Sending a message instead of answering abandons the prompt: the answer is not
// coming, so the blocker expires rather than lingering for one that never
// arrives.
//
// The send path refuses a user's message in this state (chat.ErrTurnAwaitingAnswer),
// because the CLI would not read it — but the rule is the reducer's and holds for
// every way a prompt can arrive, including the race that check cannot close.
func TestReduceTurnPromptOvertakesAnUnansweredBlocker(t *testing.T) {
	state := drive(TurnState{},
		in(SignalPrompt, 0),
		inReq(SignalPermissionRaised, "req-1", 1),
	)

	got := ReduceTurn(state, in(SignalPrompt, 2))

	if got.State.Phase != PhaseRunning {
		t.Fatalf("phase = %q, want running", got.State.Phase)
	}
	if len(got.Expired) != 1 || got.Expired[0].RequestID != "req-1" {
		t.Fatalf("expired = %+v, want the abandoned prompt", got.Expired)
	}
}

// --- Normalization ---

// A session index written before the `question` blocker was removed can still
// hold one, and a blocker kind this build does not know must not survive the load
// — a turn reporting a blocker nothing can clear is a session stuck forever.
// Nothing special is needed for it: the restart repair clears *every* blocker,
// whatever its kind, because none of them outlives its process.
func TestNormalizeTurnClearsABlockerKindThisBuildNoLongerHas(t *testing.T) {
	stored := TurnState{
		Phase: PhaseBlocked,
		Open:  true,
		Blockers: []Blocker{
			{Kind: BlockerKind("question"), RequestID: "old-1", RaisedAt: at(1)},
		},
		Since: at(1),
	}

	got := NormalizeTurn(stored, at(10))

	if len(got.State.Blockers) != 0 {
		t.Fatalf("blockers = %+v, want the stored one gone", got.State.Blockers)
	}
	if got.State.Phase != PhaseIdle {
		t.Fatalf("phase = %q, want idle", got.State.Phase)
	}
	if len(got.Expired) != 1 || got.Expired[0].RequestID != "old-1" {
		t.Fatalf("expired = %+v, want it reported so the card is settled", got.Expired)
	}
}

func TestNormalizeTurnAbortsWhatTheRestartTookAway(t *testing.T) {
	stored := drive(TurnState{},
		in(SignalPrompt, 0),
		inReq(SignalPermissionRaised, "req-1", 1),
	)

	got := NormalizeTurn(stored, at(10))

	if got.State.Phase != PhaseIdle || len(got.State.Blockers) != 0 {
		t.Fatalf("state = %+v, want an idle session with nothing in its way", got.State)
	}
	if got.State.LastOutcome != OutcomeAborted {
		t.Fatalf("outcome = %q, want aborted", got.State.LastOutcome)
	}
	if len(got.Expired) != 1 {
		t.Fatalf("expired = %+v, want the prompt nobody can answer now", got.Expired)
	}
	if !got.Changed {
		t.Fatal("the stored state was wrong and has been repaired")
	}
}

// A session written by a build without turn state reads back as the zero value,
// and the repair must be a no-op for it rather than inventing an aborted turn.
func TestNormalizeTurnLeavesAnIdleSessionAlone(t *testing.T) {
	got := NormalizeTurn(TurnState{}, at(10))

	if got.Changed {
		t.Fatalf("state = %+v, want it untouched", got.State)
	}
	if got.Ended {
		t.Fatal("there was no turn to end")
	}
}

// A process starting finds nothing of its predecessor's, which is the same
// repair applied one session at a time.
func TestReduceTurnProcessStartExpiresAPreviousIncarnationsBlockers(t *testing.T) {
	stored := drive(TurnState{},
		in(SignalPrompt, 0),
		inReq(SignalPermissionRaised, "req-1", 1),
	)

	got := ReduceTurn(stored, in(SignalProcessStarted, 10))

	if got.State.Phase != PhaseIdle || len(got.State.Blockers) != 0 {
		t.Fatalf("state = %+v, want idle with nothing in its way", got.State)
	}
	if len(got.Expired) != 1 {
		t.Fatalf("expired = %+v, want the previous incarnation's prompt", got.Expired)
	}
}

func TestReduceTurnProcessStartOnAnIdleSessionChangesNothing(t *testing.T) {
	got := ReduceTurn(TurnState{}, in(SignalProcessStarted, 0))

	if got.Changed {
		t.Fatalf("state = %+v, want it untouched", got.State)
	}
}

// --- Purity ---

func TestReduceTurnDoesNotMutateItsInput(t *testing.T) {
	state := drive(TurnState{},
		in(SignalPrompt, 0),
		inReq(SignalPermissionRaised, "req-1", 1),
		inReq(SignalPermissionRaised, "req-2", 2),
	)
	// Copied field by field by the assignment, rather than listed here: a field
	// added to TurnState later is covered without anyone remembering to add it.
	before := state
	before.Blockers = cloneBlockers(state.Blockers)

	ReduceTurn(state, inReq(SignalAnswered, "req-1", 3))

	if !state.equal(before) {
		t.Fatalf("the reducer rewrote the state it was given: %+v", state)
	}
}

// OpenedAt is the turn's clock, so it has to survive what resets Since — a
// block and a resume — and go with the turn, whichever way it ends.
func TestReduceTurnOpenedAtSpansTheTurn(t *testing.T) {
	state := drive(TurnState{},
		in(SignalPrompt, 0),
		inReq(SignalPermissionRaised, "r1", 1),
		inReq(SignalAnswered, "r1", 2),
		in(SignalPrompt, 3),
	)
	if !state.OpenedAt.Equal(at(0)) {
		t.Fatalf("OpenedAt = %v, want the prompt that opened the turn (%v)", state.OpenedAt, at(0))
	}
	if !state.Since.Equal(at(2)) {
		t.Fatalf("Since = %v, want the resume (%v)", state.Since, at(2))
	}

	for _, ending := range []TurnSignal{SignalDone, SignalInterrupted, SignalProcessEnded, SignalProcessStarted} {
		if got := ReduceTurn(state, in(ending, 4)).State; !got.OpenedAt.IsZero() {
			t.Errorf("%s left OpenedAt = %v, want zero", ending, got.OpenedAt)
		}
	}

	// Output the CLI resumes with by itself opens a turn as well as a prompt does.
	if got := ReduceTurn(TurnState{}, in(SignalOutput, 5)).State; !got.OpenedAt.Equal(at(5)) {
		t.Fatalf("OpenedAt = %v, want %v", got.OpenedAt, at(5))
	}
}

// A turn's id is the one the input that opened it was given, and it holds for
// the whole turn: a prompt joining it, an answer resuming it and the ending all
// happen in the same turn, whatever ids they arrived with. The ending reports
// the turn it ended — the state, cleared by then, cannot.
func TestReduceTurnKeepsTheOpeningInputsTurnID(t *testing.T) {
	opened := ReduceTurn(TurnState{}, TurnInput{Signal: SignalPrompt, TurnID: "t1", At: at(0)})
	if !opened.Started || opened.Turn != "t1" || opened.State.TurnID != "t1" {
		t.Fatalf("opening = started %v, turn %q, state %q; want t1 opened", opened.Started, opened.Turn, opened.State.TurnID)
	}

	state := opened.State
	for _, next := range []TurnInput{
		{Signal: SignalPrompt, TurnID: "t2", At: at(1)},
		{Signal: SignalPermissionRaised, RequestID: "r1", TurnID: "t3", At: at(2)},
		{Signal: SignalAnswered, RequestID: "r1", TurnID: "t4", At: at(3)},
		{Signal: SignalOutput, TurnID: "t5", At: at(4)},
	} {
		transition := ReduceTurn(state, next)
		if transition.Turn != "t1" || transition.State.TurnID != "t1" {
			t.Errorf("%s: turn %q, state %q; want it to stay in t1", next.Signal, transition.Turn, transition.State.TurnID)
		}
		state = transition.State
	}

	ended := ReduceTurn(state, TurnInput{Signal: SignalDone, TurnID: "t6", At: at(5)})
	if !ended.Ended || ended.Turn != "t1" {
		t.Errorf("ending = ended %v, turn %q; want t1 ended", ended.Ended, ended.Turn)
	}
	if ended.State.TurnID != "" {
		t.Errorf("state after the ending holds turn %q, want none open", ended.State.TurnID)
	}

	// Claude writes a second interrupted for one Stop: it ends nothing, so it
	// happened in no turn.
	again := ReduceTurn(ended.State, TurnInput{Signal: SignalDone, TurnID: "t7", At: at(6)})
	if again.Ended || again.Turn != "" {
		t.Errorf("repeated ending = ended %v, turn %q; want no turn", again.Ended, again.Turn)
	}
}

// Every way a turn can begin takes the input's id, and a new turn gets a new
// one: an id is never carried over from the turn before.
func TestReduceTurnEachWayInGivesTheTurnItsInputsID(t *testing.T) {
	afterTurn := drive(TurnState{},
		TurnInput{Signal: SignalPrompt, TurnID: "first", At: at(0)},
		inReq(SignalPermissionRaised, "r1", 1),
		in(SignalDone, 2),
	)
	for _, opening := range []TurnInput{
		{Signal: SignalPrompt, TurnID: "next", At: at(3)},
		{Signal: SignalOutput, TurnID: "next", At: at(3)},
		{Signal: SignalAnswered, RequestID: "r1", TurnID: "next", At: at(3)},
	} {
		transition := ReduceTurn(afterTurn, opening)
		if !transition.Started || transition.Turn != "next" || transition.State.TurnID != "next" {
			t.Errorf("%s: started %v, turn %q; want turn next opened", opening.Signal, transition.Started, transition.Turn)
		}
	}
	if noise := ReduceTurn(afterTurn, TurnInput{Signal: SignalNoise, TurnID: "next", At: at(3)}); noise.Turn != "" {
		t.Errorf("noise after a turn is in turn %q, want none", noise.Turn)
	}
}

// A straggler — content Codex reports after the turn it belongs to ended —
// happened in that turn: the one that ended last, even once a newer one is
// open, and in none once the process that could still report it is gone.
// Unflagged output after an ending is Claude's way in and opens a turn.
func TestReduceTurnAStragglerHappenedInTheTurnThatEndedLast(t *testing.T) {
	straggler := TurnInput{Signal: SignalNoise, AfterTurn: true, At: at(9)}

	ended := drive(TurnState{},
		TurnInput{Signal: SignalPrompt, TurnID: "t1", At: at(0)},
		in(SignalInterrupted, 1),
	)
	if got := ReduceTurn(ended, straggler); got.Turn != "t1" || got.Started || got.Changed {
		t.Errorf("straggler after t1 = turn %q, started %v, changed %v; want t1, moving nothing", got.Turn, got.Started, got.Changed)
	}
	if got := ReduceTurn(ended, in(SignalNoise, 2)); got.Turn != "" {
		t.Errorf("unflagged noise after t1 is in turn %q, want none", got.Turn)
	}
	if got := ReduceTurn(ended, TurnInput{Signal: SignalOutput, TurnID: "claude", At: at(2)}); !got.Started || got.Turn != "claude" {
		t.Errorf("unflagged output after t1 = started %v, turn %q; want turn claude opened", got.Started, got.Turn)
	}

	// The stop's leftovers land after the next prompt has opened t2.
	next := drive(ended, TurnInput{Signal: SignalPrompt, TurnID: "t2", At: at(2)})
	if got := ReduceTurn(next, straggler); got.Turn != "t1" || got.State.TurnID != "t2" {
		t.Errorf("straggler while t2 is open = turn %q, open %q; want t1, with t2 still open", got.Turn, got.State.TurnID)
	}
	if got := ReduceTurn(next, in(SignalNoise, 3)); got.Turn != "t2" {
		t.Errorf("unflagged noise while t2 is open is in turn %q, want t2", got.Turn)
	}

	after2 := drive(next, in(SignalDone, 3))
	if got := ReduceTurn(after2, straggler); got.Turn != "t2" {
		t.Errorf("straggler after t2 is in turn %q, want t2", got.Turn)
	}

	for _, gone := range []TurnSignal{SignalProcessEnded, SignalProcessStarted} {
		// Forgetting the ended turn is not a turn change: nothing the session
		// is doing moved.
		cleared := ReduceTurn(after2, in(gone, 4))
		if cleared.Changed {
			t.Errorf("%s on an idle session reports a change", gone)
		}
		if got := ReduceTurn(cleared.State, straggler); got.Turn != "" {
			t.Errorf("straggler after %s is in turn %q, want none", gone, got.Turn)
		}
	}
	if got := ReduceTurn(TurnState{}, straggler); got.Turn != "" {
		t.Errorf("straggler before any turn ended is in turn %q, want none", got.Turn)
	}
}

// A tool result answers a call the model made, so it continues a turn and never
// opens one. Claude's Stop is the shape that needs this: the interrupt's
// acknowledgement ends the turn, the CLI then refuses each call still in flight,
// and its aborted result is a second ending. The refusals belong to the
// interrupted turn, and the second ending to none — no turn in between.
func TestReduceTurnAToolResultNeverOpensATurn(t *testing.T) {
	ended := drive(TurnState{},
		TurnInput{Signal: SignalPrompt, TurnID: "t1", At: at(0)},
		in(SignalInterrupted, 1),
	)
	refusal := TurnInput{Signal: SignalToolResult, TurnID: "phantom", At: at(2)}
	got := ReduceTurn(ended, refusal)
	if got.Started || got.State.Open || got.Turn != "t1" || got.Changed {
		t.Errorf("refusal after t1 = started %v, open %v, turn %q, changed %v; want t1, moving nothing",
			got.Started, got.State.Open, got.Turn, got.Changed)
	}
	again := ReduceTurn(got.State, refusal)
	if again.Turn != "t1" {
		t.Errorf("second refusal is in turn %q, want t1", again.Turn)
	}
	if dup := ReduceTurn(again.State, in(SignalInterrupted, 3)); dup.Ended || dup.Turn != "" {
		t.Errorf("second interrupted = ended %v, turn %q; want the no-turn duplicate", dup.Ended, dup.Turn)
	}

	if got := ReduceTurn(TurnState{}, refusal); got.Started || got.Turn != "" {
		t.Errorf("result before any turn = started %v, turn %q; want nothing", got.Started, got.Turn)
	}

	// Inside a turn it is output: it ends a background wait, and is the open
	// turn's even when an earlier one ended in this process.
	parked := drive(ended,
		TurnInput{Signal: SignalPrompt, TurnID: "t2", At: at(4)},
		in(SignalBackgroundParked, 5),
	)
	resumed := ReduceTurn(parked, refusal)
	if resumed.Turn != "t2" || resumed.State.Phase != PhaseRunning {
		t.Errorf("result while t2 is parked = turn %q, phase %q; want t2, running", resumed.Turn, resumed.State.Phase)
	}
}

func TestEndsTurnIsWhatReduceTurnEndsOn(t *testing.T) {
	all := []TurnSignal{
		SignalProcessStarted, SignalPrompt, SignalOutput, SignalToolResult,
		SignalNoise, SignalPermissionRaised, SignalBackgroundParked,
		SignalRequestCancelled, SignalAnswered, SignalDone, SignalFailed,
		SignalAuthFailed, SignalInterrupted, SignalQuestionPosted,
		SignalQuestionResolved, SignalMessageDiscarded, SignalProcessEnded,
	}
	open := drive(NewTurnState(at(0)), in(SignalPrompt, 1))
	for _, sig := range all {
		ended := ReduceTurn(open, inReq(sig, "r1", 2)).Ended
		if ended != sig.EndsTurn() {
			t.Errorf("%s: ReduceTurn ends an open turn = %v, EndsTurn = %v", sig, ended, sig.EndsTurn())
		}
	}
}
