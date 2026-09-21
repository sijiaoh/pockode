package chat

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/process"
	"github.com/pockode/server/session"
)

// midTurnFixture is one session with a live process, held at whatever the test
// drives its turn to.
type midTurnFixture struct {
	store      session.Store
	client     *Client
	agent      *mockAgent
	pm         *process.Manager
	broadcasts []agent.EventRecord
}

func newMidTurnFixture(t *testing.T) *midTurnFixture {
	t.Helper()

	store, err := session.NewFileStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	pm, ag := newTestManagerWithAgent(t, store)
	t.Cleanup(pm.Shutdown)

	if _, err := store.Create(context.Background(), "sess",
		session.CreateSpec{AgentType: session.AgentTypeClaude, Mode: session.ModeDefault}); err != nil {
		t.Fatalf("Create session: %v", err)
	}

	f := &midTurnFixture{store: store, client: NewClient(store, pm), agent: ag, pm: pm}
	f.client.SetBroadcaster(func(_ string, record agent.EventRecord, _ session.HistorySeq, _ any) {
		f.broadcasts = append(f.broadcasts, record)
	})
	return f
}

// startTurn sends the first message, which is what builds the process, and
// returns the agent session behind it.
func (f *midTurnFixture) startTurn(t *testing.T) *mockSession {
	t.Helper()
	if _, err := f.client.SendMessageExcluding(context.Background(), "sess", "first", nil); err != nil {
		t.Fatalf("SendMessageExcluding: %v", err)
	}
	if phase := f.phase(t); phase != session.PhaseRunning {
		t.Fatalf("setup: phase = %q, want running", phase)
	}
	return f.agent.session(t, 1)
}

func (f *midTurnFixture) phase(t *testing.T) session.TurnPhase {
	t.Helper()
	proc := f.pm.GetProcess("sess")
	if proc == nil {
		t.Fatal("no process for the session")
	}
	return proc.TurnState().Phase
}

// waitForPhase waits for an event the test pushed to have been reduced. Events
// are read on the process's own goroutine, so a phase is not in yet when the
// push returns.
func (f *midTurnFixture) waitForPhase(t *testing.T, want session.TurnPhase) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if f.phase(t) == want {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("timed out waiting for phase %q, still %q", want, f.phase(t))
}

// waitForRecords waits for the transcript to hold at least n records and
// returns the count.
//
// The phase is not a signal that a record has landed: a process applies the turn
// state *before* it appends the record, deliberately, so that anything seeing a
// record sees the state it caused already settled (process.Process.handleEvent).
// That makes the record the signal an event has been processed, and the phase
// the earlier of the two — a test that counted records after waiting on a phase
// would sometimes count one too few, and then see it arrive during the
// assertion it was making about something else.
func (f *midTurnFixture) waitForRecords(t *testing.T, n int) int {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if got := f.historyLen(t); got >= n {
			return got
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("timed out waiting for %d history records, have %d", n, f.historyLen(t))
	return 0
}

func (f *midTurnFixture) historyLen(t *testing.T) int {
	t.Helper()
	records, err := f.store.GetHistory(context.Background(), "sess")
	if err != nil {
		t.Fatalf("GetHistory: %v", err)
	}
	return len(records)
}

// TestClient_MessageDuringARunningTurnGoesThrough is the contract the frontend's
// composer is unlocked against: a turn being worked on takes a further message,
// and that message reaches the CLI, the transcript and the other clients like
// any other. Both CLIs fold it into the running turn, so the turn it lands in is
// still the same one afterwards — nothing here starts or ends a second turn.
func TestClient_MessageDuringARunningTurnGoesThrough(t *testing.T) {
	f := newMidTurnFixture(t)
	sess := f.startTurn(t)

	seq, err := f.client.SendMessageExcluding(context.Background(), "sess", "second", nil)
	if err != nil {
		t.Fatalf("SendMessageExcluding during a running turn = %v, want it delivered", err)
	}
	if !seq.Valid() {
		t.Errorf("seq = %d, want the record's address", seq)
	}

	if got := sess.sentPrompts(); len(got) != 2 || got[1] != "second" {
		t.Errorf("prompts handed to the agent = %q, want both messages", got)
	}
	if got := f.historyLen(t); got != 2 {
		t.Errorf("history records = %d, want both messages", got)
	}
	if len(f.broadcasts) != 2 {
		t.Errorf("broadcasts = %d, want one per message", len(f.broadcasts))
	}
	if phase := f.phase(t); phase != session.PhaseRunning {
		t.Errorf("phase = %q, want the turn still running", phase)
	}
}

// TestClient_MessageDuringABackgroundWaitGoesThrough is the other half of the
// composer's contract, and the half the refusal is easiest to over-apply to: a
// background wait is a blocked turn too, but nobody is being asked anything, the
// CLI is between turns and reads what arrives, so the message overtakes the wait
// instead of vanishing into it. Widening the refusal to "blocked" would take the
// composer away for the one wait that can last hours.
func TestClient_MessageDuringABackgroundWaitGoesThrough(t *testing.T) {
	f := newMidTurnFixture(t)
	sess := f.startTurn(t)

	sess.events <- agent.BackgroundWaitEvent{}
	f.waitForPhase(t, session.PhaseBlocked)

	if _, err := f.client.SendMessageExcluding(context.Background(), "sess", "second", nil); err != nil {
		t.Fatalf("SendMessageExcluding during a background wait = %v, want it delivered", err)
	}
	if got := sess.sentPrompts(); len(got) != 2 || got[1] != "second" {
		t.Errorf("prompts handed to the agent = %q, want both messages", got)
	}
	// The wait it overtook is gone with it, and the turn it was part of is not:
	// this is what leaves the user a turn that is running again rather than one
	// still claiming to be parked (session.ReduceTurn, SignalPrompt).
	if phase := f.phase(t); phase != session.PhaseRunning {
		t.Errorf("phase = %q, want the wait overtaken and the turn running", phase)
	}
}

// TestClient_MessageRefusedWhileARequestIsOnScreen covers the one state a
// message cannot be delivered in. A CLI holding a permission request open is
// inside the tool call waiting for that decision and reads nothing else, so
// accepting the message would take the card off the user's screen
// (session.ReduceTurn's SignalPrompt) and leave a turn open that nothing could
// then end.
//
// Every sender is refused, not just the user's: an auto-continuation nudged into
// a session that is holding a request open is nudged into the same silence.
func TestClient_MessageRefusedWhileARequestIsOnScreen(t *testing.T) {
	tests := []struct {
		name  string
		raise agent.AgentEvent
	}{
		{"permission request", agent.PermissionRequestEvent{RequestID: "req-1", ToolName: "Bash"}},
	}

	senders := []struct {
		name string
		send func(*Client) error
	}{
		{"user message", func(c *Client) error {
			_, err := c.SendMessageExcluding(context.Background(), "sess", "never mind", nil)
			return err
		}},
		{"system message", func(c *Client) error {
			return c.SendSystemMessage(context.Background(), "sess", "carry on", "auto_continue", nil)
		}},
	}

	for _, tt := range tests {
		for _, sender := range senders {
			t.Run(tt.name+"/"+sender.name, func(t *testing.T) {
				f := newMidTurnFixture(t)
				sess := f.startTurn(t)

				sess.events <- tt.raise
				f.waitForPhase(t, session.PhaseBlocked)

				// The message that started the turn, and the request itself.
				before := f.waitForRecords(t, 2)
				broadcasts := len(f.broadcasts)

				if err := sender.send(f.client); !errors.Is(err, ErrTurnAwaitingAnswer) {
					t.Fatalf("error = %v, want ErrTurnAwaitingAnswer", err)
				}

				// A refused message leaves no trace: not in the transcript the
				// next reload reads, not on the other clients' screens, and not
				// on the CLI's stdin.
				if got := f.historyLen(t); got != before {
					t.Errorf("history records = %d, want the refused message not recorded (%d)", got, before)
				}
				if len(f.broadcasts) != broadcasts {
					t.Errorf("broadcasts = %d, want the refused message not broadcast (%d)", len(f.broadcasts), broadcasts)
				}
				if got := sess.sentPrompts(); len(got) != 1 {
					t.Errorf("prompts handed to the agent = %q, want only the one that started the turn", got)
				}
				if phase := f.phase(t); phase != session.PhaseBlocked {
					t.Errorf("phase = %q, want the request still on screen", phase)
				}
			})
		}
	}
}

// TestClient_MessageAfterTheAnswerGoesThrough: the refusal is about the request
// on screen and nothing else, so answering it opens the session back up. Without
// this the refusal could be a session that can never be talked to again.
func TestClient_MessageAfterTheAnswerGoesThrough(t *testing.T) {
	f := newMidTurnFixture(t)
	sess := f.startTurn(t)

	sess.events <- agent.PermissionRequestEvent{RequestID: "req-1", ToolName: "Bash"}
	f.waitForPhase(t, session.PhaseBlocked)

	if err := f.client.SendPermissionResponse(context.Background(), "sess",
		agent.PermissionRequestData{RequestID: "req-1"}, agent.PermissionAllow); err != nil {
		t.Fatalf("SendPermissionResponse: %v", err)
	}
	f.waitForPhase(t, session.PhaseRunning)

	if _, err := f.client.SendMessageExcluding(context.Background(), "sess", "second", nil); err != nil {
		t.Fatalf("SendMessageExcluding after the answer = %v, want it delivered", err)
	}
	if got := sess.sentPrompts(); len(got) != 2 {
		t.Errorf("prompts handed to the agent = %q, want both messages", got)
	}
}
