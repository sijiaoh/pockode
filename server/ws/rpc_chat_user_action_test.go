package ws

import (
	"testing"

	"github.com/pockode/server/rpc"
	"github.com/pockode/server/work"
)

// Every entry point that counts as a user action resumes the work, whichever
// way the work was paused. They are three separate call sites, so a new one
// forgetting to say so is exactly the kind of omission this pins down.
func TestHandler_UserAction_ResumesPausedWork(t *testing.T) {
	for _, paused := range []work.WorkStatus{work.StatusNeedsInput, work.StatusWaiting} {
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
				workID, sessionID := startWorkWithStatus(t, env, paused)

				resp := env.call(action.method, action.params(sessionID))
				if resp.Error != nil {
					t.Fatalf("unexpected error: %s", resp.Error.Message)
				}

				requireWorkStatus(t, env, workID, work.StatusInProgress,
					"a user action must resume the work it was paused for")
			})
		}
	}
}

// The sentinel for the one entry point that deliberately does NOT count as a
// user action. Interrupt takes the turn away instead of handing the session
// something to go on, and the interrupted event that follows stops in_progress
// work — so resuming here would walk a paused work into stopped. Reading
// handleInterrupt cannot tell an omission from a decision; this test can.
func TestHandler_Interrupt_LeavesPausedWorkPaused(t *testing.T) {
	for _, paused := range []work.WorkStatus{work.StatusNeedsInput, work.StatusWaiting} {
		t.Run(string(paused), func(t *testing.T) {
			env := newTestEnv(t, &mockAgent{})
			workID, sessionID := startWorkWithStatus(t, env, paused)

			resp := env.call("chat.interrupt", rpc.InterruptParams{SessionID: sessionID})
			if resp.Error != nil {
				t.Fatalf("unexpected error: %s", resp.Error.Message)
			}

			requireWorkStatus(t, env, workID, paused,
				"interrupt must not resume paused work")
		})
	}
}
