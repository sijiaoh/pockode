package ws

import (
	"testing"

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
		}{
			{"message", "chat.message", func(s string) any {
				return rpc.MessageParams{SessionID: s, Content: "carry on"}
			}},
			{"permission_response", "chat.permission_response", func(s string) any {
				return rpc.PermissionResponseParams{SessionID: s, RequestID: "req-1", Choice: "allow"}
			}},
			{"question_response", "chat.question_response", func(s string) any {
				return rpc.QuestionResponseParams{SessionID: s, RequestID: "req-1", Answers: map[string]string{"q": "a"}}
			}},
		} {
			t.Run(string(paused)+"/"+action.name, func(t *testing.T) {
				env := newTestEnv(t, &mockAgent{})
				workID, sessionID := startWorkWaiting(t, env, paused)

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
