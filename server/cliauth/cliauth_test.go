package cliauth_test

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/cliauth"
	"github.com/pockode/server/cliauth/cliauthtest"
	"github.com/pockode/server/session"
)

func TestStatuses(t *testing.T) {
	s := cliauth.NewService(slog.Default())
	s.Register(session.AgentTypeClaude, cliauthtest.New(cliauthtest.State{Status: cliauth.Status{State: cliauth.StateSignedIn}}))
	s.Register(session.AgentTypeCodex, cliauthtest.New(cliauthtest.State{StatusErr: &agent.BinaryNotFoundError{Name: "codex"}}))
	s.Register("gemini", cliauthtest.New(cliauthtest.State{StatusErr: errors.New("account/read did not finish within 45s")}))

	got, err := s.Statuses(context.Background(), "")
	if err != nil {
		t.Fatalf("Statuses: %v", err)
	}

	want := []struct {
		agent session.AgentType
		state cliauth.State
		error string
	}{
		{session.AgentTypeClaude, cliauth.StateSignedIn, ""},
		{session.AgentTypeCodex, cliauth.StateNotInstalled, "codex CLI not found"},
		// Never folded into signed out.
		{"gemini", cliauth.StateUnavailable, "did not finish within 45s"},
	}
	if len(got) != len(want) {
		t.Fatalf("got %d statuses, want %d", len(got), len(want))
	}
	for i, w := range want {
		if got[i].Agent != w.agent || got[i].State != w.state || !strings.Contains(got[i].Error, w.error) {
			t.Errorf("status %d: got %+v, want %s %s containing %q", i, got[i], w.agent, w.state, w.error)
		}
	}
}

func TestStatuses_OneAgent(t *testing.T) {
	s := cliauth.NewService(slog.Default())
	s.Register(session.AgentTypeClaude, cliauthtest.New(cliauthtest.State{Status: cliauth.Status{State: cliauth.StateSignedIn}}))
	s.Register(session.AgentTypeCodex, cliauthtest.New(cliauthtest.State{Status: cliauth.Status{State: cliauth.StateSignedOut}}))

	got, err := s.Statuses(context.Background(), session.AgentTypeCodex)
	if err != nil {
		t.Fatalf("Statuses: %v", err)
	}
	if len(got) != 1 || got[0].Agent != session.AgentTypeCodex || got[0].State != cliauth.StateSignedOut {
		t.Errorf("got %+v, want codex alone", got)
	}

	if _, err := s.Statuses(context.Background(), "gemini"); !errors.Is(err, cliauth.ErrUnknownAgent) {
		t.Errorf("unknown agent: got %v, want ErrUnknownAgent", err)
	}
}

func TestLogout(t *testing.T) {
	t.Run("answers with the status read afterwards", func(t *testing.T) {
		s := cliauth.NewService(slog.Default())
		s.Register(session.AgentTypeClaude, cliauthtest.New(cliauthtest.State{Status: cliauth.Status{State: cliauth.StateSignedIn}}))

		got, err := s.Logout(context.Background(), session.AgentTypeClaude)
		if err != nil {
			t.Fatalf("Logout: %v", err)
		}
		if got.Agent != session.AgentTypeClaude || got.State != cliauth.StateSignedOut {
			t.Errorf("got %+v, want claude signed out", got)
		}
	})

	// The sign-out happened; only the read after it failed. That is a status to
	// show, not a failed sign-out to retry.
	t.Run("a failed read afterwards is a status, not an error", func(t *testing.T) {
		after := cliauth.ErrorStatus(errors.New("codex account/read did not finish within 45s"))
		s := cliauth.NewService(slog.Default())
		s.Register(session.AgentTypeCodex, cliauthtest.New(cliauthtest.State{Status: cliauth.Status{State: cliauth.StateSignedIn}, AfterLogout: &after}))

		got, err := s.Logout(context.Background(), session.AgentTypeCodex)
		if err != nil {
			t.Fatalf("Logout: %v", err)
		}
		if got.Agent != session.AgentTypeCodex || got.State != cliauth.StateUnavailable {
			t.Errorf("got %+v, want codex unavailable", got)
		}
	})

	t.Run("a refusal is the error, as the provider worded it", func(t *testing.T) {
		refusal := errors.New("claude auth logout failed: Logout failed: network down")
		s := cliauth.NewService(slog.Default())
		s.Register(session.AgentTypeClaude, cliauthtest.New(cliauthtest.State{Status: cliauth.Status{State: cliauth.StateSignedIn}, LogoutErr: refusal}))

		if _, err := s.Logout(context.Background(), session.AgentTypeClaude); !errors.Is(err, refusal) {
			t.Errorf("got %v, want %v", err, refusal)
		}
	})

	t.Run("unknown agent", func(t *testing.T) {
		s := cliauth.NewService(slog.Default())
		if _, err := s.Logout(context.Background(), "gemini"); !errors.Is(err, cliauth.ErrUnknownAgent) {
			t.Errorf("got %v, want ErrUnknownAgent", err)
		}
	})
}

// blockingProvider holds its status read until released, standing in for a CLI
// command that is still running.
type blockingProvider struct {
	*cliauthtest.Provider
	entered chan struct{}
	release chan struct{}
}

func (b blockingProvider) Status(ctx context.Context) (cliauth.Status, error) {
	b.entered <- struct{}{}
	<-b.release
	return b.Provider.Status(ctx)
}

// One command per CLI at a time — a status read can rewrite the credentials a
// sign-out is removing — and a caller whose client has gone stops waiting.
func TestService_OneCommandPerCLI(t *testing.T) {
	p := blockingProvider{
		Provider: cliauthtest.New(cliauthtest.State{Status: cliauth.Status{State: cliauth.StateSignedIn}}),
		entered:  make(chan struct{}),
		release:  make(chan struct{}),
	}
	s := cliauth.NewService(slog.Default())
	s.Register(session.AgentTypeClaude, p)

	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		if _, err := s.Statuses(context.Background(), session.AgentTypeClaude); err != nil {
			t.Errorf("Statuses: %v", err)
		}
	}()
	<-p.entered

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if _, err := s.Logout(ctx, session.AgentTypeClaude); !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("sign-out during a read: got %v, want it to wait and then give up", err)
	}

	close(p.release)
	<-readDone
	if _, err := s.Logout(context.Background(), session.AgentTypeClaude); err != nil {
		t.Errorf("sign-out after the read: %v", err)
	}
}

// ctxProvider's status read runs until its context ends, standing in for a CLI
// command that is still running when the server stops.
type ctxProvider struct {
	*cliauthtest.Provider
	entered chan struct{}
	exited  chan struct{}
}

func (c ctxProvider) Status(ctx context.Context) (cliauth.Status, error) {
	close(c.entered)
	<-ctx.Done()
	close(c.exited)
	return cliauth.Status{}, ctx.Err()
}

// A status read or sign-out rides on the connection's context, which a server
// shutting down does not end; Close has to, and wait, or its CLI outlives the
// server.
func TestClose_EndsRunningCommands(t *testing.T) {
	p := ctxProvider{
		Provider: cliauthtest.New(cliauthtest.State{}),
		entered:  make(chan struct{}),
		exited:   make(chan struct{}),
	}
	s := cliauth.NewService(slog.Default())
	s.Register(session.AgentTypeClaude, p)

	go func() { _, _ = s.Statuses(context.Background(), session.AgentTypeClaude) }()
	<-p.entered

	s.Close()
	select {
	case <-p.exited:
	default:
		t.Fatal("Close returned while the status read was still running")
	}

	if _, err := s.Statuses(context.Background(), session.AgentTypeClaude); !errors.Is(err, cliauth.ErrShuttingDown) {
		t.Errorf("status after Close: got %v, want ErrShuttingDown", err)
	}
	if _, err := s.Logout(context.Background(), session.AgentTypeClaude); !errors.Is(err, cliauth.ErrShuttingDown) {
		t.Errorf("sign-out after Close: got %v, want ErrShuttingDown", err)
	}
}
