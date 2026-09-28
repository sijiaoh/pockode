package cliauth_test

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/cliauth"
	"github.com/pockode/server/cliauth/cliauthtest"
	"github.com/pockode/server/session"
)

func newLoginService(t *testing.T, state cliauthtest.State) *cliauth.Service {
	t.Helper()
	s := cliauth.NewService(slog.Default())
	s.Register(session.AgentTypeClaude, cliauthtest.New(state))
	t.Cleanup(s.Close)
	return s
}

// awaitLogin waits until claude's sign-in satisfies ok, and returns it.
func awaitLogin(t *testing.T, s *cliauth.Service, ok func(cliauth.Login) bool) cliauth.Login {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		login, err := s.Login(session.AgentTypeClaude)
		if err != nil {
			t.Fatalf("Login: %v", err)
		}
		if login != nil && ok(*login) {
			return *login
		}
		if time.Now().After(deadline) {
			t.Fatalf("sign-in never got there; last seen %+v", login)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func inPhase(phase cliauth.LoginPhase) func(cliauth.Login) bool {
	return func(l cliauth.Login) bool { return l.Phase == phase }
}

func startWaiting(t *testing.T, s *cliauth.Service) cliauth.Login {
	t.Helper()
	login, err := s.StartLogin(session.AgentTypeClaude, "")
	if err != nil {
		t.Fatalf("StartLogin: %v", err)
	}
	return awaitLogin(t, s, func(l cliauth.Login) bool { return l.ID == login.ID && l.Phase == cliauth.LoginWaiting })
}

func TestStartLogin(t *testing.T) {
	s := newLoginService(t, cliauthtest.State{})

	login := startWaiting(t, s)
	if login.URL != cliauthtest.DefaultLoginURL {
		t.Errorf("URL = %q, want the provider's link", login.URL)
	}
	if login.AccountKind != cliauth.AccountClaudeAI {
		t.Errorf("AccountKind = %q, want the provider's default", login.AccountKind)
	}
	if got := login.ExpiresAt.Sub(login.StartedAt); got != cliauth.LoginTimeout {
		t.Errorf("expires %s after start, want %s", got, cliauth.LoginTimeout)
	}

	// A second start — another screen, or the same one after a reload — lands
	// in the same sign-in.
	again, err := s.StartLogin(session.AgentTypeClaude, cliauth.AccountConsole)
	if err != nil {
		t.Fatalf("second StartLogin: %v", err)
	}
	if again.ID != login.ID {
		t.Errorf("second start began sign-in %s, want the running %s", again.ID, login.ID)
	}
}

func TestStartLogin_Refusals(t *testing.T) {
	s := newLoginService(t, cliauthtest.State{})

	if _, err := s.StartLogin("gemini", ""); !errors.Is(err, cliauth.ErrUnknownAgent) {
		t.Errorf("unknown agent: got %v", err)
	}
	if _, err := s.StartLogin(session.AgentTypeClaude, "enterprise"); !errors.Is(err, cliauth.ErrInvalidAccountKind) {
		t.Errorf("unknown account kind: got %v", err)
	}

	s.Close()
	if _, err := s.StartLogin(session.AgentTypeClaude, ""); !errors.Is(err, cliauth.ErrShuttingDown) {
		t.Errorf("after Close: got %v", err)
	}
}

func TestSubmitCode(t *testing.T) {
	t.Run("a malformed code keeps the sign-in waiting for another", func(t *testing.T) {
		s := newLoginService(t, cliauthtest.State{})
		login := startWaiting(t, s)

		got, err := s.SubmitCode(login.ID, cliauthtest.CodeMalformed)
		if err != nil {
			t.Fatalf("SubmitCode: %v", err)
		}
		if got.Phase != cliauth.LoginVerifying {
			t.Errorf("phase after submit = %s, want verifying", got.Phase)
		}
		back := awaitLogin(t, s, func(l cliauth.Login) bool { return l.CodeMalformed })
		if back.Phase != cliauth.LoginWaiting || back.URL == "" {
			t.Errorf("got %+v, want waiting with the link still there", back)
		}
		// The reply and the change travel separately; the revision is how a
		// client tells which is newer.
		if back.Revision <= got.Revision {
			t.Errorf("revision went from %d to %d, want it to grow", got.Revision, back.Revision)
		}

		// Trimmed: codes are pasted with a trailing newline more often than not.
		if _, err := s.SubmitCode(login.ID, " code#state\n"); err != nil {
			t.Fatalf("second SubmitCode: %v", err)
		}
		done := awaitLogin(t, s, inPhase(cliauth.LoginSucceeded))
		if done.Account == nil || done.Account.Email != "ada@example.com" {
			t.Errorf("account after sign-in = %+v, want ada@example.com", done.Account)
		}
		if done.URL != "" || done.CodeMalformed {
			t.Errorf("an ended sign-in still carries %+v", done)
		}
	})

	t.Run("a rejected code ends the sign-in, without the secrets in its detail", func(t *testing.T) {
		s := newLoginService(t, cliauthtest.State{})
		login := startWaiting(t, s)

		if _, err := s.SubmitCode(login.ID, cliauthtest.CodeRejected); err != nil {
			t.Fatalf("SubmitCode: %v", err)
		}
		done := awaitLogin(t, s, inPhase(cliauth.LoginFailed))
		if done.Failure.Reason != cliauth.FailureCodeRejected {
			t.Errorf("reason = %s, want code_rejected", done.Failure.Reason)
		}
		if strings.Contains(done.Failure.Detail, "rejected#state") || !strings.Contains(done.Failure.Detail, "status code 400") {
			t.Errorf("detail = %q, want the CLI's message without the code", done.Failure.Detail)
		}
	})

	t.Run("refusals", func(t *testing.T) {
		s := newLoginService(t, cliauthtest.State{})
		login := startWaiting(t, s)

		for _, code := range []string{"", "  ", "one\ntwo"} {
			if _, err := s.SubmitCode(login.ID, code); !errors.Is(err, cliauth.ErrInvalidCode) {
				t.Errorf("code %q: got %v, want ErrInvalidCode", code, err)
			}
		}
		if _, err := s.SubmitCode("no-such-login", "code#state"); !errors.Is(err, cliauth.ErrLoginNotFound) {
			t.Errorf("unknown sign-in: got %v", err)
		}
		if _, err := s.SubmitCode(login.ID, "slow#state"); err != nil {
			t.Fatalf("SubmitCode: %v", err)
		}
		// One code at a time: the first may still be verifying, or already
		// have signed in; neither is waiting for another.
		if _, err := s.SubmitCode(login.ID, "code#state"); !errors.Is(err, cliauth.ErrCodeNotExpected) {
			t.Errorf("second code: got %v, want ErrCodeNotExpected", err)
		}
	})

	t.Run("a sign-in that finishes on its own takes no code", func(t *testing.T) {
		s := newLoginService(t, cliauthtest.State{Login: deviceCodeLogin(nil)})
		login := startWaiting(t, s)

		if _, err := s.SubmitCode(login.ID, "code#state"); !errors.Is(err, cliauth.ErrCodeNotExpected) {
			t.Errorf("got %v, want ErrCodeNotExpected", err)
		}
	})
}

// deviceCodeLogin is a Codex-shaped sign-in: a link and a code, then waiting
// for finish, which says how it ends. A nil finish waits for ctx.
func deviceCodeLogin(finish chan error) cliauthtest.LoginFunc {
	return func(ctx context.Context, _ cliauth.LoginOptions, flow cliauth.LoginFlow) (cliauth.Status, error) {
		flow.Prompt(cliauth.Prompt{URL: "https://example.com/device", UserCode: "ABCD-12345"})
		select {
		case err := <-finish:
			return cliauth.Status{State: cliauth.StateSignedIn}, err
		case <-ctx.Done():
			return cliauth.Status{}, ctx.Err()
		}
	}
}

func TestCancelLogin(t *testing.T) {
	s := newLoginService(t, cliauthtest.State{})
	login := startWaiting(t, s)

	got, err := s.CancelLogin(login.ID)
	if err != nil {
		t.Fatalf("CancelLogin: %v", err)
	}
	if got.Phase != cliauth.LoginCanceled || got.Failure != nil || got.URL != "" {
		t.Errorf("got %+v, want canceled, with no failure and no link", got)
	}

	// Cancelling again is answered with how it ended, not refused: two screens
	// may both press Cancel.
	if again, err := s.CancelLogin(login.ID); err != nil || again.Phase != cliauth.LoginCanceled {
		t.Errorf("second cancel: got %+v, %v", again, err)
	}
	if _, err := s.CancelLogin("no-such-login"); !errors.Is(err, cliauth.ErrLoginNotFound) {
		t.Errorf("unknown sign-in: got %v", err)
	}

	// An ended sign-in is replaced by the next start.
	next, err := s.StartLogin(session.AgentTypeClaude, "")
	if err != nil || next.ID == login.ID {
		t.Errorf("start after cancel: got %+v, %v, want a new sign-in", next, err)
	}
}

func TestLogin_Expires(t *testing.T) {
	s := newLoginService(t, cliauthtest.State{})
	s.SetLoginTimeout(50 * time.Millisecond)

	if _, err := s.StartLogin(session.AgentTypeClaude, ""); err != nil {
		t.Fatalf("StartLogin: %v", err)
	}
	done := awaitLogin(t, s, func(l cliauth.Login) bool { return l.Phase.Ended() })
	if done.Phase != cliauth.LoginFailed || done.Failure.Reason != cliauth.FailureExpired {
		t.Errorf("got %+v, want failed as expired", done)
	}
}

func TestLogin_ProviderFailures(t *testing.T) {
	tests := []struct {
		name   string
		err    error
		reason cliauth.FailureReason
		detail string
	}{
		{"classified by the provider", &cliauth.LoginError{Reason: cliauth.FailureFlowBroken, Detail: "no link"}, cliauth.FailureFlowBroken, "no link"},
		{"not installed", &agent.BinaryNotFoundError{Name: "claude"}, cliauth.FailureNotInstalled, "claude CLI not found"},
		{"anything else", errors.New("claude auth status did not finish in time"), cliauth.FailureOther, "did not finish in time"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := newLoginService(t, cliauthtest.State{Login: func(context.Context, cliauth.LoginOptions, cliauth.LoginFlow) (cliauth.Status, error) {
				return cliauth.Status{}, tt.err
			}})
			if _, err := s.StartLogin(session.AgentTypeClaude, ""); err != nil {
				t.Fatalf("StartLogin: %v", err)
			}
			done := awaitLogin(t, s, func(l cliauth.Login) bool { return l.Phase.Ended() })
			if done.Phase != cliauth.LoginFailed || done.Failure.Reason != tt.reason || !strings.Contains(done.Failure.Detail, tt.detail) {
				t.Errorf("got %+v (%+v), want %s with %q", done, done.Failure, tt.reason, tt.detail)
			}
		})
	}
}

// While a sign-in runs, the CLI's credentials are its to write: a status read
// answers from the sign-in without running the CLI, and a sign-out is refused
// rather than queued behind it for minutes.
func TestLogin_OwnsTheCLI(t *testing.T) {
	s := newLoginService(t, cliauthtest.State{Status: cliauth.Status{State: cliauth.StateSignedOut}})
	login := startWaiting(t, s)

	statuses, err := s.Statuses(context.Background(), session.AgentTypeClaude)
	if err != nil {
		t.Fatalf("Statuses: %v", err)
	}
	if got := statuses[0]; got.State != cliauth.StateSigningIn || got.LoginID != login.ID {
		t.Errorf("status during sign-in = %+v, want signing_in naming %s", got, login.ID)
	}
	if _, err := s.Logout(context.Background(), session.AgentTypeClaude); err == nil || !strings.Contains(err.Error(), "in progress") {
		t.Errorf("sign-out during sign-in: got %v, want a refusal", err)
	}

	if _, err := s.SubmitCode(login.ID, "code#state"); err != nil {
		t.Fatalf("SubmitCode: %v", err)
	}
	awaitLogin(t, s, inPhase(cliauth.LoginSucceeded))
	statuses, err = s.Statuses(context.Background(), session.AgentTypeClaude)
	if err != nil {
		t.Fatalf("Statuses: %v", err)
	}
	if got := statuses[0]; got.State != cliauth.StateSignedIn {
		t.Errorf("status after sign-in = %+v, want signed in", got)
	}
}

// A status read already waiting for the CLI's lock when a sign-in takes it does
// not sit out its 20s wait: it learns of the sign-in and answers from it.
func TestLogin_WakesAReadWaitingForTheCLI(t *testing.T) {
	p := blockingProvider{
		Provider: cliauthtest.New(cliauthtest.State{Status: cliauth.Status{State: cliauth.StateSignedOut}}),
		entered:  make(chan struct{}),
		release:  make(chan struct{}),
	}
	s := cliauth.NewService(slog.Default())
	s.Register(session.AgentTypeClaude, p)
	t.Cleanup(s.Close)

	// The first read holds the lock; the second waits for it.
	go s.Statuses(context.Background(), session.AgentTypeClaude)
	<-p.entered
	second := make(chan cliauth.Status, 1)
	go func() {
		statuses, _ := s.Statuses(context.Background(), session.AgentTypeClaude)
		second <- statuses[0]
	}()
	time.Sleep(20 * time.Millisecond)

	login, err := s.StartLogin(session.AgentTypeClaude, "")
	if err != nil {
		t.Fatalf("StartLogin: %v", err)
	}
	select {
	case got := <-second:
		if got.State != cliauth.StateSigningIn || got.LoginID != login.ID {
			t.Errorf("got %+v, want signing_in", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the waiting read did not learn of the sign-in")
	}
	close(p.release)
}

func TestClose_EndsRunningSignIns(t *testing.T) {
	s := cliauth.NewService(slog.Default())
	s.Register(session.AgentTypeClaude, cliauthtest.New(cliauthtest.State{}))
	startWaiting(t, s)

	s.Close()
	login, err := s.Login(session.AgentTypeClaude)
	if err != nil {
		t.Fatalf("Login: %v", err)
	}
	if login.Phase != cliauth.LoginFailed || !strings.Contains(login.Failure.Detail, "shutting down") {
		t.Errorf("got %+v, want failed because the server stopped", login)
	}
}

type recordingListener struct {
	changesMu sync.Mutex
	changes   []session.AgentType
}

func (l *recordingListener) OnLoginChange(agentType session.AgentType) {
	l.changesMu.Lock()
	defer l.changesMu.Unlock()
	l.changes = append(l.changes, agentType)
}

func (l *recordingListener) count() int {
	l.changesMu.Lock()
	defer l.changesMu.Unlock()
	return len(l.changes)
}

// awaitCount waits until more than n changes have been heard. A change is
// announced just after it is made, so it may trail the state a test saw.
func (l *recordingListener) awaitCount(t *testing.T, n int, what string) int {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		if c := l.count(); c > n {
			return c
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s was not heard", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestLogin_NotifiesEveryChange(t *testing.T) {
	finish := make(chan error)
	s := newLoginService(t, cliauthtest.State{Login: deviceCodeLogin(finish)})
	l := &recordingListener{}
	s.AddLoginListener(l)

	// The test provider's CLI has no version, so the changes are exactly the
	// start, the link and the end.
	startWaiting(t, s)
	l.awaitCount(t, 1, "the link")
	finish <- nil
	awaitLogin(t, s, inPhase(cliauth.LoginSucceeded))
	l.awaitCount(t, 2, "the end of the sign-in")
}
