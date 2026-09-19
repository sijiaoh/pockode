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
		inReq(SignalQuestionRaised, "req-1", 1),
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

	got := ReduceTurn(state, inReq(SignalQuestionRaised, "req-1", 2))

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
		inReq(SignalQuestionRaised, "req-1", 1),
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
		inReq(SignalQuestionRaised, "req-1", 1),
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

func TestNormalizeTurnAbortsWhatTheRestartTookAway(t *testing.T) {
	stored := drive(TurnState{},
		in(SignalPrompt, 0),
		inReq(SignalQuestionRaised, "req-1", 1),
	)

	got := NormalizeTurn(stored, at(10))

	if got.State.Phase != PhaseIdle || len(got.State.Blockers) != 0 {
		t.Fatalf("state = %+v, want an idle session with nothing in its way", got.State)
	}
	if got.State.LastOutcome != OutcomeAborted {
		t.Fatalf("outcome = %q, want aborted", got.State.LastOutcome)
	}
	if len(got.Expired) != 1 {
		t.Fatalf("expired = %+v, want the question nobody can answer now", got.Expired)
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
