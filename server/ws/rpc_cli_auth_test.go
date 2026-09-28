package ws

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/pockode/server/cliauth"
	"github.com/pockode/server/cliauth/cliauthtest"
	"github.com/pockode/server/rpc"
	"github.com/pockode/server/session"
	"github.com/sourcegraph/jsonrpc2"
)

func TestCLIAuthStatus(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	env.cliAuth.Set(cliauthtest.State{
		Status: cliauth.Status{State: cliauth.StateSignedIn, Account: &cliauth.Account{Email: "ada@example.com", Plan: "max"}},
	})

	for _, params := range []any{nil, rpc.CLIAuthStatusParams{Agent: session.AgentTypeClaude}} {
		resp := env.call("cli_auth.status", params)
		if resp.Error != nil {
			t.Fatalf("params %v: unexpected error: %s", params, resp.Error.Message)
		}
		var result rpc.CLIAuthStatusResult
		if err := json.Unmarshal(resp.Result, &result); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if len(result.Statuses) != 1 {
			t.Fatalf("params %v: got %d statuses, want 1", params, len(result.Statuses))
		}
		got := result.Statuses[0]
		if got.Agent != session.AgentTypeClaude || got.State != cliauth.StateSignedIn || got.Account == nil || got.Account.Email != "ada@example.com" {
			t.Errorf("params %v: got %+v", params, got)
		}
	}
}

func TestCLIAuthStatus_UnknownAgentIsInvalidParams(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	resp := env.call("cli_auth.status", rpc.CLIAuthStatusParams{Agent: "gemini"})
	if resp.Error == nil || resp.Error.Code != jsonrpc2.CodeInvalidParams {
		t.Fatalf("got %+v, want invalid params", resp.Error)
	}
}

// A status that cannot be read is an answer, not a failed request: the client
// draws it as "couldn't read", never as signed out.
func TestCLIAuthStatus_ReadFailureIsUnavailable(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	env.cliAuth.Set(cliauthtest.State{StatusErr: errors.New("claude auth status did not finish within 15s")})

	resp := env.call("cli_auth.status", nil)
	if resp.Error != nil {
		t.Fatalf("unexpected error: %s", resp.Error.Message)
	}
	var result rpc.CLIAuthStatusResult
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	got := result.Statuses[0]
	if got.State != cliauth.StateUnavailable || !strings.Contains(got.Error, "did not finish") {
		t.Errorf("got %+v, want unavailable carrying the reason", got)
	}
}

func TestCLIAuthLogout(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	env.cliAuth.Set(cliauthtest.State{Status: cliauth.Status{State: cliauth.StateSignedIn}})

	resp := env.call("cli_auth.logout", rpc.CLIAuthLogoutParams{Agent: session.AgentTypeClaude})
	if resp.Error != nil {
		t.Fatalf("unexpected error: %s", resp.Error.Message)
	}
	var result rpc.CLIAuthLogoutResult
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if result.Status.Agent != session.AgentTypeClaude || result.Status.State != cliauth.StateSignedOut {
		t.Errorf("got %+v, want claude signed out as read after the sign-out", result.Status)
	}
}

func TestCLIAuthLogout_Errors(t *testing.T) {
	tests := []struct {
		name      string
		params    any
		logoutErr error
		wantCode  int64
		wantMsg   string
	}{
		{"agent missing", rpc.CLIAuthLogoutParams{}, nil, jsonrpc2.CodeInvalidParams, "agent is required"},
		{"unknown agent", rpc.CLIAuthLogoutParams{Agent: "gemini"}, nil, jsonrpc2.CodeInvalidParams, "unknown agent"},
		{"CLI refused", rpc.CLIAuthLogoutParams{Agent: session.AgentTypeClaude}, errors.New("claude auth logout failed: Logout failed: network down"), jsonrpc2.CodeInternalError, "Logout failed: network down"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			env := newTestEnv(t, &mockAgent{})
			env.cliAuth.Set(cliauthtest.State{Status: cliauth.Status{State: cliauth.StateSignedIn}, LogoutErr: tt.logoutErr})

			resp := env.call("cli_auth.logout", tt.params)
			if resp.Error == nil {
				t.Fatal("expected an error")
			}
			if resp.Error.Code != tt.wantCode || !strings.Contains(resp.Error.Message, tt.wantMsg) {
				t.Errorf("got %d %q, want %d containing %q", resp.Error.Code, resp.Error.Message, tt.wantCode, tt.wantMsg)
			}
		})
	}
}

func (e *testEnv) callCLIAuthLogin(method string, params any) cliauth.Login {
	e.t.Helper()
	resp := e.call(method, params)
	if resp.Error != nil {
		e.t.Fatalf("%s: %s", method, resp.Error.Message)
	}
	var result rpc.CLIAuthLoginResult
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		e.t.Fatalf("unmarshal %s: %v", method, err)
	}
	return result.Login
}

// awaitCLILogin reads cli_auth.login.changed until the sign-in satisfies ok.
// Notifications carry the whole sign-in, and changes close together may reach
// the client as one, so a test waits for a state rather than counting them.
func (e *testEnv) awaitCLILogin(subID string, ok func(cliauth.Login) bool) cliauth.Login {
	e.t.Helper()
	for {
		notif := e.awaitNotification("cli_auth.login.changed")
		var params struct {
			ID    string         `json:"id"`
			Login *cliauth.Login `json:"login"`
		}
		if err := json.Unmarshal(notif.Params, &params); err != nil {
			e.t.Fatalf("unmarshal notification: %v", err)
		}
		if params.ID != subID {
			e.t.Fatalf("notification for subscription %q, want %q", params.ID, subID)
		}
		if params.Login != nil && ok(*params.Login) {
			return *params.Login
		}
	}
}

func (e *testEnv) subscribeCLILogin() (string, *cliauth.Login) {
	e.t.Helper()
	id := e.nextSubID()
	resp := e.call("cli_auth.login.subscribe", rpc.CLIAuthLoginSubscribeParams{ID: id, Agent: session.AgentTypeClaude})
	if resp.Error != nil {
		e.t.Fatalf("subscribe: %s", resp.Error.Message)
	}
	var result rpc.CLIAuthLoginSubscribeResult
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		e.t.Fatalf("unmarshal subscribe: %v", err)
	}
	return id, result.Login
}

// The whole of a pasted-code sign-in as a client drives it: start, the link
// pushed, a code, the verdict pushed — and the status read afterwards in it.
func TestCLIAuthLogin_PastedCode(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	t.Cleanup(env.handler.cliAuth.Close)

	subID, before := env.subscribeCLILogin()
	if before != nil {
		t.Fatalf("a sign-in before any was started: %+v", before)
	}

	started := env.callCLIAuthLogin("cli_auth.login.start", rpc.CLIAuthLoginStartParams{Agent: session.AgentTypeClaude})
	waiting := env.awaitCLILogin(subID, func(l cliauth.Login) bool { return l.Phase == cliauth.LoginWaiting })
	if waiting.ID != started.ID || waiting.URL != cliauthtest.DefaultLoginURL {
		t.Errorf("waiting = %+v, want sign-in %s with its link", waiting, started.ID)
	}

	// Signing in owns the CLI: its status says so rather than being read.
	resp := env.call("cli_auth.status", nil)
	var statuses rpc.CLIAuthStatusResult
	if err := json.Unmarshal(resp.Result, &statuses); err != nil {
		t.Fatalf("unmarshal status: %v", err)
	}
	if got := statuses.Statuses[0]; got.State != cliauth.StateSigningIn || got.LoginID != started.ID {
		t.Errorf("status during sign-in = %+v, want signing_in naming it", got)
	}

	verifying := env.callCLIAuthLogin("cli_auth.login.submit_code", rpc.CLIAuthLoginSubmitCodeParams{LoginID: started.ID, Code: "code#state"})
	if verifying.Phase != cliauth.LoginVerifying {
		t.Errorf("reply to submit_code in phase %s, want verifying", verifying.Phase)
	}
	done := env.awaitCLILogin(subID, func(l cliauth.Login) bool { return l.Phase.Ended() })
	if done.Phase != cliauth.LoginSucceeded || done.Account == nil || done.Account.Email != "ada@example.com" || done.URL != "" {
		t.Errorf("ended = %+v, want succeeded with the account and without the link", done)
	}

	// A client that comes back later — a reload, a reconnect — learns how it
	// went from the subscription alone.
	_, after := env.subscribeCLILogin()
	if after == nil || after.ID != started.ID || after.Phase != cliauth.LoginSucceeded {
		t.Errorf("resubscribed to %+v, want the ended sign-in", after)
	}
}

func TestCLIAuthLogin_StartReturnsTheRunningSignIn(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	t.Cleanup(env.handler.cliAuth.Close)

	first := env.callCLIAuthLogin("cli_auth.login.start", rpc.CLIAuthLoginStartParams{Agent: session.AgentTypeClaude})
	second := env.callCLIAuthLogin("cli_auth.login.start", rpc.CLIAuthLoginStartParams{Agent: session.AgentTypeClaude})
	if second.ID != first.ID {
		t.Errorf("second start began %s, want the running %s", second.ID, first.ID)
	}

	canceled := env.callCLIAuthLogin("cli_auth.login.cancel", rpc.CLIAuthLoginCancelParams{LoginID: first.ID})
	if canceled.Phase != cliauth.LoginCanceled {
		t.Errorf("after cancel: phase %s, want canceled", canceled.Phase)
	}
}

func TestCLIAuthLogin_Errors(t *testing.T) {
	tests := []struct {
		name    string
		method  string
		params  any
		wantMsg string
	}{
		{"start without agent", "cli_auth.login.start", rpc.CLIAuthLoginStartParams{}, "agent is required"},
		{"start unknown agent", "cli_auth.login.start", rpc.CLIAuthLoginStartParams{Agent: "gemini"}, "unknown agent"},
		{"start unknown account kind", "cli_auth.login.start", rpc.CLIAuthLoginStartParams{Agent: session.AgentTypeClaude, AccountKind: "enterprise"}, "account kind"},
		{"code without login", "cli_auth.login.submit_code", rpc.CLIAuthLoginSubmitCodeParams{Code: "code#state"}, "login_id is required"},
		{"code for an unknown login", "cli_auth.login.submit_code", rpc.CLIAuthLoginSubmitCodeParams{LoginID: "nope", Code: "code#state"}, "no such sign-in"},
		{"cancel an unknown login", "cli_auth.login.cancel", rpc.CLIAuthLoginCancelParams{LoginID: "nope"}, "no such sign-in"},
		{"subscribe unknown agent", "cli_auth.login.subscribe", rpc.CLIAuthLoginSubscribeParams{ID: "s", Agent: "gemini"}, "unknown agent"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			env := newTestEnv(t, &mockAgent{})
			resp := env.call(tt.method, tt.params)
			if resp.Error == nil {
				t.Fatal("expected an error")
			}
			if resp.Error.Code != jsonrpc2.CodeInvalidParams || !strings.Contains(resp.Error.Message, tt.wantMsg) {
				t.Errorf("got %d %q, want invalid params containing %q", resp.Error.Code, resp.Error.Message, tt.wantMsg)
			}
		})
	}
}
