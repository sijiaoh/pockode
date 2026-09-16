package agent

import (
	"testing"

	"github.com/pockode/server/session"
)

// The session store writes one event record of its own: the process_ended that
// a run killed with the server never got to write, which is what tells a
// replayed transcript that the prompts it is showing can no longer be answered.
// It cannot import this package — this one is built on top of it — so the type
// name is spelled out on both sides, and this is what keeps them the same.
func TestProcessEndedRecordTypeMatchesTheSessionStores(t *testing.T) {
	if string(EventTypeProcessEnded) != session.HistoryTypeProcessEnded {
		t.Fatalf("agent writes %q, the session store writes %q",
			EventTypeProcessEnded, session.HistoryTypeProcessEnded)
	}
}
