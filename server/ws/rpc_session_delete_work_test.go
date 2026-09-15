package ws

import (
	"testing"

	"github.com/pockode/server/rpc"
	"github.com/pockode/server/work"
)

// A work paused on a question survives its process dying — answering the
// question is what brings it back. Deleting the session takes that away: there
// is no transcript left to answer in. Without this, the work would sit in
// needs_input forever, pointing at a session that no longer exists.
func TestHandler_SessionDelete_StopsPausedWork(t *testing.T) {
	for _, status := range []work.WorkStatus{work.StatusNeedsInput, work.StatusWaiting, work.StatusInProgress} {
		t.Run(string(status), func(t *testing.T) {
			env := newTestEnv(t, &mockAgent{})
			workID, sessionID := startWorkWithStatus(t, env, status)

			resp := env.call("session.delete", rpc.SessionDeleteParams{SessionID: sessionID})
			if resp.Error != nil {
				t.Fatalf("unexpected error: %s", resp.Error.Message)
			}

			requireWorkStatus(t, env, workID, work.StatusStopped,
				"its session was deleted")
		})
	}
}
