package ws

import (
	"context"
	"strings"
	"testing"

	"github.com/pockode/server/chat"
	"github.com/pockode/server/rpc"
	"github.com/pockode/server/session"
	"github.com/pockode/server/work"
	"github.com/sourcegraph/jsonrpc2"
)

// post asks a question through the chat client the way the question_post tool
// does, and returns the request id an answer names.
func post(t *testing.T, env *testEnv, sessionID, header string) string {
	t.Helper()
	q, err := env.getMainWorktree().ChatClient.PostQuestion(context.Background(), sessionID, chat.QuestionSpec{
		Header:   header,
		Question: "Which database?",
		Options:  []session.QuestionOption{{Label: "Postgres"}, {Label: "SQLite"}},
	})
	if err != nil {
		t.Fatalf("PostQuestion: %v", err)
	}
	return q.RequestID
}

func unanswered(t *testing.T, env *testEnv, sessionID string) []session.PendingQuestion {
	t.Helper()
	meta, found, err := env.getMainWorktree().SessionStore.Get(sessionID)
	if err != nil || !found {
		t.Fatalf("Get session = %v/%v", found, err)
	}
	return meta.Turn.Unanswered
}

// TestHandler_MessageAnsweringResolvesTheQuestions is the answering path over
// the wire: one message, several questions, and the list empties.
func TestHandler_MessageAnsweringResolvesTheQuestions(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	row, _ := env.createSession()

	first := post(t, env, row.ID, "Database")
	second := post(t, env, row.ID, "Runtime")

	resp := env.call("chat.message", rpc.MessageParams{
		SessionID: row.ID,
		Content:   "Answering:\n\nQ: Which database?\nA: Postgres",
		Answering: []rpc.QuestionAnswerParams{
			{RequestID: first, Answers: []string{"Postgres"}},
			{RequestID: second, Declined: true, Note: "ask the ops team"},
		},
	})
	if resp.Error != nil {
		t.Fatalf("chat.message with answers failed: %s", resp.Error.Message)
	}

	if got := unanswered(t, env, row.ID); len(got) != 0 {
		t.Errorf("unanswered = %+v, want both resolved", got)
	}
}

// TestHandler_MessageAnsweringRefusesTheWholeMessage is the contract the
// composer keeps its draft against: the refusal is CodeInvalidParams, it names
// every request that is already resolved, and nothing at all was delivered.
func TestHandler_MessageAnsweringRefusesTheWholeMessage(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	row, _ := env.createSession()

	first := post(t, env, row.ID, "Database")
	second := post(t, env, row.ID, "Runtime")
	if err := env.getMainWorktree().ChatClient.CancelQuestion(context.Background(), row.ID, second); err != nil {
		t.Fatalf("CancelQuestion: %v", err)
	}

	resp := env.call("chat.message", rpc.MessageParams{
		SessionID: row.ID,
		Content:   "both answers in one string",
		Answering: []rpc.QuestionAnswerParams{
			{RequestID: first, Answers: []string{"Postgres"}},
			{RequestID: second, Answers: []string{"Node"}},
		},
	})
	if resp.Error == nil {
		t.Fatal("answering a question that was already withdrawn was accepted")
	}
	if resp.Error.Code != jsonrpc2.CodeInvalidParams {
		t.Errorf("code = %d, want CodeInvalidParams (%d)", resp.Error.Code, jsonrpc2.CodeInvalidParams)
	}
	if !strings.Contains(resp.Error.Message, second) {
		t.Errorf("error = %q, want it to name the resolved request", resp.Error.Message)
	}
	if !strings.Contains(resp.Error.Message, "withdrawn by the agent") {
		t.Errorf("error = %q, want it to say what became of it", resp.Error.Message)
	}

	// The still-open question is untouched, so the client can send its answer
	// again without the user retyping anything.
	if got := unanswered(t, env, row.ID); len(got) != 1 || got[0].RequestID != first {
		t.Errorf("unanswered = %+v, want the open question left alone", got)
	}
}

// An answer the question never offered is refused the same way, and for the same
// reason the composer needs: the message is one string, so there is no part of
// it worth delivering.
func TestHandler_MessageAnsweringRefusesAnAnswerThatWasNotOffered(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	row, _ := env.createSession()
	id := post(t, env, row.ID, "Database")

	resp := env.call("chat.message", rpc.MessageParams{
		SessionID: row.ID,
		Content:   "MySQL",
		Answering: []rpc.QuestionAnswerParams{{RequestID: id, Answers: []string{"MySQL"}}},
	})
	if resp.Error == nil || resp.Error.Code != jsonrpc2.CodeInvalidParams {
		t.Fatalf("error = %+v, want CodeInvalidParams", resp.Error)
	}
	if got := unanswered(t, env, row.ID); len(got) != 1 {
		t.Errorf("unanswered = %+v, want the question still open", got)
	}
}

// A message with no answers on it is the ordinary path and must not be touched
// by any of this.
func TestHandler_MessageWithoutAnsweringLeavesQuestionsAlone(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	row, _ := env.createSession()
	id := post(t, env, row.ID, "Database")

	env.sendMessage(row.ID, "something else entirely")

	if got := unanswered(t, env, row.ID); len(got) != 1 || got[0].RequestID != id {
		t.Errorf("unanswered = %+v, want the question untouched", got)
	}
}

// An answer is a person acting on the work, but it is not the general-purpose
// attention a typed message is: it answers what the agent asked, and a story
// waiting for its subtasks is still waiting for exactly that. The routing
// decision is the handler's, taken on what the client sent — so this is where
// it is pinned, not in the engine's own tests.
func TestHandler_MessageAnsweringKeepsTheChildWait(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	workID, sessionID := startWorkWaiting(t, env, work.WaitChild)
	requestID := post(t, env, sessionID, "Database")

	resp := env.call("chat.message", rpc.MessageParams{
		SessionID: sessionID,
		Content:   "Answering:\n\nQ: Which database?\nA: Postgres",
		Answering: []rpc.QuestionAnswerParams{{RequestID: requestID, Answers: []string{"Postgres"}}},
	})
	if resp.Error != nil {
		t.Fatalf("chat.message with answers failed: %s", resp.Error.Message)
	}

	requireWorkWait(t, env, workID, work.WaitChild,
		"answering the agent's question is not one of its subtasks closing")
	requireWorkStatus(t, env, workID, work.StatusActive,
		"the work was active throughout; the agent asked and carried on")
}

// The other half of the same fork: a message that answers nothing is a person
// redirecting the work, and that does clear the wait.
func TestHandler_MessageWithoutAnswersClearsTheChildWait(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	workID, sessionID := startWorkWaiting(t, env, work.WaitChild)

	resp := env.call("chat.message", rpc.MessageParams{SessionID: sessionID, Content: "drop that and do this"})
	if resp.Error != nil {
		t.Fatalf("chat.message failed: %s", resp.Error.Message)
	}

	requireWorkWait(t, env, workID, work.WaitNone,
		"a plain message is the user redirecting the work")
}
