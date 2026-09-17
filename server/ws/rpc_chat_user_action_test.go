package ws

import (
	"errors"
	"strings"
	"testing"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/rpc"
	"github.com/pockode/server/work"
)

// Every entry point that counts as a user message clears the work's wait,
// whichever way the work was waiting. They are three separate call sites, so a
// new one forgetting to say so is exactly the kind of omission this pins down.
func TestHandler_UserMessage_ClearsTheWait(t *testing.T) {
	for _, paused := range []work.WorkWait{work.WaitUser, work.WaitChild} {
		for _, action := range []struct {
			name   string
			method string
			params func(sessionID string) any
			// raises is the prompt the session has to be blocked on before the
			// answer below is one it will take. Nil for the message case, which
			// answers nothing.
			raises agent.AgentEvent
		}{
			{"message", "chat.message", func(s string) any {
				return rpc.MessageParams{SessionID: s, Content: "carry on"}
			}, nil},
			{"permission_response", "chat.permission_response", func(s string) any {
				return rpc.PermissionResponseParams{SessionID: s, RequestID: "req-1", Choice: "allow"}
			}, agent.PermissionRequestEvent{RequestID: "req-1", ToolName: "Bash"}},
			{"question_response", "chat.question_response", func(s string) any {
				return rpc.QuestionResponseParams{SessionID: s, RequestID: "req-1", Answers: map[string]string{"q": "a"}}
			}, agent.AskUserQuestionEvent{RequestID: "req-1"}},
		} {
			t.Run(string(paused)+"/"+action.name, func(t *testing.T) {
				env := newTestEnv(t, &mockAgent{})
				workID, sessionID := startWorkWaiting(t, env, paused)
				if action.raises != nil {
					raisePrompt(t, env, sessionID, "req-1", action.raises)
				}

				resp := env.call(action.method, action.params(sessionID))
				if resp.Error != nil {
					t.Fatalf("unexpected error: %s", resp.Error.Message)
				}

				requireWorkWait(t, env, workID, work.WaitNone,
					"a user message must clear the wait it was parked on")
				requireWorkStatus(t, env, workID, work.StatusActive,
					"a user message leaves the work being driven")
			})
		}
	}
}

// The sentinel for the one entry point that deliberately is NOT a user message.
// Interrupt takes the turn away instead of handing the session something to go
// on, and the aborted turn that follows stops the work — so clearing the wait
// here would walk a waiting work into stopped. Reading handleInterrupt cannot
// tell an omission from a decision; this test can.
func TestHandler_Interrupt_LeavesTheWaitAlone(t *testing.T) {
	for _, paused := range []work.WorkWait{work.WaitUser, work.WaitChild} {
		t.Run(string(paused), func(t *testing.T) {
			env := newTestEnv(t, &mockAgent{})
			workID, sessionID := startWorkWaiting(t, env, paused)

			resp := env.call("chat.interrupt", rpc.InterruptParams{SessionID: sessionID})
			if resp.Error != nil {
				t.Fatalf("unexpected error: %s", resp.Error.Message)
			}

			requireWorkWait(t, env, workID, paused,
				"interrupt must not clear a wait")
		})
	}
}

// An answer only reaches the process that raised the prompt. When that process
// is gone — or has been replaced, or somebody else answered first — the refusal
// has to reach the client with its reason, because that is what puts the card
// back to Expired instead of leaving the optimistic answer on screen
// (docs/lifecycle-ui.md §8).
func TestHandler_Answer_RefusedWhenNobodyIsWaiting(t *testing.T) {
	for _, tt := range []struct {
		name   string
		method string
		params func(sessionID string) any
	}{
		{"permission_response", "chat.permission_response", func(s string) any {
			return rpc.PermissionResponseParams{SessionID: s, RequestID: "gone", Choice: "allow"}
		}},
		{"question_response", "chat.question_response", func(s string) any {
			return rpc.QuestionResponseParams{SessionID: s, RequestID: "gone", Answers: map[string]string{"q": "a"}}
		}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			env := newTestEnv(t, &mockAgent{})
			workID, sessionID := startWorkWaiting(t, env, work.WaitUser)

			resp := env.call(tt.method, tt.params(sessionID))
			if resp.Error == nil {
				t.Fatal("answering a prompt nobody is waiting on was accepted")
			}
			if !strings.Contains(resp.Error.Message, "no longer waiting") {
				t.Errorf("error = %q, want the server's own reason", resp.Error.Message)
			}

			// And the work is still parked: a refused answer handed the agent
			// nothing, so there is no turn for a resumed work to wait on.
			requireWorkWait(t, env, workID, work.WaitUser,
				"a refused answer is not the user handing the session something to go on")
		})
	}
}

// The same rule for the plain message path: what resumes a work is the agent
// having been handed something to go on, and a send that failed handed it
// nothing. Left active here, the work would sit there with no turn coming to
// end it and nothing to nudge.
func TestHandler_Message_LeavesTheWaitWhenTheSendFails(t *testing.T) {
	mock := &mockAgent{}
	env := newTestEnv(t, mock)
	workID, sessionID := startWorkWaiting(t, env, work.WaitUser)

	// A message with no process behind it starts one, and this one will not
	// start — an expired login, a provider outage, a broken CLI path.
	env.getMainWorktree().ProcessManager.Close(sessionID)
	mock.startErr = errors.New("agent will not start")

	resp := env.call("chat.message", rpc.MessageParams{SessionID: sessionID, Content: "carry on"})
	if resp.Error == nil {
		t.Fatal("a send that could not start its agent was reported as success")
	}

	requireWorkWait(t, env, workID, work.WaitUser,
		"a message that never reached the agent is not the user handing it something to go on")
}
