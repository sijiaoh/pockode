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

			if _, err := store.Create(context.Background(), "sess", session.AgentTypeClaude, session.ModeDefault); err != nil {
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
