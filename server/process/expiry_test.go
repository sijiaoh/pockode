package process

import (
	"errors"
	"slices"
	"sync"
	"testing"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/session"
)

// An answer reaches the process that raised the prompt or it reaches nothing.
// Forwarding it anyway would record a turn as started for an answer the CLI has
// no idea what to do with, leaving a session that claims to be running with
// nothing coming to end it.
func TestAnswer_RefusedWhenTheSessionIsNoLongerWaiting(t *testing.T) {
	for _, tt := range []struct {
		name string
		send func(*Process) error
	}{
		{"question", func(p *Process) error {
			return p.SendQuestionResponse(agent.QuestionRequestData{RequestID: "gone"}, map[string]string{"q": "a"})
		}},
		{"permission", func(p *Process) error {
			return p.SendPermissionResponse(agent.PermissionRequestData{RequestID: "gone"}, agent.PermissionAllow)
		}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			_, mock, _, proc := startedTurn(t, leaseTestBudgets)
			sess := mock.session(t, "sess-1")

			if err := tt.send(proc); !errors.Is(err, ErrRequestNotPending) {
				t.Errorf("err = %v, want %v", err, ErrRequestNotPending)
			}
			if got := sess.answers.Load(); got != 0 {
				t.Errorf("the answer reached the CLI %d times, want 0", got)
			}
			if turn := proc.turnState(); !turn.Open {
				t.Error("a refused answer must leave the turn as it was")
			}
		})
	}
}

// The other half of the same rule: while the prompt is listed, the answer goes
// through and clears it.
func TestAnswer_AcceptedWhileThePromptIsLive(t *testing.T) {
	_, mock, _, proc := startedTurn(t, leaseTestBudgets)
	sess := mock.session(t, "sess-1")

	sess.emit(t, agent.AskUserQuestionEvent{RequestID: "req-1"})
	waitUntil(t, "the prompt", func() bool { return proc.turnState().AwaitingAnswerTo("req-1") })

	if err := proc.SendQuestionResponse(agent.QuestionRequestData{RequestID: "req-1"}, map[string]string{"q": "a"}); err != nil {
		t.Fatalf("answering a live prompt failed: %v", err)
	}
	if got := sess.answers.Load(); got != 1 {
		t.Errorf("answers delivered = %d, want 1", got)
	}
	if proc.turnState().AwaitingAnswerTo("req-1") {
		t.Error("the answered prompt is still listed as a blocker")
	}
}

// What became of a prompt nobody answered is Pockode's own record to write: the
// CLI is killed with SIGKILL, so its transcript may not hold even the message
// that raised the question, and a client paging back through history would
// otherwise replay the card as still waiting.
func TestExpiry_RecordsThePromptsThatDiedWithTheProcess(t *testing.T) {
	m, mock, store, proc := startedTurn(t, leaseTestBudgets)
	sess := mock.session(t, "sess-1")

	sess.emit(t, agent.AskUserQuestionEvent{RequestID: "req-1"})
	sess.emit(t, agent.PermissionRequestEvent{RequestID: "req-2", ToolName: "Bash"})
	waitUntil(t, "both prompts", func() bool { return len(proc.turnState().Blockers) == 2 })

	m.Close("sess-1")

	for _, requestID := range []string{"req-1", "req-2"} {
		waitUntil(t, "the expiry of "+requestID, func() bool {
			return expiryReasonFor(t, store, requestID) == agent.ReasonProcessEnded
		})
	}
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
		if record.Type == agent.EventTypeRequestCancelled {
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

	sess.emit(t, agent.AskUserQuestionEvent{RequestID: "first"})
	waitUntil(t, "the first prompt", func() bool { return proc.turnState().AwaitingAnswerTo("first") })

	m.reapLeasesAsOf(pastBudget(leaseTestBudgets.Answer))

	// The CLI withdraws it rather than letting it expire: resolved, not expired.
	sess.emit(t, agent.RequestCancelledEvent{RequestID: "first"})
	waitUntil(t, "the withdrawal", func() bool { return !proc.turnState().AwaitingAnswerTo("first") })

	sess.emit(t, agent.AskUserQuestionEvent{RequestID: "second"})
	waitUntil(t, "the second prompt", func() bool { return proc.turnState().AwaitingAnswerTo("second") })

	m.Close("sess-1")

	waitUntil(t, "the second prompt to be settled", func() bool {
		return expiryReasonFor(t, store, "second") != "unrecorded"
	})
	if got := expiryReasonFor(t, store, "second"); got != agent.ReasonProcessEnded {
		t.Errorf("reason = %q, want %q", got, agent.ReasonProcessEnded)
	}
}

// recordingListener keeps the broadcast order, which is the thing under test
// below: it has to match the order history holds.
type recordingListener struct {
	mu   sync.Mutex
	msgs []ChatMessage
}

func (r *recordingListener) OnChatMessage(msg ChatMessage) {
	r.mu.Lock()
	r.msgs = append(r.msgs, msg)
	r.mu.Unlock()
}

func (r *recordingListener) snapshot() []ChatMessage {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]ChatMessage(nil), r.msgs...)
}

// A subscriber is handed the records in the order they were written. An expiry
// announced before the event that caused it would deliver a higher sequence
// number before the one below it, to a client that uses those numbers to page
// and to anchor forks.
func TestExpiry_IsAnnouncedAfterTheEventThatCausedIt(t *testing.T) {
	m, mock, store, proc := startedTurn(t, leaseTestBudgets)
	listener := &recordingListener{}
	m.SetMessageListener(listener)
	sess := mock.session(t, "sess-1")

	sess.emit(t, agent.AskUserQuestionEvent{RequestID: "req-1"})
	waitUntil(t, "the prompt", func() bool { return proc.turnState().AwaitingAnswerTo("req-1") })

	sess.emit(t, agent.InterruptedEvent{})
	waitUntil(t, "the expiry", func() bool {
		return expiryReasonFor(t, store, "req-1") != "unrecorded"
	})

	var order []agent.EventType
	var seqs []session.HistorySeq
	for _, msg := range listener.snapshot() {
		switch msg.Event.(type) {
		case agent.InterruptedEvent, agent.RequestCancelledEvent:
			order = append(order, msg.Event.EventType())
			seqs = append(seqs, msg.Seq)
		}
	}
	want := []agent.EventType{agent.EventTypeInterrupted, agent.EventTypeRequestCancelled}
	if !slices.Equal(order, want) {
		t.Fatalf("broadcast order = %v, want %v", order, want)
	}
	if seqs[0] >= seqs[1] {
		t.Errorf("sequence numbers went backwards: %v", seqs)
	}
}
