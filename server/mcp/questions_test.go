package mcp

import (
	"context"
	"encoding/json"
	"errors"
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
		"header":   "Database",
		"question": "Which database?",
		"options": []map[string]string{
			{"label": "Postgres", "description": "the one we have"},
			{"label": "SQLite"},
		},
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
				"header": "h", "question": "q", "request_id": "req-1",
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

func TestQuestionPost_ArgumentRefusals(t *testing.T) {
	tests := []struct {
		name string
		args map[string]any
		want string
	}{
		{"no question", map[string]any{"header": "h"}, "question is required"},
		{"no header", map[string]any{"question": "q"}, "header is required"},
		{"an option with no label", map[string]any{
			"header": "h", "question": "q",
			"options": []map[string]string{{"description": "d"}},
		}, "every option needs a label"},
		{"two options with one label", map[string]any{
			"header": "h", "question": "q",
			"options": []map[string]string{{"label": "a"}, {"label": "a"}},
		}, "share the label"},
		{"multi_select with nothing to select", map[string]any{
			"header": "h", "question": "q", "multi_select": true,
		}, "needs options to select from"},
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

// TestQuestionPost_RefusedOnAClosedWork: the chat is finished with, so a
// question posted into it is one nobody will ever see. The refusal names the way
// out, which belongs to the work rather than to the question.
func TestQuestionPost_RefusedOnAClosedWork(t *testing.T) {
	exec, sessions, store, roleID := newQuestionExec(t)

	created, err := store.Create(context.Background(), work.Work{
		Type: work.WorkTypeStory, Title: "Ship it", AgentRoleID: roleID,
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

	_, err = callAs(t, exec, callerInMain, "question_post", map[string]any{
		"header": "Database", "question": "Which database?",
	})
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
	if _, err := callAs(t, exec, callerInMain, "question_post", map[string]any{
		"header": "Database", "question": "Which database?",
	}); err != nil {
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
		// Ordinary sessions get no system prompt, so the description is the only
		// place the two surprising facts can be said.
		if name == "question_post" {
			for _, want := range []string{"returns immediately", "arrives later as an ordinary message", "question_cancel"} {
				if !strings.Contains(found.Description, want) {
					t.Errorf("question_post description does not say %q", want)
				}
			}
			options := found.InputSchema.Properties["options"]
			if options.Items == nil || options.Items.Properties["label"].Type != "string" {
				t.Error("the options schema does not describe the objects it takes")
			}
		}
	}
}

// The agent meets three texts about asking the user — the question_post reply,
// the work_needs_input retirement notice, and the refusal a CLI's own question
// tool gets (agent.CLIQuestionRefusal, sent from both agent packages). They
// describe one mechanism, and an agent reading three different accounts of it
// has to work out for itself whether they are one thing or three.
//
// Only the load-bearing claims are pinned, not the wording: each text has to say
// that the agent carries on and that the answer comes back as a message. Those
// are the two things a model cannot derive, and the two a rewrite is most likely
// to lose.
func TestAskingTheUser_TheThreeTextsMakeTheSameClaims(t *testing.T) {
	exec, _, _, _ := newQuestionExec(t)

	posted, err := callAs(t, exec, Caller{SessionID: "sess-1"}, "question_post", map[string]any{
		"header": "Database", "question": "Which database?",
	})
	if err != nil {
		t.Fatalf("question_post: %v", err)
	}

	_, retirementErr := callAs(t, exec, Caller{SessionID: "sess-1"}, "work_needs_input", map[string]any{})
	if retirementErr == nil {
		t.Fatal("work_needs_input answered instead of saying it is retired")
	}

	texts := map[string]string{
		"question_post reply":           posted,
		"work_needs_input retirement":   retirementErr.Error(),
		"the CLI question tool refusal": agent.CLIQuestionRefusal,
	}
	for name, text := range texts {
		for _, claim := range []string{"carry on", "message in this chat"} {
			if !strings.Contains(text, claim) {
				t.Errorf("%s does not say %q: %s", name, claim, text)
			}
		}
	}

	// The two that redirect have to name where to go.
	for _, name := range []string{"work_needs_input retirement", "the CLI question tool refusal"} {
		if !strings.Contains(texts[name], "question_post") {
			t.Errorf("%s does not name question_post: %s", name, texts[name])
		}
	}
}

// --- question_answer ---

// startedWork creates a story, starts it on sessionID, and hands back its id.
func startedWork(t *testing.T, store work.Store, roleID, title, sessionID string) string {
	t.Helper()
	created, err := store.Create(context.Background(), work.Work{
		Type: work.WorkTypeStory, Title: title, AgentRoleID: roleID,
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

// TestQuestionAnswer_RefusesAStoppedWork: a stopped work was handed back to a
// person, and a message into its session would set it running again behind
// them. The user can still answer the question themselves.
func TestQuestionAnswer_RefusesAStoppedWork(t *testing.T) {
	exec, sessions, store, roleID := newQuestionExec(t)
	workID := startedWork(t, store, roleID, "Ship the API", "sess-2")
	if err := store.Stop(context.Background(), workID); err != nil {
		t.Fatalf("stop work: %v", err)
	}
	sessions.located = map[string][]worktree.QuestionLocation{
		"req-1": {{SessionID: "sess-2"}},
	}

	_, err := callAs(t, exec, callerInMain, "question_answer", map[string]any{
		"request_id": "req-1", "answers": []string{"Postgres"},
	})
	if err == nil || !strings.Contains(err.Error(), "is stopped") {
		t.Fatalf("error = %v, want a refusal naming the stopped work", err)
	}
	if !strings.Contains(err.Error(), workID) {
		t.Errorf("error = %q, want it to name which work", err)
	}
	if sessions.questions != nil {
		t.Error("the answer reached a stopped work's session")
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
	posted   []session.PendingQuestion
	postedIn []string
	answered []string
}

func (s *spyEngine) HandleQuestionPosted(sessionID string, q session.PendingQuestion) {
	s.postedIn = append(s.postedIn, sessionID)
	s.posted = append(s.posted, q)
}

func (s *spyEngine) HandleAgentAnswer(sessionID string) {
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

	if _, err := callAs(t, exec, callerInMain, "question_post", map[string]any{
		"header": "Database", "question": "Which database?",
	}); err != nil {
		t.Fatalf("question_post: %v", err)
	}
	if len(engine.posted) != 1 || engine.postedIn[0] != "sess-1" {
		t.Fatalf("posted = %+v in %v, want the caller's own question", engine.posted, engine.postedIn)
	}
	if engine.posted[0].Question != "Which database?" {
		t.Errorf("posted question = %q, want the question itself, which is what the story is shown", engine.posted[0].Question)
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
