package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/agentrole"
	"github.com/pockode/server/chat"
	"github.com/pockode/server/session"
	"github.com/pockode/server/work"
	"github.com/pockode/server/worktree"
)

// newQuestionExec builds an executor over a work store with one story, and hands
// back the session stub the question tools act through.
func newQuestionExec(t *testing.T) (*Executor, *stubSessions, work.Store, string) {
	t.Helper()
	store, arStore, settingsStore, roleID := newStoresWithRole(t, agentrole.AgentRole{
		Name: "Engineer", RolePrompt: "engineer",
	})
	sessions := &stubSessions{}
	ops := work.NewOperations(store, stubWorkStarter{}, stubNotifier{}, agentrole.Steps{Store: arStore})
	return NewExecutor(store, arStore, ops, settingsStore, &stubWorktrees{}, sessions), sessions, store, roleID
}

// callAs runs a tool as a particular caller. The question tools act on the
// session the call came from, so every one of these tests has to say who is
// calling — which is what callTool, fixed at the anonymous caller, cannot.
func callAs(t *testing.T, e *Executor, caller Caller, name string, args any) (string, error) {
	t.Helper()
	raw, err := json.Marshal(args)
	if err != nil {
		t.Fatalf("marshal args: %v", err)
	}
	return e.Execute(context.Background(), caller, name, raw)
}

var callerInMain = Caller{SessionID: "sess-1"}

// TestQuestionPost_PostsIntoTheCallersSession: the model never names a session,
// because the only session a question can go into is the one the call came from.
func TestQuestionPost_PostsIntoTheCallersSession(t *testing.T) {
	exec, sessions, _, _ := newQuestionExec(t)

	out, err := callAs(t, exec, Caller{SessionID: "sess-1", Worktree: "feature-x"}, "question_post", map[string]any{
		"questions": []map[string]any{{
			"header":   "Database",
			"question": "Which database?",
			"options": []map[string]string{
				{"label": "Postgres", "description": "the one we have"},
				{"label": "SQLite"},
			},
		}},
	})
	if err != nil {
		t.Fatalf("question_post: %v", err)
	}

	if len(sessions.questions.posted) != 1 {
		t.Fatalf("posted = %d, want one question", len(sessions.questions.posted))
	}
	spec := sessions.questions.posted[0]
	if spec.Header != "Database" || spec.Question != "Which database?" {
		t.Errorf("spec = %+v, want the arguments as given", spec)
	}
	if len(spec.Options) != 2 || spec.Options[0].Description != "the one we have" {
		t.Errorf("options = %+v, want both, descriptions kept", spec.Options)
	}
	if sessions.questions.postedFor[0] != "sess-1" {
		t.Errorf("posted into %q, want the caller's session", sessions.questions.postedFor[0])
	}
	if got := sessions.askedFor[0]; got != "feature-x" {
		t.Errorf("resolved worktree %q, want the caller's", got)
	}

	// The reply has to say the two things a model cannot see: the id an answer
	// will name, and that nothing is waiting here.
	if !strings.Contains(out, "req-1") {
		t.Errorf("reply = %q, want the request id", out)
	}
	if !strings.Contains(out, "carry on") {
		t.Errorf("reply = %q, want it to say the call is not waiting", out)
	}
}

// TestQuestionTools_RefuseACallWithNoSession: an agent started by hand has no
// chat to ask into, and there is no id to ask it for instead.
func TestQuestionTools_RefuseACallWithNoSession(t *testing.T) {
	for _, tool := range []string{"question_post", "question_cancel"} {
		t.Run(tool, func(t *testing.T) {
			exec, sessions, _, _ := newQuestionExec(t)
			_, err := callAs(t, exec, Caller{}, tool, map[string]any{
				"questions": []map[string]any{{"header": "h", "question": "q"}}, "request_id": "req-1",
			})
			if err == nil || !strings.Contains(err.Error(), "only be called from a Pockode session") {
				t.Fatalf("error = %v, want a refusal naming the missing session", err)
			}
			if !isUserError(err) {
				t.Error("a call with no session is the caller's mistake, not a server fault")
			}
			if sessions.questions != nil {
				t.Error("the session layer was reached for a call that should not have got that far")
			}
		})
	}
}

// oneQuestion is a question_post call asking a single question.
func oneQuestion(q map[string]any) map[string]any {
	return map[string]any{"questions": []map[string]any{q}}
}

// TestQuestionPost_ArgumentRefusals: only what would make an answer wrong is
// refused, and the refusal says which question and how to fix it.
func TestQuestionPost_ArgumentRefusals(t *testing.T) {
	tests := []struct {
		name string
		args map[string]any
		want string
	}{
		{"no questions", map[string]any{}, "pass at least one question"},
		{"an empty list", map[string]any{"questions": []map[string]any{}}, "pass at least one question"},
		{"no question", oneQuestion(map[string]any{"header": "h"}), "questions[0]: question is required"},
		{"no header", oneQuestion(map[string]any{"question": "q"}), "questions[0]: header is required"},
		{"a blank header", oneQuestion(map[string]any{"header": "  ", "question": "q"}), "header is required"},
		{"an option with no label", oneQuestion(map[string]any{
			"header": "h", "question": "q",
			"options": []map[string]string{{"description": "d"}},
		}), "every option needs a label"},
		{"two options with one label", oneQuestion(map[string]any{
			"header": "h", "question": "q",
			"options": []map[string]string{{"label": "a"}, {"label": "a"}},
		}), "share the label"},
		{"two recommendations where only one can be picked", oneQuestion(map[string]any{
			"header": "h", "question": "q",
			"options": []map[string]any{{"label": "a", "recommended": true}, {"label": "b", "recommended": true}},
		}), "only one can be picked"},
		// Counted after the suffix is read as a recommendation, or this one
		// would slip through as one marked option.
		{"a suffix recommends a second option", oneQuestion(map[string]any{
			"header": "h", "question": "q",
			"options": []map[string]any{{"label": "a", "recommended": true}, {"label": "b (Recommended)"}},
		}), `["a" "b"]`},
		{"a label that is only the suffix", oneQuestion(map[string]any{
			"header": "h", "question": "q",
			"options": []map[string]string{{"label": "(Recommended)"}, {"label": "b"}},
		}), "set recommended: true"},
		{"a suffixed label repeats another", oneQuestion(map[string]any{
			"header": "h", "question": "q",
			"options": []map[string]string{{"label": "a (Recommended)"}, {"label": "a"}},
		}), "once \"(Recommended)\" is removed"},
		{"multi_select with nothing to select", oneQuestion(map[string]any{
			"header": "h", "question": "q", "multi_select": true,
		}), "needs options to select from"},
		{"the fault is located in the batch", map[string]any{"questions": []map[string]any{
			{"header": "h", "question": "q"},
			{"header": "h2"},
		}}, "questions[1]: question is required"},
		{"two questions with one text", map[string]any{"questions": []map[string]any{
			{"header": "Database", "question": "Which one?"},
			{"header": "Runtime", "question": " Which one? "},
		}}, "questions[0] and questions[1] have the same question text"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			exec, sessions, _, _ := newQuestionExec(t)
			_, err := callAs(t, exec, callerInMain, "question_post", tt.args)
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("error = %v, want it to contain %q", err, tt.want)
			}
			if !isUserError(err) {
				t.Error("a malformed question is the caller's mistake")
			}
			if sessions.questions != nil {
				t.Error("a refused question reached the session layer")
			}
		})
	}
}

// TestQuestionPost_RecommendedOptions: the flag is carried to what is posted;
// the "(Recommended)" suffix models are trained to write is read as the same
// flag and kept out of the label, because the label is the answer the agent
// gets back; and a multi-select may recommend several.
func TestQuestionPost_RecommendedOptions(t *testing.T) {
	exec, sessions, _, _ := newQuestionExec(t)

	_, err := callAs(t, exec, callerInMain, "question_post", map[string]any{"questions": []map[string]any{
		{"header": "Database", "question": "Which database?", "options": []map[string]any{
			{"label": "Postgres (Recommended)"}, {"label": "SQLite"},
		}},
		{"header": "Runtime", "question": "Which runtime?", "options": []map[string]any{
			{"label": "Go", "recommended": true}, {"label": "Rust"},
		}},
		{"header": "Targets", "question": "Which targets?", "multi_select": true, "options": []map[string]any{
			{"label": "Linux", "recommended": true}, {"label": "macOS(Recommended)"}, {"label": "Windows"},
			// Only the exact English suffix is recognised.
			{"label": "BSD (recommended)"},
		}},
	}})
	if err != nil {
		t.Fatalf("question_post: %v", err)
	}

	type opt struct {
		label       string
		recommended bool
	}
	want := [][]opt{
		{{"Postgres", true}, {"SQLite", false}},
		{{"Go", true}, {"Rust", false}},
		{{"Linux", true}, {"macOS", true}, {"Windows", false}, {"BSD (recommended)", false}},
	}
	for i, spec := range sessions.questions.posted {
		var got []opt
		for _, o := range spec.Options {
			got = append(got, opt{o.Label, o.Recommended})
		}
		if !slices.Equal(got, want[i]) {
			t.Errorf("questions[%d] options = %+v, want %+v", i, got, want[i])
		}
	}
}

// TestQuestionPost_AcceptsWhatOnlyGuidanceGoverns: how many, how long, and
// whether an option looks redundant are matters of asking well, not of an
// answer being wrong — refusing them costs the user a round trip for nothing.
func TestQuestionPost_AcceptsWhatOnlyGuidanceGoverns(t *testing.T) {
	long := strings.Repeat("src/very/deep/path/to/some/file.go ", 20)
	var options []map[string]string
	for i := range 30 {
		options = append(options, map[string]string{"label": fmt.Sprintf("%s%d", long, i)})
	}
	var questions []map[string]any
	for i := range 25 {
		questions = append(questions, map[string]any{"header": "h", "question": fmt.Sprintf("q%d", i)})
	}
	questions = append(questions,
		map[string]any{"header": long, "question": "Which files?", "options": options, "multi_select": true},
		map[string]any{"header": "Only", "question": "Use this?", "options": []map[string]string{{"label": "Yes"}}},
		map[string]any{"header": "Other", "question": "Which?", "options": []map[string]string{{"label": "A"}, {"label": "Other"}}},
	)

	exec, sessions, _, _ := newQuestionExec(t)
	if _, err := callAs(t, exec, callerInMain, "question_post", map[string]any{"questions": questions}); err != nil {
		t.Fatalf("question_post: %v", err)
	}
	if got := len(sessions.questions.posted); got != len(questions) {
		t.Errorf("posted = %d, want all %d", got, len(questions))
	}
}

// TestQuestionPost_ABatchPostsEveryQuestionInOrder: each question is posted in
// the order given, and the reply pairs each header with its request id so the
// model can tell which id is which.
func TestQuestionPost_ABatchPostsEveryQuestionInOrder(t *testing.T) {
	exec, sessions, _, _ := newQuestionExec(t)
	engine := &spyEngine{}
	exec.SetWorkEngine(engine)

	out, err := callAs(t, exec, callerInMain, "question_post", map[string]any{"questions": []map[string]any{
		{"header": "Database", "question": "Which database?"},
		{"header": "Runtime", "question": "Which runtime?"},
	}})
	if err != nil {
		t.Fatalf("question_post: %v", err)
	}
	posted := sessions.questions.posted
	if len(posted) != 2 || posted[0].Header != "Database" || posted[1].Header != "Runtime" {
		t.Fatalf("posted = %+v, want both, in the order asked", posted)
	}
	for _, want := range []string{`"Database" (request_id: req-1)`, `"Runtime" (request_id: req-2)`} {
		if !strings.Contains(out, want) {
			t.Errorf("reply = %q, want it to contain %s", out, want)
		}
	}
	// One report for the call, so a story above hears about the batch at once.
	if len(engine.postedIn) != 1 || len(engine.posted[0]) != 2 {
		t.Errorf("engine told %d time(s) with %v, want once with both questions", len(engine.postedIn), engine.posted)
	}
}

// TestQuestionPost_AFailurePartWayNamesWhatWasPosted: the questions already
// posted are being asked, and an agent told only "failed" would ask them again.
func TestQuestionPost_AFailurePartWayNamesWhatWasPosted(t *testing.T) {
	exec, sessions, _, _ := newQuestionExec(t)
	engine := &spyEngine{}
	exec.SetWorkEngine(engine)
	sessions.questions = &stubQuestions{postErr: errors.New("disk full"), postErrAfter: 1}

	_, err := callAs(t, exec, callerInMain, "question_post", map[string]any{"questions": []map[string]any{
		{"header": "Database", "question": "Which database?"},
		{"header": "Runtime", "question": "Which runtime?"},
	}})
	if err == nil {
		t.Fatal("question_post succeeded with a failure part way")
	}
	for _, want := range []string{"posted 1 of 2", `"Database" (request_id: req-1)`, "disk full"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error = %q, want it to contain %q", err, want)
		}
	}
	if len(engine.posted) != 1 || len(engine.posted[0]) != 1 {
		t.Errorf("engine told %v, want the one question that was posted", engine.posted)
	}
}

// TestQuestionPost_RefusedOnAClosedWork: the chat is finished with, so a
// question posted into it is one nobody will ever see. The refusal names the way
// out, which belongs to the work rather than to the question.
func TestQuestionPost_RefusedOnAClosedWork(t *testing.T) {
	exec, sessions, store, roleID := newQuestionExec(t)

	created, err := store.Create(context.Background(), work.Work{
		Title: "Ship it", AgentRoleID: roleID,
	})
	if err != nil {
		t.Fatalf("create work: %v", err)
	}
	if _, err := store.Start(context.Background(), created.ID, "sess-1"); err != nil {
		t.Fatalf("start work: %v", err)
	}
	if _, err := store.StepDone(context.Background(), created.ID, 0); err != nil {
		t.Fatalf("close work: %v", err)
	}

	_, err = callAs(t, exec, callerInMain, "question_post", oneQuestion(map[string]any{
		"header": "Database", "question": "Which database?",
	}))
	if err == nil || !strings.Contains(err.Error(), "is closed") {
		t.Fatalf("error = %v, want a refusal naming the closed work", err)
	}
	if !strings.Contains(err.Error(), "work_reopen") {
		t.Errorf("error = %q, want it to name the way on", err)
	}
	if sessions.questions != nil {
		t.Error("a question was posted into a closed work's chat")
	}
}

// A plain chat session belongs to no work at all, and must not be refused for
// the want of one.
func TestQuestionPost_AllowedInAPlainChatSession(t *testing.T) {
	exec, sessions, _, _ := newQuestionExec(t)
	if _, err := callAs(t, exec, callerInMain, "question_post", oneQuestion(map[string]any{
		"header": "Database", "question": "Which database?",
	})); err != nil {
		t.Fatalf("question_post in a session with no work: %v", err)
	}
	if len(sessions.questions.posted) != 1 {
		t.Error("the question was not posted")
	}
}

func TestQuestionCancel_WithdrawsTheCallersOwnQuestion(t *testing.T) {
	exec, sessions, _, _ := newQuestionExec(t)

	out, err := callAs(t, exec, callerInMain, "question_cancel", map[string]any{"request_id": "req-1"})
	if err != nil {
		t.Fatalf("question_cancel: %v", err)
	}
	if len(sessions.questions.cancelled) != 1 || sessions.questions.cancelled[0] != "req-1" {
		t.Errorf("cancelled = %v, want req-1", sessions.questions.cancelled)
	}
	if !strings.Contains(out, "req-1") {
		t.Errorf("reply = %q, want it to name the question", out)
	}
}

func TestQuestionCancel_RequiresARequestID(t *testing.T) {
	exec, _, _, _ := newQuestionExec(t)
	_, err := callAs(t, exec, callerInMain, "question_cancel", map[string]any{})
	if err == nil || !strings.Contains(err.Error(), "request_id is required") {
		t.Fatalf("error = %v, want a refusal naming the missing argument", err)
	}
}

// TestQuestionCancel_RefusesAnotherSessionsQuestion is what the project-wide
// index buys: "you are naming somebody else's question" is a different mistake
// from "that question is over", and an agent told the second about the first
// will simply try again.
func TestQuestionCancel_RefusesAnotherSessionsQuestion(t *testing.T) {
	exec, sessions, _, _ := newQuestionExec(t)
	sessions.located = map[string][]worktree.QuestionLocation{
		"req-1": {{SessionID: "sess-2", Worktree: "feature-x"}},
	}

	_, err := callAs(t, exec, callerInMain, "question_cancel", map[string]any{"request_id": "req-1"})
	if err == nil || !strings.Contains(err.Error(), "another session") {
		t.Fatalf("error = %v, want a refusal naming the other session", err)
	}
	if !strings.Contains(err.Error(), "sess-2") {
		t.Errorf("error = %q, want it to name which session", err)
	}
	if sessions.questions != nil {
		t.Error("the withdrawal reached the session layer anyway")
	}
}

// A question the caller does have is not refused just because the index knows
// about it.
func TestQuestionCancel_AllowedForTheCallersOwnIndexedQuestion(t *testing.T) {
	exec, sessions, _, _ := newQuestionExec(t)
	sessions.located = map[string][]worktree.QuestionLocation{
		"req-1": {{SessionID: "sess-1"}},
	}
	if _, err := callAs(t, exec, callerInMain, "question_cancel", map[string]any{"request_id": "req-1"}); err != nil {
		t.Fatalf("question_cancel: %v", err)
	}
	if len(sessions.questions.cancelled) != 1 {
		t.Error("the withdrawal did not reach the session layer")
	}
}

// A question that is over is reported with the chat layer's own account of what
// became of it, and counts as the agent's mistake rather than a server fault.
func TestQuestionCancel_PassesOnWhatBecameOfTheQuestion(t *testing.T) {
	exec, sessions, _, _ := newQuestionExec(t)
	sessions.questions = &stubQuestions{
		cancelErr: errors.New("that question is not waiting for an answer: req-1 (answered by the user at 14:02)"),
	}

	_, err := callAs(t, exec, callerInMain, "question_cancel", map[string]any{"request_id": "req-1"})
	if err == nil || !strings.Contains(err.Error(), "answered by the user") {
		t.Fatalf("error = %v, want the chat layer's account passed through", err)
	}
}

// TestQuestionTools_AreAdvertised: a tool the executor runs but tools/list does
// not name is one no model will ever call.
func TestQuestionTools_AreAdvertised(t *testing.T) {
	for _, name := range []string{"question_post", "question_cancel"} {
		var found *toolDefinition
		for i := range toolDefinitions {
			if toolDefinitions[i].Name == name {
				found = &toolDefinitions[i]
			}
		}
		if found == nil {
			t.Fatalf("%s is not advertised", name)
		}
		// The description is read once the agent goes for the tool, so it holds
		// the surprising facts about the mechanism and the rules for wording a
		// question a model breaks unless told: asking in one call, never adding
		// the "Other" the panel already offers. What must be known before the
		// tool is loaded is agent.AskingGuidance's (see below).
		if name == "question_post" {
			for _, want := range []string{"returns immediately", "arrives later as an ordinary message", "question_cancel",
				"in one call", "\"Other\"", "recommended"} {
				if !strings.Contains(found.Description, want) {
					t.Errorf("question_post description does not say %q", want)
				}
			}
			questions := found.InputSchema.Properties["questions"]
			if questions.Items == nil || questions.Items.Properties["header"].Type != "string" {
				t.Fatal("the questions schema does not describe the objects it takes")
			}
			options := questions.Items.Properties["options"]
			if options.Items == nil || options.Items.Properties["label"].Type != "string" {
				t.Error("the options schema does not describe the objects it takes")
			}
			if options.Items != nil && options.Items.Properties["recommended"].Type != "boolean" {
				t.Error("the options schema does not offer the recommended flag")
			}
		}
	}
}

// The agent meets two texts about asking the user — the question_post reply
// and the refusal a CLI's own question tool gets (agent.CLIQuestionRefusal, sent
// from both agent packages). They describe one mechanism, and an agent reading
// two different accounts of it has to work out for itself whether they are one
// thing or two.
//
// Only the load-bearing claims are pinned, not the wording: each text has to say
// that the agent carries on and that the answer comes back as a message. Those
// are the two things a model cannot derive, and the two a rewrite is most likely
// to lose.
func TestAskingTheUser_TheTwoTextsMakeTheSameClaims(t *testing.T) {
	exec, _, _, _ := newQuestionExec(t)

	posted, err := callAs(t, exec, Caller{SessionID: "sess-1"}, "question_post", oneQuestion(map[string]any{
		"header": "Database", "question": "Which database?",
	}))
	if err != nil {
		t.Fatalf("question_post: %v", err)
	}

	texts := map[string]string{
		"question_post reply":           posted,
		"the CLI question tool refusal": agent.CLIQuestionRefusal,
	}
	for name, text := range texts {
		for _, claim := range []string{"carry on", "message in this chat"} {
			if !strings.Contains(text, claim) {
				t.Errorf("%s does not say %q: %s", name, claim, text)
			}
		}
	}

	// The refusal redirects, so it has to name where to go.
	if !strings.Contains(agent.CLIQuestionRefusal, "question_post") {
		t.Errorf("the CLI question tool refusal does not name question_post: %s", agent.CLIQuestionRefusal)
	}
}

// --- question_answer ---

// startedWork creates a story, starts it on sessionID, and hands back its id.
func startedWork(t *testing.T, store work.Store, roleID, title, sessionID string) string {
	t.Helper()
	created, err := store.Create(context.Background(), work.Work{
		Title: title, AgentRoleID: roleID,
	})
	if err != nil {
		t.Fatalf("create work: %v", err)
	}
	if _, err := store.Start(context.Background(), created.ID, sessionID); err != nil {
		t.Fatalf("start work: %v", err)
	}
	return created.ID
}

// TestQuestionAnswer_AnswersAnotherSessionsQuestion is the ordinary path: one
// request id, the index finds the one session waiting on it, and the answer is
// recorded as this caller's.
func TestQuestionAnswer_AnswersAnotherSessionsQuestion(t *testing.T) {
	exec, sessions, store, roleID := newQuestionExec(t)
	workID := startedWork(t, store, roleID, "Ship the API", "sess-1")
	sessions.located = map[string][]worktree.QuestionLocation{
		"req-1": {{SessionID: "sess-2", Worktree: "feature-x"}},
	}

	out, err := callAs(t, exec, callerInMain, "question_answer", map[string]any{
		"request_id": "req-1",
		"answers":    []string{"Postgres"},
		"note":       "pin it to 16",
	})
	if err != nil {
		t.Fatalf("question_answer: %v", err)
	}

	if got := sessions.askedFor; len(got) != 1 || got[0] != "feature-x" {
		t.Errorf("resolved worktrees = %v, want the worktree the question is in", got)
	}
	delivered := sessions.questions.answered
	if len(delivered) != 1 {
		t.Fatalf("delivered = %+v, want one answer", delivered)
	}
	if delivered[0].sessionID != "sess-2" {
		t.Errorf("delivered to %q, want the session that asked", delivered[0].sessionID)
	}
	if got := delivered[0].answer; !slices.Equal(got.Answers, []string{"Postgres"}) || got.Note != "pin it to 16" {
		t.Errorf("answer = %+v, want the labels and the note passed on", got)
	}
	want := agent.QuestionResolver{Kind: agent.ResolverAgent, WorkID: workID, Title: "Ship the API"}
	if delivered[0].by != want {
		t.Errorf("answered by %+v, want %+v", delivered[0].by, want)
	}
	if !strings.Contains(out, "req-1") {
		t.Errorf("reply = %q, want it to name the question", out)
	}
}

// An agent running no work at all can still answer; there is simply no work to
// name as the answerer.
func TestQuestionAnswer_FromASessionWithNoWork(t *testing.T) {
	exec, sessions, _, _ := newQuestionExec(t)
	sessions.located = map[string][]worktree.QuestionLocation{
		"req-1": {{SessionID: "sess-2"}},
	}

	if _, err := callAs(t, exec, callerInMain, "question_answer", map[string]any{
		"request_id": "req-1", "text": "call it pockode",
	}); err != nil {
		t.Fatalf("question_answer: %v", err)
	}
	if by := sessions.questions.answered[0].by; by.Kind != agent.ResolverAgent || by.WorkID != "" {
		t.Errorf("answered by %+v, want an agent with no work", by)
	}
}

// TestQuestionAnswer_RefusesYourOwnQuestion: answering your own question would
// record an answer nobody gave. It is the one refusal that is about who is
// calling rather than about the question.
func TestQuestionAnswer_RefusesYourOwnQuestion(t *testing.T) {
	exec, sessions, _, _ := newQuestionExec(t)
	sessions.located = map[string][]worktree.QuestionLocation{
		"req-1": {{SessionID: "sess-1"}},
	}

	_, err := callAs(t, exec, callerInMain, "question_answer", map[string]any{
		"request_id": "req-1", "answers": []string{"Postgres"},
	})
	if err == nil || !strings.Contains(err.Error(), "is your own") {
		t.Fatalf("error = %v, want a refusal to answer in its own session", err)
	}
	if !strings.Contains(err.Error(), "question_cancel") {
		t.Errorf("error = %q, want it to name what it should have called", err)
	}
	if sessions.questions != nil {
		t.Error("the answer reached the session layer anyway")
	}
}

// TestQuestionAnswer_RefusesWhenTwoSessionsAreWaiting: a fork carries a question
// across with its id, so both sessions are asking and answering one leaves the
// other asking. Nothing here can pick, so the caller is made to.
func TestQuestionAnswer_RefusesWhenTwoSessionsAreWaiting(t *testing.T) {
	exec, sessions, _, _ := newQuestionExec(t)
	sessions.located = map[string][]worktree.QuestionLocation{
		"req-1": {{SessionID: "sess-2"}, {SessionID: "sess-3", Worktree: "feature-x"}},
	}

	_, err := callAs(t, exec, callerInMain, "question_answer", map[string]any{
		"request_id": "req-1", "answers": []string{"Postgres"},
	})
	if err == nil || !strings.Contains(err.Error(), "more than one session") {
		t.Fatalf("error = %v, want a refusal to guess which session", err)
	}
	for _, id := range []string{"sess-2", "sess-3"} {
		if !strings.Contains(err.Error(), id) {
			t.Errorf("error = %q, want it to list %s as a candidate", err, id)
		}
	}
	if !strings.Contains(err.Error(), "session_id") {
		t.Errorf("error = %q, want it to name the argument that settles it", err)
	}
	if sessions.questions != nil {
		t.Error("an ambiguous answer reached the session layer")
	}
}

// session_id settles it, and the answer goes to exactly that one.
func TestQuestionAnswer_SessionIDPicksBetweenTheCandidates(t *testing.T) {
	exec, sessions, _, _ := newQuestionExec(t)
	sessions.located = map[string][]worktree.QuestionLocation{
		"req-1": {{SessionID: "sess-2"}, {SessionID: "sess-3", Worktree: "feature-x"}},
	}

	if _, err := callAs(t, exec, callerInMain, "question_answer", map[string]any{
		"request_id": "req-1", "answers": []string{"Postgres"}, "session_id": "sess-3",
	}); err != nil {
		t.Fatalf("question_answer: %v", err)
	}
	if got := sessions.questions.answered[0].sessionID; got != "sess-3" {
		t.Errorf("delivered to %q, want the session named", got)
	}
	if got := sessions.askedFor; len(got) != 1 || got[0] != "feature-x" {
		t.Errorf("resolved worktrees = %v, want that session's worktree", got)
	}
}

// A request id nothing is waiting on cannot be explained without a session to
// read the transcript of, so the refusal says so and points at the one argument
// that would let it say more.
func TestQuestionAnswer_RefusesAQuestionNobodyIsWaitingOn(t *testing.T) {
	exec, sessions, _, _ := newQuestionExec(t)

	_, err := callAs(t, exec, callerInMain, "question_answer", map[string]any{
		"request_id": "req-1", "answers": []string{"Postgres"},
	})
	if err == nil || !strings.Contains(err.Error(), "not waiting for an answer in any session") {
		t.Fatalf("error = %v, want a refusal", err)
	}
	if !strings.Contains(err.Error(), "session_id") {
		t.Errorf("error = %q, want it to say how to be told which", err)
	}
	if sessions.questions != nil {
		t.Error("the answer reached the session layer anyway")
	}
}

// Naming a session that is not waiting on it is handed to the chat layer rather
// than refused here: that layer reads the transcript and says who resolved it
// and when, which is the answer the agent needs.
func TestQuestionAnswer_ANamedSessionIsAskedEvenWhenItIsNotWaiting(t *testing.T) {
	exec, sessions, _, _ := newQuestionExec(t)
	sessions.worktreeOf = map[string]string{"sess-2": "feature-x"}
	sessions.questions = &stubQuestions{
		answerErr: chat.ErrQuestionNotPending,
	}

	_, err := callAs(t, exec, callerInMain, "question_answer", map[string]any{
		"request_id": "req-1", "answers": []string{"Postgres"}, "session_id": "sess-2",
	})
	if !errors.Is(err, chat.ErrQuestionNotPending) {
		t.Fatalf("error = %v, want the chat layer's own account", err)
	}
	if !isUserError(err) {
		t.Error("answering a question that is over is the agent's mistake, not a server fault")
	}
}

// The same refusal, reached the other way: a caller that named its own session
// for somebody else's request id. It must not be told it posted that question —
// it did not, and the index says so.
func TestQuestionAnswer_RefusesItsOwnSessionNamedOutright(t *testing.T) {
	exec, sessions, _, _ := newQuestionExec(t)
	sessions.worktreeOf = map[string]string{"sess-1": ""}

	_, err := callAs(t, exec, callerInMain, "question_answer", map[string]any{
		"request_id": "req-1", "answers": []string{"Postgres"}, "session_id": "sess-1",
	})
	if err == nil || !strings.Contains(err.Error(), "is your own") {
		t.Fatalf("error = %v, want a refusal to answer in its own session", err)
	}
	if strings.Contains(err.Error(), "posted") {
		t.Errorf("error = %q, claims this session posted a question the index does not have", err)
	}
	if sessions.questions != nil {
		t.Error("the answer reached the session layer anyway")
	}
}

func TestQuestionAnswer_RefusesAnUnknownSession(t *testing.T) {
	exec, _, _, _ := newQuestionExec(t)

	_, err := callAs(t, exec, callerInMain, "question_answer", map[string]any{
		"request_id": "req-1", "answers": []string{"Postgres"}, "session_id": "nope",
	})
	if err == nil || !strings.Contains(err.Error(), "no session nope") {
		t.Fatalf("error = %v, want a refusal naming the session", err)
	}
	if !isUserError(err) {
		t.Error("naming a session that does not exist is the caller's mistake")
	}
}

// TestQuestionAnswer_DeliversToAStoppedWork: the answer starts a turn in that
// session whoever gave it, so refusing here would only leave the work stopped
// while its agent ran. It is delivered, and the work layer is told — which is
// what puts the work back to active.
func TestQuestionAnswer_DeliversToAStoppedWork(t *testing.T) {
	exec, sessions, store, roleID := newQuestionExec(t)
	workID := startedWork(t, store, roleID, "Ship the API", "sess-2")
	if err := store.Stop(context.Background(), workID); err != nil {
		t.Fatalf("stop work: %v", err)
	}
	engine := &spyEngine{}
	exec.SetWorkEngine(engine)
	sessions.located = map[string][]worktree.QuestionLocation{
		"req-1": {{SessionID: "sess-2"}},
	}

	if _, err := callAs(t, exec, callerInMain, "question_answer", map[string]any{
		"request_id": "req-1", "answers": []string{"Postgres"},
	}); err != nil {
		t.Fatalf("question_answer: %v", err)
	}

	if len(sessions.questions.answered) != 1 || sessions.questions.answered[0].sessionID != "sess-2" {
		t.Fatalf("answered = %+v, want the stopped work's session", sessions.questions.answered)
	}
	if !slices.Equal(engine.answered, []string{"sess-2"}) {
		t.Errorf("engine told about %v, want the stopped work's session so it goes back to active", engine.answered)
	}
}

func TestQuestionAnswer_RequiresARequestID(t *testing.T) {
	exec, _, _, _ := newQuestionExec(t)
	_, err := callAs(t, exec, callerInMain, "question_answer", map[string]any{})
	if err == nil || !strings.Contains(err.Error(), "request_id is required") {
		t.Fatalf("error = %v, want a refusal naming the missing argument", err)
	}
}

// A call with no session behind it has nobody to record as the answerer.
func TestQuestionAnswer_RefusedWithoutACallerSession(t *testing.T) {
	exec, _, _, _ := newQuestionExec(t)
	_, err := callAs(t, exec, Caller{}, "question_answer", map[string]any{"request_id": "req-1"})
	if err == nil || !strings.Contains(err.Error(), "nobody to record as having answered") {
		t.Fatalf("error = %v, want a refusal explaining what is missing", err)
	}
}

// spyEngine records what the question tools reported to the work layer.
type spyEngine struct {
	// posted holds each report's questions: one entry per question_post call.
	posted   [][]session.PendingQuestion
	postedIn []string
	answered []string
}

func (s *spyEngine) HandleQuestionsPosted(sessionID string, qs []session.PendingQuestion) {
	s.postedIn = append(s.postedIn, sessionID)
	s.posted = append(s.posted, qs)
}

func (s *spyEngine) HandleAnswer(sessionID string) {
	s.answered = append(s.answered, sessionID)
}

// TestQuestionTools_ReportToTheWorkLayer: a question posted may be one the
// story above can answer, and an answer delivered gives that work its nudge
// allowance back. Both are things that happened to a session, which is what the
// engine's inputs are.
func TestQuestionTools_ReportToTheWorkLayer(t *testing.T) {
	exec, sessions, _, _ := newQuestionExec(t)
	engine := &spyEngine{}
	exec.SetWorkEngine(engine)
	sessions.located = map[string][]worktree.QuestionLocation{
		"req-1": {{SessionID: "sess-2"}},
	}

	if _, err := callAs(t, exec, callerInMain, "question_post", oneQuestion(map[string]any{
		"header": "Database", "question": "Which database?",
	})); err != nil {
		t.Fatalf("question_post: %v", err)
	}
	if len(engine.posted) != 1 || engine.postedIn[0] != "sess-1" {
		t.Fatalf("posted = %+v in %v, want the caller's own question", engine.posted, engine.postedIn)
	}
	if engine.posted[0][0].Question != "Which database?" {
		t.Errorf("posted question = %q, want the question itself, which is what the story is shown", engine.posted[0][0].Question)
	}

	if _, err := callAs(t, exec, callerInMain, "question_answer", map[string]any{
		"request_id": "req-1", "text": "Postgres",
	}); err != nil {
		t.Fatalf("question_answer: %v", err)
	}
	if len(engine.answered) != 1 || engine.answered[0] != "sess-2" {
		t.Errorf("answered = %v, want the session that was asked", engine.answered)
	}
}

// A delivery that failed hands the agent nothing, so nothing is reported.
func TestQuestionAnswer_ReportsNothingWhenTheDeliveryFailed(t *testing.T) {
	exec, sessions, _, _ := newQuestionExec(t)
	engine := &spyEngine{}
	exec.SetWorkEngine(engine)
	sessions.located = map[string][]worktree.QuestionLocation{
		"req-1": {{SessionID: "sess-2"}},
	}
	sessions.questions = &stubQuestions{answerErr: chat.ErrTurnAwaitingAnswer}

	_, err := callAs(t, exec, callerInMain, "question_answer", map[string]any{
		"request_id": "req-1", "text": "Postgres",
	})
	if err == nil {
		t.Fatal("question_answer succeeded with a delivery that failed")
	}
	// Told what is in the way there, not handed the sentence written for the
	// person sitting in that session — this agent has no permission card to
	// answer.
	if !strings.Contains(err.Error(), "still waiting") || strings.Contains(err.Error(), "stop the turn") {
		t.Errorf("error = %q, want it addressed to the agent that called", err)
	}
	if !isUserError(err) {
		t.Error("a session that is busy is not this server's fault")
	}
	if len(engine.answered) != 0 {
		t.Errorf("answered = %v, want nothing reported for an undelivered answer", engine.answered)
	}
}

// A refusal is only useful if the candidates can be told apart, and a session id
// is not something an agent has ever been shown: it meets the question through
// the work around it. So each candidate is named with the work running in it,
// and one running none is still listed.
func TestQuestionAnswer_CandidateSessionsAreNamedByTheirWork(t *testing.T) {
	exec, sessions, store, roleID := newQuestionExec(t)
	forked := startedWork(t, store, roleID, "Move the parser", "sess-3")
	sessions.located = map[string][]worktree.QuestionLocation{
		"req-1": {{SessionID: "sess-2"}, {SessionID: "sess-3", Worktree: "feature-x"}},
	}

	_, err := callAs(t, exec, callerInMain, "question_answer", map[string]any{
		"request_id": "req-1", "answers": []string{"Postgres"},
	})
	if err == nil {
		t.Fatal("question_answer answered an ambiguous request id")
	}
	for _, want := range []string{forked, "Move the parser", "sess-2"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error = %q, want it to name %q", err, want)
		}
	}
}

// The session_id description is the only account of the pair rule an agent gets
// — ordinary sessions have no system prompt — so the claims it cannot derive are
// pinned, not the wording: that a fork is what puts one id in two sessions, that
// leaving the argument out is allowed, and that an ambiguous id is refused
// rather than guessed at.
func TestQuestionAnswer_SessionIDDescribesThePairRule(t *testing.T) {
	var answer *toolDefinition
	for i := range toolDefinitions {
		if toolDefinitions[i].Name == "question_answer" {
			answer = &toolDefinitions[i]
		}
	}
	if answer == nil {
		t.Fatal("question_answer is not advertised")
	}
	if slices.Contains(answer.InputSchema.Required, "session_id") {
		t.Error("session_id is required, so the token-saving half of the rule is gone")
	}
	for _, want := range []string{"fork", "more than one", "refused"} {
		if !strings.Contains(answer.InputSchema.Properties["session_id"].Description, want) {
			t.Errorf("the session_id description does not say %q", want)
		}
	}
}

// A fork leaves the same request id open in two sessions, and a caller that
// holds one of them is withdrawing its own copy — ordinary, and no business of
// the other session's, which keeps asking until its own agent is done with it.
func TestQuestionCancel_AForkLeavesTheOtherCopyAlone(t *testing.T) {
	exec, sessions, _, _ := newQuestionExec(t)
	sessions.located = map[string][]worktree.QuestionLocation{
		"req-1": {{SessionID: "sess-1"}, {SessionID: "sess-2", Worktree: "feature-x"}},
	}

	if _, err := callAs(t, exec, callerInMain, "question_cancel", map[string]any{"request_id": "req-1"}); err != nil {
		t.Fatalf("question_cancel: %v", err)
	}
	if got := sessions.questions.cancelledFor; len(got) != 1 || got[0] != "sess-1" {
		t.Errorf("withdrawn from %v, want the caller's own session only", got)
	}
}
