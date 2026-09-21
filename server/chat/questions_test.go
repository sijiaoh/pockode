package chat

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/session"
)

type questionFixture struct {
	store      session.Store
	client     *Client
	agent      *mockAgent
	broadcasts []agent.EventRecord
}

func newQuestionFixture(t *testing.T) *questionFixture {
	t.Helper()

	store, err := session.NewFileStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	pm, ag := newTestManagerWithAgent(t, store)
	t.Cleanup(pm.Shutdown)

	if _, err := store.Create(context.Background(), "sess",
		session.CreateSpec{AgentType: session.AgentTypeClaude, Mode: session.ModeDefault}); err != nil {
		t.Fatalf("Create session: %v", err)
	}

	f := &questionFixture{store: store, client: NewClient(store, pm), agent: ag}
	f.client.SetBroadcaster(func(_ string, record agent.EventRecord, _ session.HistorySeq, _ any) {
		f.broadcasts = append(f.broadcasts, record)
	})
	return f
}

func (f *questionFixture) post(t *testing.T, header string) string {
	t.Helper()
	q, err := f.client.PostQuestion(context.Background(), "sess", QuestionSpec{
		Header:   header,
		Question: "Which database?",
		Options:  []session.QuestionOption{{Label: "Postgres"}, {Label: "SQLite"}},
	})
	if err != nil {
		t.Fatalf("PostQuestion: %v", err)
	}
	return q.RequestID
}

func (f *questionFixture) unanswered(t *testing.T) []session.PendingQuestion {
	t.Helper()
	meta, found, err := f.store.Get("sess")
	if err != nil || !found {
		t.Fatalf("Get session = %v/%v", found, err)
	}
	return meta.Turn.Unanswered
}

func (f *questionFixture) records(t *testing.T) []agent.EventRecord {
	t.Helper()
	raw, err := f.store.GetHistory(context.Background(), "sess")
	if err != nil {
		t.Fatalf("GetHistory: %v", err)
	}
	out := make([]agent.EventRecord, 0, len(raw))
	for _, r := range raw {
		var rec agent.EventRecord
		if err := json.Unmarshal(r, &rec); err != nil {
			t.Fatalf("unmarshal record: %v", err)
		}
		out = append(out, rec)
	}
	return out
}

// waitFor spins until cond holds. Events reach the store on the process's own
// goroutine, so a push has not been reduced yet when it returns.
// waitFor polls until the condition holds, with a deliberately loose backstop.
//
// What is being waited for here crosses a spawned agent, the process manager's
// event goroutines and the session store, and it normally lands in single-digit
// milliseconds — so the number is not a budget for the operation, it is the
// point at which "this is never going to happen" is a safer conclusion than
// "the machine is busy". Two seconds was that point until a `go test ./...`
// run, where every package's binary competes for the box, missed it once
// (docs/testing.md, "Go: there is no equivalent knob"). A loose backstop costs
// a passing run nothing.
func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("timed out waiting for the condition to hold")
}

// TestPostQuestion_RecordsAndWaits is the two halves of posting: an immutable
// record of the asking, and a live list entry that someone can clear. Both, or
// the question is either unanswerable or unexplainable.
func TestPostQuestion_RecordsAndWaits(t *testing.T) {
	f := newQuestionFixture(t)
	id := f.post(t, "Database")

	pending := f.unanswered(t)
	if len(pending) != 1 || pending[0].RequestID != id {
		t.Fatalf("unanswered = %+v, want the posted question", pending)
	}
	if pending[0].AskedAt.IsZero() {
		t.Error("asked_at is zero, want the moment it was posted")
	}

	records := f.records(t)
	if len(records) != 1 || records[0].Type != agent.EventTypeQuestionPosted {
		t.Fatalf("records = %+v, want one question_posted", records)
	}
	if records[0].RequestID != id {
		t.Errorf("record request_id = %q, want %q", records[0].RequestID, id)
	}
	// One question per record, which is what gives "decline this one" a subject.
	if len(records[0].Questions) != 1 {
		t.Errorf("record questions = %d, want exactly one", len(records[0].Questions))
	}

	// Posting starts no process: the agent that asked is already running, and a
	// CLI spawned to hold a question would be one nothing ever ends.
	if got := len(f.agent.sessions); got != 0 {
		t.Errorf("agent sessions started = %d, want none", got)
	}
	if len(f.broadcasts) != 1 || f.broadcasts[0].Type != agent.EventTypeQuestionPosted {
		t.Errorf("broadcasts = %+v, want the card pushed to open chats", f.broadcasts)
	}
}

func TestPostQuestion_SeveralAtOnce(t *testing.T) {
	f := newQuestionFixture(t)
	first := f.post(t, "Database")
	second := f.post(t, "Runtime")

	pending := f.unanswered(t)
	if len(pending) != 2 || pending[0].RequestID != first || pending[1].RequestID != second {
		t.Fatalf("unanswered = %+v, want both, oldest first", pending)
	}
	if first == second {
		t.Error("two questions share a request id")
	}
}

func TestPostQuestion_UnknownSession(t *testing.T) {
	f := newQuestionFixture(t)
	_, err := f.client.PostQuestion(context.Background(), "nope", QuestionSpec{Header: "h", Question: "q"})
	if !errors.Is(err, ErrSessionNotFound) {
		t.Errorf("error = %v, want ErrSessionNotFound", err)
	}
}

// TestCancelQuestion_WithdrawsWithoutTellingAnyone is the difference from a
// decline: the agent took its own question back, so there is nothing to send.
func TestCancelQuestion_WithdrawsWithoutTellingAnyone(t *testing.T) {
	f := newQuestionFixture(t)
	id := f.post(t, "Database")

	if err := f.client.CancelQuestion(context.Background(), "sess", id); err != nil {
		t.Fatalf("CancelQuestion: %v", err)
	}
	if got := f.unanswered(t); len(got) != 0 {
		t.Errorf("unanswered = %+v, want the question gone", got)
	}

	records := f.records(t)
	last := records[len(records)-1]
	if last.Type != agent.EventTypeRequestCancelled || last.RequestID != id {
		t.Errorf("last record = %+v, want the withdrawal", last)
	}
	if last.ResolvedAt == nil || last.ResolvedAt.IsZero() {
		t.Error("resolved_at is absent, want the moment of the withdrawal")
	}
	if got := len(f.agent.sessions); got != 0 {
		t.Errorf("agent sessions started = %d, want a withdrawal to send nothing", got)
	}
}

// TestCancelQuestion_AlreadyResolved: the refusal has to say what became of the
// question, because "not pending" alone reads to an agent as "try again".
func TestCancelQuestion_AlreadyResolved(t *testing.T) {
	f := newQuestionFixture(t)
	id := f.post(t, "Database")
	if err := f.client.CancelQuestion(context.Background(), "sess", id); err != nil {
		t.Fatalf("CancelQuestion: %v", err)
	}

	err := f.client.CancelQuestion(context.Background(), "sess", id)
	if !errors.Is(err, ErrQuestionNotPending) {
		t.Fatalf("error = %v, want ErrQuestionNotPending", err)
	}
	if !strings.Contains(err.Error(), "withdrawn by the agent") {
		t.Errorf("error = %q, want it to say what became of the question", err)
	}
}

func TestCancelQuestion_NeverAsked(t *testing.T) {
	f := newQuestionFixture(t)
	err := f.client.CancelQuestion(context.Background(), "sess", "req-nobody")
	if !errors.Is(err, ErrQuestionNotPending) {
		t.Fatalf("error = %v, want ErrQuestionNotPending", err)
	}
	if !strings.Contains(err.Error(), "not one of this session's open questions") {
		t.Errorf("error = %q, want the honest answer for a request nothing recorded", err)
	}
}

// TestWithdrawQuestions_TakesBackEverything is what a work closing does: nobody
// is coming back, and a question left pending on a finished work is one the user
// can never clear.
func TestWithdrawQuestions_TakesBackEverything(t *testing.T) {
	f := newQuestionFixture(t)
	f.post(t, "Database")
	f.post(t, "Runtime")

	f.client.WithdrawQuestions(context.Background(), "sess", agent.ReasonWorkClosed)

	if got := f.unanswered(t); len(got) != 0 {
		t.Fatalf("unanswered = %+v, want all of them withdrawn", got)
	}
	withdrawals := 0
	for _, rec := range f.records(t) {
		if rec.Type == agent.EventTypeRequestCancelled {
			withdrawals++
			if rec.Reason != agent.ReasonWorkClosed {
				t.Errorf("reason = %q, want work_closed", rec.Reason)
			}
		}
	}
	if withdrawals != 2 {
		t.Errorf("withdrawals recorded = %d, want one per question", withdrawals)
	}
}

// TestSendMessageAnswering_DeliversAndClears is the answering path end to end:
// the agent is handed the prose, the record carries the structured copy a bubble
// is drawn from, and the questions leave the list.
func TestSendMessageAnswering_DeliversAndClears(t *testing.T) {
	f := newQuestionFixture(t)
	first := f.post(t, "Database")
	second := f.post(t, "Runtime")

	_, err := f.client.SendMessageAnswering(context.Background(), "sess", "Answering: ...", []Answer{
		{RequestID: first, Answers: []string{"Postgres"}},
		{RequestID: second, Declined: true, Note: "not my call"},
	}, nil)
	if err != nil {
		t.Fatalf("SendMessageAnswering: %v", err)
	}

	if got := f.unanswered(t); len(got) != 0 {
		t.Errorf("unanswered = %+v, want both resolved", got)
	}
	if prompts := f.agent.session(t, 1).sentPrompts(); len(prompts) != 1 || prompts[0] != "Answering: ..." {
		t.Errorf("prompts = %q, want the message delivered once", prompts)
	}

	records := f.records(t)
	last := records[len(records)-1]
	if last.Type != agent.EventTypeMessage || len(last.Answering) != 2 {
		t.Fatalf("last record = %+v, want the message carrying both answers", last)
	}
	// The question travels with the answer: the card may be thousands of
	// records back, outside every page the bubble will ever have.
	if last.Answering[0].Header != "Database" || last.Answering[0].Question != "Which database?" {
		t.Errorf("answer = %+v, want the question copied in", last.Answering[0])
	}
	if !last.Answering[1].Declined || last.Answering[1].Note != "not my call" {
		t.Errorf("decline = %+v, want it recorded with its note", last.Answering[1])
	}
	if last.Answering[0].AnsweredAt.IsZero() {
		t.Error("answered_at is zero, want the only clock a question's fate has")
	}
}

// TestSendMessageAnswering_PartialAnswersAreFine: the user may answer two of
// three and come back to the third.
func TestSendMessageAnswering_PartialAnswersAreFine(t *testing.T) {
	f := newQuestionFixture(t)
	first := f.post(t, "Database")
	second := f.post(t, "Runtime")

	if _, err := f.client.SendMessageAnswering(context.Background(), "sess", "one of them", []Answer{
		{RequestID: first, Answers: []string{"SQLite"}},
	}, nil); err != nil {
		t.Fatalf("SendMessageAnswering: %v", err)
	}

	pending := f.unanswered(t)
	if len(pending) != 1 || pending[0].RequestID != second {
		t.Errorf("unanswered = %+v, want only the one that was not answered", pending)
	}
}

// TestSendMessageAnswering_OneResolvedQuestionRefusesTheWholeMessage is the
// contract the composer's draft handling is written against. The content is one
// string written for all the answers together, so delivering the half that is
// still wanted would hand the agent prose answering a question it already has an
// answer to.
func TestSendMessageAnswering_OneResolvedQuestionRefusesTheWholeMessage(t *testing.T) {
	f := newQuestionFixture(t)
	first := f.post(t, "Database")
	second := f.post(t, "Runtime")
	if err := f.client.CancelQuestion(context.Background(), "sess", second); err != nil {
		t.Fatalf("CancelQuestion: %v", err)
	}

	before := len(f.records(t))
	_, err := f.client.SendMessageAnswering(context.Background(), "sess", "both", []Answer{
		{RequestID: first, Answers: []string{"Postgres"}},
		{RequestID: second, Answers: []string{"Node"}},
	}, nil)
	if !errors.Is(err, ErrQuestionNotPending) {
		t.Fatalf("error = %v, want ErrQuestionNotPending", err)
	}
	// Which one, so the client can grey exactly that answer out and keep the
	// rest of the draft.
	if !strings.Contains(err.Error(), second) {
		t.Errorf("error = %q, want it to name the resolved request", err)
	}

	if got := len(f.records(t)); got != before {
		t.Errorf("records = %d, want a refused message to leave no trace (%d)", got, before)
	}
	if pending := f.unanswered(t); len(pending) != 1 || pending[0].RequestID != first {
		t.Errorf("unanswered = %+v, want the still-open question untouched", pending)
	}
	if got := len(f.agent.sessions); got != 0 {
		t.Errorf("agent sessions started = %d, want nothing delivered", got)
	}
}

func TestSendMessageAnswering_ShapeRefusals(t *testing.T) {
	tests := []struct {
		name   string
		answer func(id string) Answer
		want   string
	}{
		{"neither answered nor declined", func(id string) Answer {
			return Answer{RequestID: id}
		}, "answered with nothing"},
		{"answered with nothing but whitespace", func(id string) Answer {
			return Answer{RequestID: id, Text: "   "}
		}, "answered with nothing"},
		{"both answered and declined", func(id string) Answer {
			return Answer{RequestID: id, Answers: []string{"Postgres"}, Declined: true}
		}, "both answered and declined"},
		{"declined with free text beside it", func(id string) Answer {
			return Answer{RequestID: id, Text: "use SQLite", Declined: true}
		}, "both answered and declined"},
		{"an option that was never offered", func(id string) Answer {
			return Answer{RequestID: id, Answers: []string{"MySQL"}}
		}, "does not offer"},
		{"two answers to a single-select question", func(id string) Answer {
			return Answer{RequestID: id, Answers: []string{"Postgres", "SQLite"}}
		}, "takes one answer"},
		{"an option and free text on a single-select question", func(id string) Answer {
			return Answer{RequestID: id, Answers: []string{"Postgres"}, Text: "actually SQLite"}
		}, "takes one answer"},
	}

	t.Run("a free-text question answered with nothing", func(t *testing.T) {
		f := newQuestionFixture(t)
		q, err := f.client.PostQuestion(context.Background(), "sess", QuestionSpec{
			Header: "Name", Question: "What should it be called?",
		})
		if err != nil {
			t.Fatalf("PostQuestion: %v", err)
		}
		id := q.RequestID
		// Recorded as answered, it would read to the agent as "the user said
		// nothing" — which is what declining says properly.
		_, err = f.client.SendMessageAnswering(context.Background(), "sess", "x", []Answer{
			{RequestID: id, Text: "   "},
		}, nil)
		if !errors.Is(err, ErrAnswerShape) {
			t.Fatalf("error = %v, want ErrAnswerShape", err)
		}
		if !strings.Contains(err.Error(), "answered with nothing") {
			t.Errorf("error = %q, want it to say what is missing", err)
		}
	})

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newQuestionFixture(t)
			id := f.post(t, "Database")

			_, err := f.client.SendMessageAnswering(context.Background(), "sess", "x", []Answer{tt.answer(id)}, nil)
			if !errors.Is(err, ErrAnswerShape) {
				t.Fatalf("error = %v, want ErrAnswerShape", err)
			}
			if !strings.Contains(err.Error(), tt.want) {
				t.Errorf("error = %q, want it to contain %q", err, tt.want)
			}
			if pending := f.unanswered(t); len(pending) != 1 {
				t.Errorf("unanswered = %+v, want the question still open", pending)
			}
		})
	}
}

// TestSendMessageAnswering_AResolvedQuestionIsReportedBeforeABadShape: a typo
// in one answer must not hide a question somebody else resolved, or the client
// spends a whole round trip finding out about the second problem after fixing
// the first.
func TestSendMessageAnswering_AResolvedQuestionIsReportedBeforeABadShape(t *testing.T) {
	f := newQuestionFixture(t)
	first := f.post(t, "Database")
	second := f.post(t, "Runtime")
	if err := f.client.CancelQuestion(context.Background(), "sess", second); err != nil {
		t.Fatalf("CancelQuestion: %v", err)
	}

	_, err := f.client.SendMessageAnswering(context.Background(), "sess", "both", []Answer{
		{RequestID: first, Answers: []string{"MySQL"}}, // never offered
		{RequestID: second, Answers: []string{"Node"}}, // already withdrawn
	}, nil)
	if !errors.Is(err, ErrQuestionNotPending) {
		t.Fatalf("error = %v, want the resolved question reported first", err)
	}
	if !strings.Contains(err.Error(), second) {
		t.Errorf("error = %q, want it to name the resolved request", err)
	}
}

// TestSendMessageAnswering_MultiSelectAndFreeText: the two shapes a single
// answer may legitimately have more than one string in.
func TestSendMessageAnswering_MultiSelectAndFreeText(t *testing.T) {
	t.Run("multi select", func(t *testing.T) {
		f := newQuestionFixture(t)
		q, err := f.client.PostQuestion(context.Background(), "sess", QuestionSpec{
			Header: "Targets", Question: "Which?", MultiSelect: true,
			Options: []session.QuestionOption{{Label: "linux"}, {Label: "windows"}},
		})
		if err != nil {
			t.Fatalf("PostQuestion: %v", err)
		}
		id := q.RequestID
		if _, err := f.client.SendMessageAnswering(context.Background(), "sess", "both", []Answer{
			{RequestID: id, Answers: []string{"linux", "windows"}},
		}, nil); err != nil {
			t.Fatalf("SendMessageAnswering: %v", err)
		}
	})

	t.Run("free text", func(t *testing.T) {
		f := newQuestionFixture(t)
		q, err := f.client.PostQuestion(context.Background(), "sess", QuestionSpec{
			Header: "Name", Question: "What should it be called?",
		})
		if err != nil {
			t.Fatalf("PostQuestion: %v", err)
		}
		id := q.RequestID
		// Anything goes: there were no options for it to fail to be one of.
		if _, err := f.client.SendMessageAnswering(context.Background(), "sess", "answer", []Answer{
			{RequestID: id, Text: "whatever I like"},
		}, nil); err != nil {
			t.Fatalf("SendMessageAnswering: %v", err)
		}
	})

	// A question that offered nothing to pick cannot be answered with a label:
	// there is no list a label could have come from, so one here would be a
	// string the agent never offered arriving as though it had.
	t.Run("a label on a question that offered none", func(t *testing.T) {
		f := newQuestionFixture(t)
		q, err := f.client.PostQuestion(context.Background(), "sess", QuestionSpec{
			Header: "Name", Question: "What should it be called?",
		})
		if err != nil {
			t.Fatalf("PostQuestion: %v", err)
		}
		id := q.RequestID
		_, err = f.client.SendMessageAnswering(context.Background(), "sess", "x", []Answer{
			{RequestID: id, Answers: []string{"pockode"}},
		}, nil)
		if !errors.Is(err, ErrAnswerShape) {
			t.Fatalf("error = %v, want ErrAnswerShape", err)
		}
		if !strings.Contains(err.Error(), "answer it as text") {
			t.Errorf("error = %q, want it to say where the answer belongs", err)
		}
	})
}

// The user's own words are accepted beside — or instead of — the options, and
// are recorded apart from them.
//
// This is the whole of what the label check is for. It stops the agent being
// told it was handed back a choice it never gave; it does not stop the user
// saying something else. "None of these, it is X" is an answer, and squeezing it
// into a decline would tell the agent the user refused to answer.
func TestSendMessageAnswering_FreeTextBesideTheOptions(t *testing.T) {
	for _, tt := range []struct {
		name        string
		multiSelect bool
		answer      func(id string) Answer
		wantAnswers []string
		wantText    string
	}{
		{"instead of an option", false, func(id string) Answer {
			return Answer{RequestID: id, Text: "MySQL, and here is why"}
		}, nil, "MySQL, and here is why"},
		{"beside one, on a multi-select question", true, func(id string) Answer {
			return Answer{RequestID: id, Answers: []string{"Postgres"}, Text: "and SQLite in tests"}
		}, []string{"Postgres"}, "and SQLite in tests"},
		{"trimmed to nothing, which leaves the label alone", false, func(id string) Answer {
			return Answer{RequestID: id, Answers: []string{"Postgres"}, Text: "  "}
		}, []string{"Postgres"}, ""},
		// The exact shape the answer sheet sends when Other is not in use: an
		// empty list rather than an absent one, because the wire form always
		// carries `answers`. Pinned because this is the every-send case, and a
		// check that treated empty as "answered with nothing" would refuse it.
		{"an empty answers list beside a label", true, func(id string) Answer {
			return Answer{RequestID: id, Answers: []string{"Postgres", "SQLite"}}
		}, []string{"Postgres", "SQLite"}, ""},
	} {
		t.Run(tt.name, func(t *testing.T) {
			f := newQuestionFixture(t)
			q, err := f.client.PostQuestion(context.Background(), "sess", QuestionSpec{
				Header: "Database", Question: "Which one?", MultiSelect: tt.multiSelect,
				Options: []session.QuestionOption{{Label: "Postgres"}, {Label: "SQLite"}},
			})
			if err != nil {
				t.Fatalf("PostQuestion: %v", err)
			}
			id := q.RequestID

			if _, err := f.client.SendMessageAnswering(context.Background(), "sess", "x",
				[]Answer{tt.answer(id)}, nil); err != nil {
				t.Fatalf("SendMessageAnswering: %v", err)
			}

			answering := lastAnswering(t, f, id)
			if !slices.Equal(answering.Answers, tt.wantAnswers) {
				t.Errorf("answers = %q, want %q", answering.Answers, tt.wantAnswers)
			}
			if answering.Text != tt.wantText {
				t.Errorf("text = %q, want %q", answering.Text, tt.wantText)
			}
			if answering.Declined {
				t.Error("free text is an answer, not a decline")
			}
			if pending := f.unanswered(t); len(pending) != 0 {
				t.Errorf("unanswered = %+v, want the question answered", pending)
			}
		})
	}
}

// lastAnswering finds the record that answered requestID and returns that entry.
func lastAnswering(t *testing.T, f *questionFixture, requestID string) agent.QuestionAnswer {
	t.Helper()
	records, err := f.store.GetHistory(context.Background(), "sess")
	if err != nil {
		t.Fatalf("GetHistory: %v", err)
	}
	for i := len(records) - 1; i >= 0; i-- {
		var rec agent.EventRecord
		if err := json.Unmarshal(records[i], &rec); err != nil {
			continue
		}
		for _, a := range rec.Answering {
			if a.RequestID == requestID {
				return a
			}
		}
	}
	t.Fatalf("no record answers %s", requestID)
	return agent.QuestionAnswer{}
}

func TestSendMessageAnswering_SameQuestionTwiceInOneMessage(t *testing.T) {
	f := newQuestionFixture(t)
	id := f.post(t, "Database")

	_, err := f.client.SendMessageAnswering(context.Background(), "sess", "x", []Answer{
		{RequestID: id, Answers: []string{"Postgres"}},
		{RequestID: id, Answers: []string{"SQLite"}},
	}, nil)
	if !errors.Is(err, ErrAnswerShape) {
		t.Errorf("error = %v, want ErrAnswerShape", err)
	}
}

// TestSendMessageAnswering_RefusedWhileAPermissionIsOnScreen: the session is
// blocked on something only a live process can take, and answering a posted
// question does not change that. Reported as it is rather than silently
// swallowed.
func TestSendMessageAnswering_RefusedWhileAPermissionIsOnScreen(t *testing.T) {
	f := newQuestionFixture(t)
	id := f.post(t, "Database")

	if _, err := f.client.SendMessageExcluding(context.Background(), "sess", "go", nil); err != nil {
		t.Fatalf("SendMessageExcluding: %v", err)
	}
	// The prompt has to be *reduced* before the permission is pushed, not merely
	// sent. A prompt signal expires every blocker on the turn, so a permission
	// raised while the prompt is still in flight is cleared again the moment it
	// lands — the turn stops awaiting an answer, the send below goes through,
	// and the test fails on a race rather than on the behaviour it is about.
	waitFor(t, func() bool {
		meta, _, _ := f.store.Get("sess")
		return meta.Turn.Phase == session.PhaseRunning
	})

	sess := f.agent.session(t, 1)
	sess.events <- agent.PermissionRequestEvent{RequestID: "perm-1", ToolName: "Bash"}
	// Waited for on the **process's** copy of the turn, not the store's, because
	// that is the copy the send below reads (chat.Client.liveProcess). The two are
	// written in that order — store first, process second (Process.applyTurn) —
	// and the copy is deliberately allowed to lag, so a test that waits on the
	// store can reach the send inside the window where the permission is recorded
	// but this process has not caught up, and the send goes through. Which is a
	// race in the test and not in the product: nothing on the real path decides
	// when to send by watching the store.
	waitFor(t, func() bool {
		proc, err := f.client.liveProcess("sess")
		return err == nil && proc.TurnState().AwaitingUserAnswer()
	})

	_, err := f.client.SendMessageAnswering(context.Background(), "sess", "answer", []Answer{
		{RequestID: id, Answers: []string{"Postgres"}},
	}, nil)
	if !errors.Is(err, ErrTurnAwaitingAnswer) {
		t.Fatalf("error = %v, want ErrTurnAwaitingAnswer", err)
	}
	if pending := f.unanswered(t); len(pending) != 1 {
		t.Errorf("unanswered = %+v, want the question still open after a refused send", pending)
	}
}

// TestSendMessageAnswering_NoAnswersIsAnOrdinaryMessage keeps the common path
// honest: nothing about the question machinery touches a message that answers
// nothing.
func TestSendMessageAnswering_NoAnswersIsAnOrdinaryMessage(t *testing.T) {
	f := newQuestionFixture(t)
	id := f.post(t, "Database")

	if _, err := f.client.SendMessageAnswering(context.Background(), "sess", "just talking", nil, nil); err != nil {
		t.Fatalf("SendMessageAnswering: %v", err)
	}
	if pending := f.unanswered(t); len(pending) != 1 || pending[0].RequestID != id {
		t.Errorf("unanswered = %+v, want the question untouched", pending)
	}
}

// --- Answers given by an agent (the question_answer tool) ---

var otherAgent = agent.QuestionResolver{
	Kind: agent.ResolverAgent, WorkID: "work-9", Title: "Ship the API",
}

// TestAnswerQuestion_DeliversToASessionWithNoProcess is the cold restore the
// tool promises: a question outlives the process that asked it, so the
// commonest target has none, and the answer has to start one and be handed over
// before the call returns.
func TestAnswerQuestion_DeliversToASessionWithNoProcess(t *testing.T) {
	f := newQuestionFixture(t)
	id := f.post(t, "Database")

	if err := f.client.AnswerQuestion(context.Background(), "sess", Answer{
		RequestID: id, Answers: []string{"Postgres"},
	}, otherAgent); err != nil {
		t.Fatalf("AnswerQuestion: %v", err)
	}

	// Read straight after the call returns: a delivery this had not made yet
	// would leave the CLI holding nothing.
	prompts := f.agent.session(t, 1).sentPrompts()
	if len(prompts) != 1 {
		t.Fatalf("prompts = %v, want the answer delivered before the call returned", prompts)
	}
	if !strings.Contains(prompts[0], "not from the user") || !strings.Contains(prompts[0], "Ship the API") {
		t.Errorf("prompt = %q, want it to say who answered and that it was not the user", prompts[0])
	}
	if !strings.Contains(prompts[0], "Postgres") {
		t.Errorf("prompt = %q, want the answer itself", prompts[0])
	}
	if pending := f.unanswered(t); len(pending) != 0 {
		t.Errorf("unanswered = %+v, want the question answered", pending)
	}
}

// The record an agent's answer writes is the record a person's answer writes,
// plus who gave it — and the message carries the agent origin, so no client
// draws it as something the user said.
func TestAnswerQuestion_RecordsWhoAnsweredAndMarksTheMessage(t *testing.T) {
	f := newQuestionFixture(t)
	id := f.post(t, "Database")

	if err := f.client.AnswerQuestion(context.Background(), "sess", Answer{
		RequestID: id, Answers: []string{"SQLite"},
	}, otherAgent); err != nil {
		t.Fatalf("AnswerQuestion: %v", err)
	}

	answering := lastAnswering(t, f, id)
	if answering.ResolvedBy == nil || *answering.ResolvedBy != otherAgent {
		t.Fatalf("resolved_by = %+v, want %+v", answering.ResolvedBy, otherAgent)
	}
	if !slices.Equal(answering.Answers, []string{"SQLite"}) {
		t.Errorf("answers = %q, want the label it picked", answering.Answers)
	}

	var message agent.EventRecord
	for _, rec := range f.records(t) {
		if rec.Type == agent.EventTypeMessage {
			message = rec
		}
	}
	if message.Origin != agent.MessageOriginAgent {
		t.Errorf("origin = %q, want %q", message.Origin, agent.MessageOriginAgent)
	}
}

// A person's answer keeps saying it was a person's, explicitly. It used to be
// derivable from the record type and no longer is.
func TestSendMessageAnswering_RecordsTheUserAsTheAnswerer(t *testing.T) {
	f := newQuestionFixture(t)
	id := f.post(t, "Database")

	if _, err := f.client.SendMessageAnswering(context.Background(), "sess", "x", []Answer{
		{RequestID: id, Answers: []string{"Postgres"}},
	}, nil); err != nil {
		t.Fatalf("SendMessageAnswering: %v", err)
	}

	answering := lastAnswering(t, f, id)
	if answering.ResolvedBy == nil || answering.ResolvedBy.Kind != agent.ResolverUser {
		t.Fatalf("resolved_by = %+v, want the user", answering.ResolvedBy)
	}

	var message agent.EventRecord
	for _, rec := range f.records(t) {
		if rec.Type == agent.EventTypeMessage {
			message = rec
		}
	}
	// Unmarked, as every message a person sends is.
	if message.Origin != "" {
		t.Errorf("origin = %q, want a user message to carry none", message.Origin)
	}
}

// TestDescribeResolution_SaysWhoResolvedIt is the whole reason resolved_by
// exists: three ways a question stops waiting, three different sentences, and
// two of them are now told apart by the field rather than by the record type.
func TestDescribeResolution_SaysWhoResolvedIt(t *testing.T) {
	for _, tt := range []struct {
		name    string
		resolve func(t *testing.T, f *questionFixture, id string)
		want    string
	}{
		{
			name: "the user answered in the chat",
			resolve: func(t *testing.T, f *questionFixture, id string) {
				if _, err := f.client.SendMessageAnswering(context.Background(), "sess", "x",
					[]Answer{{RequestID: id, Answers: []string{"Postgres"}}}, nil); err != nil {
					t.Fatalf("SendMessageAnswering: %v", err)
				}
			},
			want: "answered by the user at ",
		},
		{
			name: "the agent that asked withdrew it",
			resolve: func(t *testing.T, f *questionFixture, id string) {
				if err := f.client.CancelQuestion(context.Background(), "sess", id); err != nil {
					t.Fatalf("CancelQuestion: %v", err)
				}
			},
			want: "withdrawn by the agent at ",
		},
		{
			name: "another agent answered it",
			resolve: func(t *testing.T, f *questionFixture, id string) {
				if err := f.client.AnswerQuestion(context.Background(), "sess",
					Answer{RequestID: id, Answers: []string{"Postgres"}}, otherAgent); err != nil {
					t.Fatalf("AnswerQuestion: %v", err)
				}
			},
			want: `answered by the agent working on "Ship the API" (work-9) at `,
		},
	} {
		t.Run(tt.name, func(t *testing.T) {
			f := newQuestionFixture(t)
			id := f.post(t, "Database")
			tt.resolve(t, f, id)

			// Answering it a second time is what reads the sentence out.
			err := f.client.AnswerQuestion(context.Background(), "sess",
				Answer{RequestID: id, Answers: []string{"SQLite"}}, otherAgent)
			if !errors.Is(err, ErrQuestionNotPending) {
				t.Fatalf("error = %v, want ErrQuestionNotPending", err)
			}
			if !strings.Contains(err.Error(), tt.want) {
				t.Errorf("error = %q, want it to contain %q", err, tt.want)
			}
		})
	}
}

// A record written before an agent could answer at all carries no resolved_by,
// and every one of those was the user's. The refusal has to go on saying so
// rather than falling back to "somebody".
func TestDescribeResolution_ARecordWithNoResolverIsTheUsers(t *testing.T) {
	f := newQuestionFixture(t)
	id := f.post(t, "Database")

	// The shape a build before this field wrote: an answering entry with no
	// resolved_by, and the question off the list.
	legacy := agent.NewEventRecord(agent.MessageEvent{
		Content: "Answering:\n\nQ: Which database?\nA: Postgres",
		Answering: []agent.QuestionAnswer{{
			RequestID: id, Header: "Database", Question: "Which database?",
			Answers: []string{"Postgres"}, AnsweredAt: time.Now(),
		}},
	})
	if _, err := f.store.AppendToHistory(context.Background(), "sess", legacy); err != nil {
		t.Fatalf("AppendToHistory: %v", err)
	}
	if _, err := f.store.ApplyTurn(context.Background(), "sess", session.TurnInput{
		Signal: session.SignalQuestionResolved, RequestID: id, At: time.Now(),
	}); err != nil {
		t.Fatalf("ApplyTurn: %v", err)
	}

	err := f.client.AnswerQuestion(context.Background(), "sess",
		Answer{RequestID: id, Answers: []string{"SQLite"}}, otherAgent)
	if !errors.Is(err, ErrQuestionNotPending) {
		t.Fatalf("error = %v, want ErrQuestionNotPending", err)
	}
	if !strings.Contains(err.Error(), "answered by the user at ") {
		t.Errorf("error = %q, want the answer attributed to the user", err)
	}
}

// An agent's answer is checked exactly as a person's is: the label has to be
// one the question offered, whoever is handing it back.
func TestAnswerQuestion_ChecksTheShapeLikeAnyOther(t *testing.T) {
	f := newQuestionFixture(t)
	id := f.post(t, "Database")

	err := f.client.AnswerQuestion(context.Background(), "sess",
		Answer{RequestID: id, Answers: []string{"MySQL"}}, otherAgent)
	if !errors.Is(err, ErrAnswerShape) {
		t.Fatalf("error = %v, want ErrAnswerShape", err)
	}
	if pending := f.unanswered(t); len(pending) != 1 {
		t.Errorf("unanswered = %+v, want the question still waiting", pending)
	}
}
