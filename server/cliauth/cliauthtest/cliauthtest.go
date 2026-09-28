// Package cliauthtest provides a cliauth.Provider for tests that need a CLI's
// sign-in without running one.
package cliauthtest

import (
	"context"
	"sync"

	"github.com/pockode/server/cliauth"
)

// Provider answers with whatever state it is set to. Signing out succeeds unless
// LogoutErr is set, and leaves it signed out unless AfterLogout says otherwise.
// Signing in runs State.Login, or DefaultLogin.
type Provider struct {
	stateMu     sync.Mutex
	status      cliauth.Status
	statusErr   error
	logoutErr   error
	afterLogout *cliauth.Status
	login       LoginFunc
}

// LoginFunc is a scripted sign-in, run as Provider.Login.
type LoginFunc func(ctx context.Context, opts cliauth.LoginOptions, flow cliauth.LoginFlow) (cliauth.Status, error)

// State is what a Provider answers with.
type State struct {
	Status    cliauth.Status
	StatusErr error
	LogoutErr error
	// AfterLogout is the status a successful sign-out leaves; nil is signed out.
	AfterLogout *cliauth.Status
	// Login is how a sign-in goes; nil is DefaultLogin.
	Login LoginFunc
}

func New(state State) *Provider {
	p := &Provider{}
	p.Set(state)
	return p
}

// Set replaces what the Provider answers with. Safe while it is being called.
func (p *Provider) Set(state State) {
	p.stateMu.Lock()
	defer p.stateMu.Unlock()
	p.status, p.statusErr, p.logoutErr, p.afterLogout, p.login = state.Status, state.StatusErr, state.LogoutErr, state.AfterLogout, state.Login
}

// Binary names an executable no machine has, so the version the Service asks
// for alongside is always empty.
func (p *Provider) Binary() string { return "pockode-test-no-such-cli" }

func (p *Provider) Status(context.Context) (cliauth.Status, error) {
	p.stateMu.Lock()
	defer p.stateMu.Unlock()
	return p.status, p.statusErr
}

func (p *Provider) Logout(context.Context) (cliauth.Status, error) {
	p.stateMu.Lock()
	defer p.stateMu.Unlock()
	if p.logoutErr != nil {
		return cliauth.Status{}, p.logoutErr
	}
	p.status, p.statusErr = cliauth.Status{State: cliauth.StateSignedOut}, nil
	if p.afterLogout != nil {
		p.status = *p.afterLogout
	}
	return p.status, nil
}

// AccountKinds offers both of Claude's, so that tests can pick one.
func (p *Provider) AccountKinds() []cliauth.AccountKind {
	return []cliauth.AccountKind{cliauth.AccountClaudeAI, cliauth.AccountConsole}
}

func (p *Provider) Login(ctx context.Context, opts cliauth.LoginOptions, flow cliauth.LoginFlow) (cliauth.Status, error) {
	p.stateMu.Lock()
	login := p.login
	p.stateMu.Unlock()
	if login == nil {
		login = DefaultLogin
	}
	st, err := login(ctx, opts, flow)
	if err == nil {
		p.stateMu.Lock()
		p.status, p.statusErr = st, nil
		p.stateMu.Unlock()
	}
	return st, err
}

// Codes DefaultLogin treats specially; any other code signs in.
const (
	// CodeMalformed is refused for its form, and the sign-in waits for another.
	CodeMalformed = "malformed"
	// CodeRejected ends the sign-in with cliauth.FailureCodeRejected.
	CodeRejected = "rejected#state"
)

// DefaultLoginURL is the link DefaultLogin hands out. Its state parameter is
// a secret like any other, so it must not survive into a failure's detail.
const DefaultLoginURL = "https://example.com/oauth/authorize?code=true&state=secret-state-value"

// DefaultLogin is a Claude-shaped sign-in: a link, then pasted codes until one
// is not malformed. It succeeds signed in as ada@example.com.
func DefaultLogin(ctx context.Context, _ cliauth.LoginOptions, flow cliauth.LoginFlow) (cliauth.Status, error) {
	flow.Prompt(cliauth.Prompt{URL: DefaultLoginURL, TakesCode: true})
	for {
		select {
		case code := <-flow.Codes():
			switch code {
			case CodeMalformed:
				flow.CodeMalformed()
			case CodeRejected:
				return cliauth.Status{}, &cliauth.LoginError{Reason: cliauth.FailureCodeRejected, Detail: "Login failed: Request failed with status code 400 for " + code}
			default:
				return cliauth.Status{State: cliauth.StateSignedIn, Account: &cliauth.Account{Email: "ada@example.com"}}, nil
			}
		case <-ctx.Done():
			return cliauth.Status{}, ctx.Err()
		}
	}
}
