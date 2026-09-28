package codex

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/pockode/server/cliauth"
)

// testFlow is a cliauth.LoginFlow that records the prompt. Codex takes no
// code, so nothing is ever sent on codes.
type testFlow struct {
	prompts chan cliauth.Prompt
	codes   chan string
}

func newTestFlow() *testFlow {
	return &testFlow{prompts: make(chan cliauth.Prompt, 1), codes: make(chan string)}
}

func (f *testFlow) Prompt(p cliauth.Prompt) { f.prompts <- p }
func (f *testFlow) Codes() <-chan string    { return f.codes }
func (f *testFlow) CodeMalformed()          {}

// runLogin runs a sign-in to its end. The fakes end theirs at once, so the
// deadline only turns a regression into a failure instead of a hang.
func runLogin(t *testing.T, role string) (*testFlow, cliauth.Status, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	flow := newTestFlow()
	st, err := fakeCodexAuth(t, role).Login(ctx, cliauth.LoginOptions{}, flow)
	return flow, st, err
}

func TestLogin_DeviceCode(t *testing.T) {
	flow, st, err := runLogin(t, fakeLoginSucceeds)
	if err != nil {
		t.Fatalf("Login: %v", err)
	}
	select {
	case p := <-flow.prompts:
		if p.URL != "https://auth.openai.com/codex/device" || p.UserCode != fakeUserCode || p.TakesCode {
			t.Errorf("prompt = %+v, want the device page and code, taking no code back", p)
		}
	default:
		t.Error("the user was never shown the code")
	}
	// Read on the app-server that signed in, whose cache the sign-in updated.
	if st.State != cliauth.StateSignedIn || st.Account == nil || st.Account.Email != "ada@example.com" {
		t.Errorf("status after sign-in = %+v, want signed in as ada@example.com", st)
	}
}

func TestLogin_Failures(t *testing.T) {
	tests := []struct {
		name   string
		role   string
		reason cliauth.FailureReason
		detail string
	}{
		// Device-code authorization off for the account is not told apart by
		// Codex; the client adds the hint.
		{"sign-in fails", fakeLoginFails, cliauth.FailureDeviceAuth, "403 Forbidden"},
		{"the code expires", fakeLoginExpires, cliauth.FailureExpired, "timed out"},
		{"sign-in disabled by config", fakeLoginDisabled, cliauth.FailureExternal, "ChatGPT login is disabled"},
		{"no account API", fakeTooOld, cliauth.FailureFlowBroken, "update codex"},
		// Not dropped and waited out until the deadline: the end came.
		{"a completion of the wrong shape", fakeLoginUnreadable, cliauth.FailureFlowBroken, "cannot read"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, _, err := runLogin(t, tt.role)
			var loginErr *cliauth.LoginError
			if !errors.As(err, &loginErr) || loginErr.Reason != tt.reason || !strings.Contains(loginErr.Detail, tt.detail) {
				t.Errorf("got %v, want %s containing %q", err, tt.reason, tt.detail)
			}
		})
	}
}

// Waiting for the user is bounded by ctx alone — the Service's deadline, or
// its cancel — and ending it takes the app-server down.
func TestLogin_EndsWithCtx(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	a := fakeCodexAuth(t, fakeLoginWaits)
	flow := newTestFlow()
	done := make(chan error, 1)
	go func() {
		_, err := a.Login(ctx, cliauth.LoginOptions{}, flow)
		done <- err
	}()

	select {
	case <-flow.prompts:
	case err := <-done:
		t.Fatalf("sign-in ended before its code: %v", err)
	case <-time.After(20 * time.Second):
		t.Fatal("no code")
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Errorf("got %v, want context.Canceled", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("Login did not return after its ctx ended")
	}
}
