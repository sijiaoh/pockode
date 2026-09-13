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

// mockAgent starts sessions that do nothing, so that a process created by
// mistake is visible to the manager rather than failing to start.
//
// It implements no agent.SessionForker, which is how an agent says its sessions
// cannot be forked — the right default for the tests that are not about forking.
type mockAgent struct{}

func (mockAgent) Start(context.Context, agent.StartOptions) (agent.Session, error) {
	return &mockSession{events: make(chan agent.AgentEvent)}, nil
}

type mockSession struct{ events chan agent.AgentEvent }

func (s *mockSession) Events() <-chan agent.AgentEvent { return s.events }
func (s *mockSession) SendMessage(string) error        { return nil }
func (s *mockSession) SendPermissionResponse(agent.PermissionRequestData, agent.PermissionChoice) error {
	return nil
}
func (s *mockSession) SendQuestionResponse(agent.QuestionRequestData, map[string]string) error {
	return nil
}
func (s *mockSession) SendInterrupt() error { return nil }
func (s *mockSession) Close()               { close(s.events) }

func newTestManager(t *testing.T, store session.Store) *process.Manager {
	t.Helper()
	registry := agent.NewRegistry()
	registry.Register(session.AgentTypeClaude, mockAgent{})
	return process.NewManager(registry, t.TempDir(), "", "", store, time.Minute)
}

// TestClient_RequestsNeedingLiveProcess covers what happens to a prompt whose
// process is gone: reaped after an idle timeout, or replayed from history after a
// server restart, with the frontend still showing the card.
//
// Starting a process to receive the answer would send it nowhere — the new
// process never asked anything — and leave that process marked running with no
// turn to end it, which nothing corrects until the reaper collects it hours
// later. Saying so is the only useful answer.
func TestClient_RequestsNeedingLiveProcess(t *testing.T) {
	tests := []struct {
		name string
		call func(*Client) error
		want error
	}{
		{
			name: "permission response",
			call: func(c *Client) error {
				return c.SendPermissionResponse(context.Background(), "sess",
					agent.PermissionRequestData{RequestID: "r1"}, agent.PermissionAllow)
			},
			want: ErrSessionNotRunning,
		},
		{
			name: "question response",
			call: func(c *Client) error {
				return c.SendQuestionResponse(context.Background(), "sess",
					agent.QuestionRequestData{RequestID: "r1"}, map[string]string{"a": "b"})
			},
			want: ErrSessionNotRunning,
		},
		{
			// Nothing to stop is what the user wanted, so it is not an error.
			name: "interrupt",
			call: func(c *Client) error {
				return c.Interrupt(context.Background(), "sess")
			},
			want: nil,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store, err := session.NewFileStore(t.TempDir())
			if err != nil {
				t.Fatalf("NewFileStore: %v", err)
			}
			pm := newTestManager(t, store)
			defer pm.Shutdown()

			if _, err := store.Create(context.Background(), "sess", session.CreateSpec{AgentType: session.AgentTypeClaude, Mode: session.ModeDefault}); err != nil {
				t.Fatalf("Create session: %v", err)
			}

			if err := tt.call(NewClient(store, pm)); !errors.Is(err, tt.want) {
				t.Errorf("error = %v, want %v", err, tt.want)
			}
			if pm.HasProcess("sess") {
				t.Error("expected no process to be started")
			}
		})
	}
}

// TestClient_UnknownSessionStaysNotFound keeps the missing-session case
// distinguishable from the stale-prompt one; the RPC layer maps them differently.
func TestClient_UnknownSessionStaysNotFound(t *testing.T) {
	store, err := session.NewFileStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	pm := newTestManager(t, store)
	defer pm.Shutdown()

	err = NewClient(store, pm).Interrupt(context.Background(), "nope")
	if !errors.Is(err, ErrSessionNotFound) {
		t.Errorf("error = %v, want %v", err, ErrSessionNotFound)
	}
}

// failingAppendStore cannot write history. It hands back a plausible-looking
// sequence number alongside the error on purpose: the number is meaningless, and
// the point of the test below is that nothing passes it on.
type failingAppendStore struct{ session.Store }

func (failingAppendStore) AppendToHistory(context.Context, string, any) (session.HistorySeq, error) {
	return 42, errors.New("history is not writable")
}

// TestClient_MessageWithNoRecordHasNoAddress: a message that could not be
// recorded still reaches the agent — it is worth answering whether or not the
// transcript kept it — but it has no address, and handing one out anyway would
// point a later fork at whatever record eventually takes that number.
func TestClient_MessageWithNoRecordHasNoAddress(t *testing.T) {
	base, err := session.NewFileStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	store := failingAppendStore{base}
	pm := newTestManager(t, store)
	defer pm.Shutdown()

	if _, err := store.Create(context.Background(), "sess", session.CreateSpec{AgentType: session.AgentTypeClaude, Mode: session.ModeDefault}); err != nil {
		t.Fatalf("Create session: %v", err)
	}

	client := NewClient(store, pm)
	broadcastSeq := session.HistorySeq(-1)
	client.SetBroadcaster(func(_ string, _ agent.MessageEvent, seq session.HistorySeq, _ any) {
		broadcastSeq = seq
	})

	seq, err := client.SendMessageExcluding(context.Background(), "sess", "hello", nil)
	if err != nil {
		t.Fatalf("SendMessageExcluding = %v, want the prompt to go through anyway", err)
	}
	if seq.Valid() {
		t.Errorf("seq = %d, want no address for a record that was not written", seq)
	}
	if broadcastSeq.Valid() {
		t.Errorf("broadcast seq = %d, want no address for a record that was not written", broadcastSeq)
	}
}
