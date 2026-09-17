package ws

import (
	"testing"

	"github.com/pockode/server/rpc"
	"github.com/pockode/server/work"
)

// A work waiting on a question survives its process dying — answering the
// question is what brings it back. Deleting the session takes that away: there
// is no transcript left to answer in. Without this, the work would wait forever,
// pointing at a session that no longer exists.
//
// The stop is the engine's, reached through the session store's own deletion
// event, so it lands a moment after the reply rather than inside the handler.
func TestHandler_SessionDelete_StopsItsWork(t *testing.T) {
	for _, wait := range []work.WorkWait{work.WaitUser, work.WaitChild, work.WaitNone} {
		t.Run(string("wait="+wait), func(t *testing.T) {
			env := newTestEnv(t, &mockAgent{})
			workID, sessionID := startWorkWaiting(t, env, wait)

			resp := env.call("session.delete", rpc.SessionDeleteParams{SessionID: sessionID})
			if resp.Error != nil {
				t.Fatalf("unexpected error: %s", resp.Error.Message)
			}

			waitForWorkStatus(t, env, workID, work.StatusStopped,
				"its session was deleted")
		})
	}
}
