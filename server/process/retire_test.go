package process

import (
	"context"
	"testing"
	"time"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/session"
)

// A work closing hands its session a grace period to finish what it was saying,
// and takes everything else away. These are the three things that follow.

// Nobody is coming back to answer a question raised in a work the user has
// finished with, so it is withdrawn rather than left pending forever — and with
// the reason on the record, because "the agent changed its mind" and "your work
// is closed" are different pieces of news.
func TestRetire_CancelsThePromptsNobodyWillAnswer(t *testing.T) {
	m, mock, store, proc := startedTurn(t, leaseTestBudgets)
	sess := mock.session(t, "sess-1")

	sess.emit(t, agent.AskUserQuestionEvent{RequestID: "req-1"})
	sess.emit(t, agent.PermissionRequestEvent{RequestID: "req-2", ToolName: "Bash"})
	waitUntil(t, "both prompts", func() bool { return len(proc.turnState().Blockers) == 2 })

	m.RetireSession("sess-1")

	waitUntil(t, "the prompts to be withdrawn", func() bool {
		return len(proc.turnState().Blockers) == 0
	})

	cancelled := map[string]agent.CancelReason{}
	for _, record := range historyRecords(t, store, "sess-1") {
		if record.Type == agent.EventTypeRequestCancelled {
			cancelled[record.RequestID] = record.Reason
		}
	}
	for _, requestID := range []string{"req-1", "req-2"} {
		if got := cancelled[requestID]; got != agent.ReasonWorkClosed {
			t.Errorf("%s cancelled with reason %q, want %q", requestID, got, agent.ReasonWorkClosed)
		}
	}
}

// The grace is for the sentence the agent is in the middle of. Once the turn is
// over there is nothing left to wait for, and the process goes.
func TestRetire_EndsTheProcessWhenTheTurnEnds(t *testing.T) {
	m, mock, _, _ := startedTurn(t, leaseTestBudgets)
	sess := mock.session(t, "sess-1")

	m.RetireSession("sess-1")
	if m.GetProcess("sess-1") == nil {
		t.Fatal("the process was ended before its turn finished; the grace is what lets it sign off")
	}

	sess.emit(t, agent.DoneEvent{})

	waitUntil(t, "the process to be collected", func() bool { return m.GetProcess("sess-1") == nil })
}

// The work store reports a change for reasons that have nothing to do with the
// session — a retitle, an edit — and each of those reaches the engine as another
// "this work is closed". None of them may act twice, and above all none may
// restart the grace.
//
// Retirement is armed before the prompt exists, so the one withdrawal is the
// stream goroutine's and the two calls that follow are pure no-ops. That is the
// arrangement the claim is about, and it is also what makes the count below a
// fact rather than a race: see the note on enforceRetirement for the one
// interleave that can write a second, harmless withdrawal.
func TestRetire_IsIdempotent(t *testing.T) {
	m, mock, store, proc := startedTurn(t, leaseTestBudgets)
	sess := mock.session(t, "sess-1")

	m.RetireSession("sess-1")
	sess.emit(t, agent.AskUserQuestionEvent{RequestID: "req-1"})
	waitUntil(t, "the prompt to be withdrawn", func() bool {
		return cancellationsFor(t, store, "req-1") == 1
	})

	m.RetireSession("sess-1")
	m.RetireSession("sess-1")

	if got := cancellationsFor(t, store, "req-1"); got != 1 {
		t.Errorf("wrote %d cancellations for one prompt, want 1", got)
	}
	if m.GetProcess("sess-1") == nil {
		t.Error("the process was ended while its turn was still running")
	}
	if len(proc.turnState().Blockers) != 0 {
		t.Errorf("blockers = %+v, want none", proc.turnState().Blockers)
	}
}

func cancellationsFor(t *testing.T, store session.Store, requestID string) int {
	t.Helper()
	count := 0
	for _, record := range historyRecords(t, store, "sess-1") {
		if record.Type == agent.EventTypeRequestCancelled && record.RequestID == requestID {
			count++
		}
	}
	return count
}

// A prompt raised inside the grace is in the same position as one raised before
// it: the work is closed either way. Buying the session more time for it is what
// "the grace is a deadline, not a budget" rules out.
func TestRetire_CancelsAPromptRaisedInsideTheGrace(t *testing.T) {
	m, mock, _, proc := startedTurn(t, leaseTestBudgets)
	sess := mock.session(t, "sess-1")

	m.RetireSession("sess-1")
	sess.emit(t, agent.AskUserQuestionEvent{RequestID: "late"})

	waitUntil(t, "the late prompt to be withdrawn", func() bool {
		turn := proc.turnState()
		return len(turn.Blockers) == 0 && turn.Phase != session.PhaseBlocked
	})
}

// A work can be reopened inside the grace, and the message that follows builds a
// new process for the same session. The grace belongs to the process it was
// armed for; ending the session by name would kill the turn the user had just
// started.
func TestRetire_LeavesTheProcessThatReplacedIt(t *testing.T) {
	m, mock, store, retired := startedTurn(t, leaseTestBudgets)

	m.RetireSession("sess-1")
	mock.session(t, "sess-1").emit(t, agent.DoneEvent{})
	waitUntil(t, "the retired process to be collected", func() bool { return m.GetProcess("sess-1") == nil })

	// Reopen: the same session, a new process.
	replacement, created, err := m.GetOrCreateProcess(context.Background(), sessionMeta(t, store, "sess-1"))
	if err != nil || !created {
		t.Fatalf("failed to build the replacement process: created=%v err=%v", created, err)
	}

	// The grace deadline of the *first* process falls due.
	m.endRetirement(retired)

	if m.GetProcess("sess-1") != replacement {
		t.Error("a timer armed for the retired process ended the one that replaced it")
	}
}

// sessionMeta reads back a session the store already holds, which is what a
// second GetOrCreateProcess for the same session is handed.
func sessionMeta(t *testing.T, store session.Store, sessionID string) session.SessionMeta {
	t.Helper()
	meta, found, err := store.Get(sessionID)
	if err != nil || !found {
		t.Fatalf("get session %q: err=%v found=%v", sessionID, err, found)
	}
	return meta
}

// Retirement means "nobody is coming back to this session". A prompt is somebody
// coming back — a work closed and reopened inside the grace sends its restart
// message to this very process, and a user can type into a closed work's chat
// whenever they like. The turn they start must not be ended by a timer armed
// before it existed.
func TestRetire_APromptCancelsTheRetirement(t *testing.T) {
	m, mock, store, proc := startedTurn(t, leaseTestBudgets)
	sess := mock.session(t, "sess-1")

	m.RetireSession("sess-1")
	if err := proc.SendMessage("carry on"); err != nil {
		t.Fatalf("SendMessage: %v", err)
	}

	// The grace deadline falls due on a session that is being used again.
	m.endRetirement(proc)
	if m.GetProcess("sess-1") == nil {
		t.Fatal("the grace ended a session somebody had come back to")
	}

	// And the prompts of that new turn are nobody's to withdraw any more.
	sess.emit(t, agent.AskUserQuestionEvent{RequestID: "req-1"})
	waitUntil(t, "the question", func() bool { return len(proc.turnState().Blockers) == 1 })
	if got := cancellationsFor(t, store, "req-1"); got != 0 {
		t.Errorf("withdrew %d prompts of a revived session, want none", got)
	}
}

// A session outlives its processes: one is collected — by the idle lease, by a
// closed work's grace, by a Stop — and the next message builds another under the
// same id moments later. The predecessor's stream then ends *after* its
// successor is in the map, and everything its epilogue does speaks for the
// session rather than for itself.
//
// Both halves of that epilogue are wrong once it has been replaced. Removing
// "the process for this session" evicts the live successor, which keeps running
// unreachable and uncollectable while the session reads as having no process;
// and reducing `process_ended` aborts the successor's turn — which the work
// engine reads as "do not carry on" and stops the work for it.
func TestProcess_AReplacedProcessDoesNotSpeakForItsSession(t *testing.T) {
	m, mock, store, first := startedTurn(t, leaseTestBudgets)
	firstSession := mock.session(t, "sess-1")

	// Taken out of the map without being closed, the way every collection path
	// does it, so the replacement can be built while the first stream is still
	// running.
	m.removeWhere(func(candidate *Process) bool { return candidate == first })

	second, created, err := m.GetOrCreateProcess(context.Background(), sessionMeta(t, store, "sess-1"))
	if err != nil || !created {
		t.Fatalf("failed to build the replacement process: created=%v err=%v", created, err)
	}
	if err := second.SendMessage("go on"); err != nil {
		t.Fatalf("SendMessage: %v", err)
	}

	// Only now does the first process's stream end.
	firstSession.Close()
	select {
	case <-first.done:
	case <-time.After(awaitTimeout):
		t.Fatal("timed out waiting for the replaced process's stream to finish")
	}

	if m.GetProcess("sess-1") != second {
		t.Error("a process that had already been replaced evicted its successor")
	}
	if !second.turnState().InProgress() {
		t.Errorf("turn = %+v, want the successor's turn still open", second.turnState())
	}
}
