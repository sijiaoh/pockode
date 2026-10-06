package session

import (
	"testing"
	"time"
)

func postedQuestion(id string, at time.Time) PendingQuestion {
	return PendingQuestion{
		RequestID: id,
		Header:    "Database",
		Question:  "Which database?",
		Options:   []QuestionOption{{Label: "Postgres"}, {Label: "SQLite"}},
		AskedAt:   at,
	}
}

func post(state TurnState, id string, at time.Time) TurnState {
	q := postedQuestion(id, at)
	return ReduceTurn(state, TurnInput{Signal: SignalQuestionPosted, Question: &q, At: at}).State
}

func requestIDs(questions []PendingQuestion) []string {
	ids := make([]string, len(questions))
	for i, q := range questions {
		ids[i] = q.RequestID
	}
	return ids
}

func assertUnanswered(t *testing.T, state TurnState, want ...string) {
	t.Helper()
	got := requestIDs(state.Unanswered)
	if len(got) != len(want) {
		t.Fatalf("unanswered = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("unanswered = %v, want %v", got, want)
		}
	}
}

// TestReduceTurn_PostedQuestionsAreNotBlockers is the whole distinction this
// list exists for. A posted question does not stop the turn: the agent asked and
// carried on, so the phase is whatever it would have been, and the composer, the
// spinner and the lease all read the same as before.
func TestReduceTurn_PostedQuestionsAreNotBlockers(t *testing.T) {
	now := time.Now()

	idle := post(NewTurnState(now), "req-1", now)
	if idle.Phase != PhaseIdle {
		t.Errorf("phase = %q, want a posted question to leave an idle session idle", idle.Phase)
	}

	running := ReduceTurn(NewTurnState(now), TurnInput{Signal: SignalPrompt, At: now}).State
	running = post(running, "req-1", now)
	if running.Phase != PhaseRunning {
		t.Errorf("phase = %q, want a posted question to leave a running turn running", running.Phase)
	}
	if len(running.Blockers) != 0 {
		t.Errorf("blockers = %v, want a posted question not to be one", running.Blockers)
	}
	if running.AwaitingUserAnswer() {
		t.Error("AwaitingUserAnswer = true, want a posted question not to hold the send path shut")
	}
}

// TestReduceTurn_PostedQuestionsOutliveTheProcess is the other half: a blocker
// belongs to the process that raised it and expires with it, a posted question
// belongs to the session. Every signal that clears blockers is checked here,
// because the failure mode is one of them quietly taking the questions too — and
// a question that vanished when a CLI was reaped is one nobody can answer and
// nobody was told about.
func TestReduceTurn_PostedQuestionsOutliveTheProcess(t *testing.T) {
	now := time.Now()

	clearing := []TurnSignal{
		SignalProcessStarted, SignalProcessEnded, SignalPrompt,
		SignalDone, SignalFailed, SignalInterrupted,
	}
	for _, signal := range clearing {
		t.Run(string(signal), func(t *testing.T) {
			state := ReduceTurn(NewTurnState(now), TurnInput{Signal: SignalPrompt, At: now}).State
			state = post(state, "req-1", now)
			state = ReduceTurn(state, TurnInput{
				Signal: SignalPermissionRaised, RequestID: "perm-1", At: now,
			}).State

			after := ReduceTurn(state, TurnInput{Signal: signal, At: now.Add(time.Second)})
			if len(after.State.Blockers) != 0 {
				t.Errorf("blockers = %v, want the permission request gone", after.State.Blockers)
			}
			assertUnanswered(t, after.State, "req-1")
		})
	}
}

// TestNormalizeTurn_KeepsPostedQuestions is the same rule applied to the whole
// index at startup: a restart aborts every turn it finds open, and must not take
// the unanswered questions with it.
func TestNormalizeTurn_KeepsPostedQuestions(t *testing.T) {
	now := time.Now()
	stored := post(ReduceTurn(NewTurnState(now), TurnInput{Signal: SignalPrompt, At: now}).State, "req-1", now)

	after := NormalizeTurn(stored, now.Add(time.Hour)).State
	if after.Phase != PhaseIdle || after.LastOutcome != OutcomeAborted {
		t.Errorf("phase/outcome = %q/%q, want the open turn aborted", after.Phase, after.LastOutcome)
	}
	assertUnanswered(t, after, "req-1")
}

func TestReduceTurn_QuestionsAreListedOldestFirst(t *testing.T) {
	now := time.Now()
	state := post(post(NewTurnState(now), "req-1", now), "req-2", now.Add(time.Minute))
	assertUnanswered(t, state, "req-1", "req-2")
}

// TestReduceTurn_PostingTheSameRequestTwiceChangesNothing: ids are
// server-generated so this cannot happen by accident, but a list holding one
// question twice would need two answers to clear and would say "2 to answer"
// about one question.
func TestReduceTurn_PostingTheSameRequestTwiceChangesNothing(t *testing.T) {
	now := time.Now()
	state := post(NewTurnState(now), "req-1", now)
	again := ReduceTurn(state, TurnInput{
		Signal: SignalQuestionPosted, Question: ptr(postedQuestion("req-1", now)), At: now,
	})
	assertUnanswered(t, again.State, "req-1")
	if again.Changed {
		t.Error("Changed = true, want a repeat post to be a no-op")
	}
}

func TestReduceTurn_ResolveRemovesOnlyTheQuestionNamed(t *testing.T) {
	now := time.Now()
	state := post(post(NewTurnState(now), "req-1", now), "req-2", now)

	after := ReduceTurn(state, TurnInput{
		Signal: SignalQuestionResolved, RequestID: "req-1", At: now,
	})
	if !after.Changed {
		t.Error("Changed = false, want resolving a listed question to move the state")
	}
	assertUnanswered(t, after.State, "req-2")
}

// TestReduceTurn_ResolvingAQuestionTwiceIsNotAnError: a user answering and an
// agent withdrawing can reach the same question at once, and the loser must be a
// no-op rather than a failure.
func TestReduceTurn_ResolvingAQuestionTwiceIsNotAnError(t *testing.T) {
	now := time.Now()
	state := post(NewTurnState(now), "req-1", now)
	state = ReduceTurn(state, TurnInput{Signal: SignalQuestionResolved, RequestID: "req-1", At: now}).State

	again := ReduceTurn(state, TurnInput{Signal: SignalQuestionResolved, RequestID: "req-1", At: now})
	if again.Changed {
		t.Error("Changed = true, want the second resolution to move nothing")
	}
	assertUnanswered(t, again.State)
}

// TestReduceTurn_AnsweringABlockerLeavesPostedQuestionsAlone: the two share a
// vocabulary of request ids, and SignalAnswered must not reach into the list an
// answer to a *posted* question is not delivered through.
func TestReduceTurn_AnsweringABlockerLeavesPostedQuestionsAlone(t *testing.T) {
	now := time.Now()
	state := post(NewTurnState(now), "req-1", now)
	after := ReduceTurn(state, TurnInput{Signal: SignalAnswered, RequestID: "req-1", At: now})
	assertUnanswered(t, after.State, "req-1")
}

func TestTurnState_PendingQuestionFor(t *testing.T) {
	now := time.Now()
	state := post(NewTurnState(now), "req-1", now)

	q, found := state.PendingQuestionFor("req-1")
	if !found || q.Question != "Which database?" {
		t.Errorf("PendingQuestionFor = %+v/%v, want the posted question", q, found)
	}
	if _, found := state.PendingQuestionFor("req-2"); found {
		t.Error("PendingQuestionFor(unknown) found something")
	}
	// An empty id matches nothing: every blocker without a request id would
	// otherwise be answerable by a caller that sent no id at all.
	if _, found := state.PendingQuestionFor(""); found {
		t.Error(`PendingQuestionFor("") found something`)
	}
}

func ptr[T any](v T) *T { return &v }

func answerIn(state TurnState, id, messageID string, at time.Time) TurnState {
	return ReduceTurn(state, TurnInput{
		Signal: SignalQuestionResolved, RequestID: id, MessageID: messageID, At: at,
	}).State
}

func discard(state TurnState, messageID string, at time.Time) TurnTransition {
	return ReduceTurn(state, TurnInput{Signal: SignalMessageDiscarded, MessageID: messageID, At: at})
}

// TestReduceTurn_DiscardedAnswerReopensItsQuestions is the case Delivered
// exists for: the answer reached the CLI, so the question left the list, and
// then a Stop threw the message away unread. The question is the user's to
// answer again — and only the ones that message answered.
func TestReduceTurn_DiscardedAnswerReopensItsQuestions(t *testing.T) {
	now := time.Now()
	state := ReduceTurn(NewTurnState(now), TurnInput{Signal: SignalPrompt, At: now}).State
	state = post(state, "req-1", now)
	state = post(state, "req-2", now)
	state = post(state, "req-3", now)

	state = answerIn(state, "req-1", "msg-a", now)
	state = answerIn(state, "req-2", "msg-b", now)
	assertUnanswered(t, state, "req-3")

	tr := discard(state, "msg-a", now)
	if !tr.Changed {
		t.Error("Changed = false, want a question coming back to be announced")
	}
	// Appended: it reaches the user again now, after what was already waiting.
	assertUnanswered(t, tr.State, "req-3", "req-1")
	if q, _ := tr.State.PendingQuestionFor("req-1"); q.Question != "Which database?" || len(q.Options) != 2 {
		t.Errorf("reopened question = %+v, want it whole, as it was posted", q)
	}
	if tr.State.Phase != PhaseRunning {
		t.Errorf("phase = %q, want the discard to leave the turn to the interrupt behind it", tr.State.Phase)
	}

	// Ending the turn settles msg-b as read: a later discard naming it is
	// nothing to do with any question.
	ended := ReduceTurn(tr.State, TurnInput{Signal: SignalInterrupted, At: now}).State
	assertUnanswered(t, discard(ended, "msg-b", now).State, "req-3", "req-1")
}

// TestReduceTurn_EveryTurnEndingSettlesDeliveredAnswers: a message the CLI took
// in before its turn ended has been read, so no later discard can bring its
// questions back. Every way a turn ends is checked, because the failure is one
// of them leaving an answer the agent did read open to being taken back.
func TestReduceTurn_EveryTurnEndingSettlesDeliveredAnswers(t *testing.T) {
	now := time.Now()
	endings := []TurnSignal{
		SignalDone, SignalFailed, SignalAuthFailed, SignalInterrupted,
		SignalProcessEnded, SignalProcessStarted,
	}
	for _, sig := range endings {
		t.Run(string(sig), func(t *testing.T) {
			state := ReduceTurn(NewTurnState(now), TurnInput{Signal: SignalPrompt, At: now}).State
			state = answerIn(post(state, "req-1", now), "req-1", "msg-a", now)
			state = ReduceTurn(state, TurnInput{Signal: sig, At: now}).State
			if len(state.Delivered) != 0 {
				t.Errorf("delivered = %v, want none once the turn is over", state.Delivered)
			}
			assertUnanswered(t, discard(state, "msg-a", now).State)
		})
	}
}

// TestReduceTurn_WithdrawingLetsGoOfDeliveredAnswers: resolving with no message
// is a withdrawal (a step completing, a work closing), and it reaches a
// question whose answer is still in flight — otherwise a Stop afterwards would
// bring it back onto a step that is over.
func TestReduceTurn_WithdrawingLetsGoOfDeliveredAnswers(t *testing.T) {
	now := time.Now()
	state := ReduceTurn(NewTurnState(now), TurnInput{Signal: SignalPrompt, At: now}).State
	state = answerIn(post(state, "req-1", now), "req-1", "msg-a", now)

	state = answerIn(state, "req-1", "", now)
	if len(state.Delivered) != 0 {
		t.Fatalf("delivered = %v, want the withdrawal to let it go", state.Delivered)
	}
	assertUnanswered(t, discard(state, "msg-a", now).State)
}

// TestReduceTurn_AnswerToAnUnlistedQuestionHoldsNothing: two answers racing for
// one question are both accepted (chat.SendAnswers), and only the one that
// took it off the list holds it. Otherwise discarding the loser alone would
// reopen a question the winner's answer is still on its way to.
func TestReduceTurn_AnswerToAnUnlistedQuestionHoldsNothing(t *testing.T) {
	now := time.Now()
	state := ReduceTurn(NewTurnState(now), TurnInput{Signal: SignalPrompt, At: now}).State
	state = answerIn(post(state, "req-1", now), "req-1", "msg-a", now)
	state = answerIn(state, "req-1", "msg-b", now)

	assertUnanswered(t, discard(state, "msg-b", now).State)
}

// TestNormalizeTurn_DropsDeliveredAnswers: no process survives a restart, so
// no Stop can discard anything sent before it.
func TestNormalizeTurn_DropsDeliveredAnswers(t *testing.T) {
	now := time.Now()
	state := ReduceTurn(NewTurnState(now), TurnInput{Signal: SignalPrompt, At: now}).State
	state = answerIn(post(state, "req-1", now), "req-1", "msg-a", now)

	if got := NormalizeTurn(state, now).State.Delivered; len(got) != 0 {
		t.Errorf("delivered = %v, want none after a restart", got)
	}
}
