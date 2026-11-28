package process

import (
	"context"
	"errors"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/session"
)

// An answer reaches the process that raised the prompt or it reaches nothing.
// Forwarding it anyway would record a turn as started for an answer the CLI has
// no idea what to do with, leaving a session that claims to be running with
// nothing coming to end it.
func TestAnswer_RefusedWhenTheSessionIsNoLongerWaiting(t *testing.T) {
	_, mock, _, proc := startedTurn(t, leaseTestBudgets)
	sess := mock.session(t, "sess-1")

	err := proc.SendPermissionResponse(agent.PermissionRequestData{RequestID: "gone"}, agent.PermissionAllow)
	if !errors.Is(err, ErrRequestNotPending) {
		t.Errorf("err = %v, want %v", err, ErrRequestNotPending)
	}
	if got := sess.answers.Load(); got != 0 {
		t.Errorf("the answer reached the CLI %d times, want 0", got)
	}
	if turn := proc.turnState(); !turn.Open {
		t.Error("a refused answer must leave the turn as it was")
	}
}

// The other half of the same rule: while the prompt is listed, the answer goes
// through and clears it.
func TestAnswer_AcceptedWhileThePromptIsLive(t *testing.T) {
	_, mock, _, proc := startedTurn(t, leaseTestBudgets)
	sess := mock.session(t, "sess-1")

	sess.emit(t, agent.PermissionRequestEvent{RequestID: "req-1", ToolName: "Bash"})
	waitUntil(t, "the prompt", func() bool { return proc.turnState().AwaitingAnswerTo("req-1") })

	if err := proc.SendPermissionResponse(agent.PermissionRequestData{RequestID: "req-1"}, agent.PermissionAllow); err != nil {
		t.Fatalf("answering a live prompt failed: %v", err)
	}
	if got := sess.answers.Load(); got != 1 {
		t.Errorf("answers delivered = %d, want 1", got)
	}
	if proc.turnState().AwaitingAnswerTo("req-1") {
		t.Error("the answered prompt is still listed as a blocker")
	}
}

// A person and a permission reviewer can answer one request at the same moment,
// and the CLI must be handed exactly one of the answers: a second
// control_response for the same request is noise on its stdin at best. The
// answers here race on purpose, which is what the turn copy alone could not
// settle — every one of them can read the prompt as still waiting.
func TestAnswer_FirstOfRacingAnswersWins(t *testing.T) {
	_, mock, _, proc := startedTurn(t, leaseTestBudgets)
	sess := mock.session(t, "sess-1")

	sess.emit(t, agent.PermissionRequestEvent{RequestID: "req-1", ToolName: "Bash"})
	waitUntil(t, "the prompt", func() bool { return proc.turnState().AwaitingAnswerTo("req-1") })

	const answers = 8
	data := agent.PermissionRequestData{RequestID: "req-1"}
	errs := make(chan error, answers)
	var start sync.WaitGroup
	start.Add(1)
	for i := range answers {
		go func() {
			start.Wait()
			if i%2 == 0 {
				errs <- proc.SendPermissionResponse(data, agent.PermissionAllow)
			} else {
				errs <- proc.DenyPermissionWithMessage(data, "rewrite it")
			}
		}()
	}
	start.Done()

	var accepted int
	for range answers {
		err := <-errs
		switch {
		case err == nil:
			accepted++
		case !errors.Is(err, ErrRequestNotPending):
			t.Errorf("a later answer failed with %v, want %v", err, ErrRequestNotPending)
		}
	}
	if accepted != 1 {
		t.Errorf("answers accepted = %d, want 1", accepted)
	}
	if got := sess.answers.Load(); got != 1 {
		t.Errorf("answers delivered to the CLI = %d, want 1", got)
	}
}

// What became of a prompt nobody answered is Pockode's own record to write: the
// CLI is killed with SIGKILL, so its transcript may not hold even the message
// that raised the question, and a client paging back through history would
// otherwise replay the card as still waiting.
func TestExpiry_RecordsThePromptsThatDiedWithTheProcess(t *testing.T) {
	m, mock, store, proc := startedTurn(t, leaseTestBudgets)
	sess := mock.session(t, "sess-1")

	sess.emit(t, agent.PermissionRequestEvent{RequestID: "req-1", ToolName: "Bash"})
	sess.emit(t, agent.BackgroundWaitEvent{})
	waitUntil(t, "both blockers", func() bool { return len(proc.turnState().Blockers) == 2 })

	m.Close("sess-1")

	waitUntil(t, "the expiry of req-1", func() bool {
		return expiryReasonFor(t, store, "req-1") == agent.ReasonProcessEnded
	})
}

// A background wait is not a card: nobody raised it with the user and nobody was
// going to answer it, so there is nothing to settle and no record to write.
func TestExpiry_SaysNothingAboutABackgroundWait(t *testing.T) {
	m, mock, store, proc := startedTurn(t, leaseTestBudgets)
	sess := mock.session(t, "sess-1")

	sess.emit(t, agent.BackgroundWaitEvent{})
	waitUntil(t, "the park", func() bool { return proc.turnState().WaitingForBackground() })

	m.Close("sess-1")
	waitUntil(t, "the process to end", func() bool { return m.GetProcess("sess-1") == nil })

	for _, record := range historyRecords(t, store, "sess-1") {
		if record.Type() == agent.EventTypeRequestCancelled {
			t.Errorf("wrote a cancellation for a background wait: %+v", record)
		}
	}
}

// A timeout belongs to the prompt it ran out on, not to the process.
//
// The interleave is Codex's ordinary one: the answer lease expires, Pockode
// interrupts, and the CLI answers by withdrawing the outstanding approval
// itself — so nothing expires and nothing consumes the mark. A later prompt
// that dies with the process must still read as `process_ended`; saying it
// timed out would send the user looking for an hour they never waited.
func TestExpiry_ATimeoutDoesNotLeakOntoTheNextPrompt(t *testing.T) {
	m, mock, store, proc := startedTurn(t, leaseTestBudgets)
	sess := mock.session(t, "sess-1")

	sess.emit(t, agent.PermissionRequestEvent{RequestID: "first", ToolName: "Bash"})
	waitUntil(t, "the first prompt", func() bool { return proc.turnState().AwaitingAnswerTo("first") })

	m.reapLeasesAsOf(pastBudget(leaseTestBudgets.Answer))

	// The CLI withdraws it rather than letting it expire: resolved, not expired.
	sess.emit(t, agent.RequestCancelledEvent{RequestID: "first"})
	waitUntil(t, "the withdrawal", func() bool { return !proc.turnState().AwaitingAnswerTo("first") })

	sess.emit(t, agent.PermissionRequestEvent{RequestID: "second", ToolName: "Bash"})
	waitUntil(t, "the second prompt", func() bool { return proc.turnState().AwaitingAnswerTo("second") })

	m.Close("sess-1")

	waitUntil(t, "the second prompt to be settled", func() bool {
		return expiryReasonFor(t, store, "second") != "unrecorded"
	})
	if got := expiryReasonFor(t, store, "second"); got != agent.ReasonProcessEnded {
		t.Errorf("reason = %q, want %q", got, agent.ReasonProcessEnded)
	}
}

// A subscriber is handed the records in the order they were written. An expiry
// announced before the event that caused it would deliver a higher sequence
// number before the one below it, to a client that uses those numbers to page
// and to anchor forks.
func TestExpiry_IsAnnouncedAfterTheEventThatCausedIt(t *testing.T) {
	m, mock, _, proc := startedTurn(t, leaseTestBudgets)
	listener := &messageRecorder{}
	m.SetStreamSink(listener)
	sess := mock.session(t, "sess-1")

	sess.emit(t, agent.PermissionRequestEvent{RequestID: "req-1", ToolName: "Bash"})
	waitUntil(t, "the prompt", func() bool { return proc.turnState().AwaitingAnswerTo("req-1") })

	sess.emit(t, agent.InterruptedEvent{})
	// Waited on through the broadcasts rather than the history: an expiry is
	// written before it is announced, so its record alone says nothing about
	// what the listener has been handed yet.
	var order []agent.EventType
	var seqs []session.HistorySeq
	waitUntil(t, "the expiry to be announced", func() bool {
		order, seqs = nil, nil
		for _, msg := range listener.snapshot() {
			switch msg.Record.Type() {
			case agent.EventTypeInterrupted, agent.EventTypeRequestCancelled:
				order = append(order, msg.Record.Type())
				seqs = append(seqs, msg.Seq)
			}
		}
		return len(order) == 2
	})
	want := []agent.EventType{agent.EventTypeInterrupted, agent.EventTypeRequestCancelled}
	if !slices.Equal(order, want) {
		t.Fatalf("broadcast order = %v, want %v", order, want)
	}
	if seqs[0] >= seqs[1] {
		t.Errorf("sequence numbers went backwards: %v", seqs)
	}
}

// expiryTurns returns the turn each request_cancelled record in history is
// tagged with, by request id.
func expiryTurns(t *testing.T, store session.Store, sessionID string) map[string]session.HistoryTurn {
	t.Helper()
	raws, err := store.GetHistory(context.Background(), sessionID)
	if err != nil {
		t.Fatalf("GetHistory: %v", err)
	}
	turns := make(map[string]session.HistoryTurn)
	for _, raw := range raws {
		rec, err := agent.DecodeRecord(raw)
		if err != nil {
			t.Fatalf("DecodeRecord: %v", err)
		}
		if cancelled, ok := rec.(agent.RequestCancelledRecord); ok {
			turns[cancelled.RequestID] = session.HistoryTurnOf(raw)
		}
	}
	return turns
}

// An expiry is written after whatever caused it, and belongs to a turn only if
// the turn its prompt waited in is still open: not after the turn's ending,
// and not when a new turn's prompt overtook a prompt raised after the last one
// ended.
func TestExpiry_BelongsToNoTurnOnceItsTurnIsOver(t *testing.T) {
	_, mock, store, proc := startedTurn(t, leaseTestBudgets)
	sess := mock.session(t, "sess-1")

	// Raised in the turn, expired by its ending.
	sess.emit(t, agent.PermissionRequestEvent{RequestID: "in-turn", ToolName: "Bash"})
	sess.emit(t, agent.DoneEvent{})
	waitUntil(t, "the turn to end", func() bool { return !proc.turnState().Open })

	// Raised after the turn, expired by the prompt that opens the next.
	sess.emit(t, agent.PermissionRequestEvent{RequestID: "after-turn", ToolName: "Bash"})
	waitUntil(t, "the late prompt", func() bool { return proc.turnState().AwaitingAnswerTo("after-turn") })
	if _, err := proc.SendMessage(agent.Prompt{Text: "next"}, time.Now()); err != nil {
		t.Fatalf("SendMessage: %v", err)
	}

	waitUntil(t, "both expiries", func() bool { return len(expiryTurns(t, store, "sess-1")) == 2 })
	for id, turn := range expiryTurns(t, store, "sess-1") {
		if turn != session.NoTurn {
			t.Errorf("expiry of %s is in %+v, want no turn", id, turn)
		}
	}
}
