package cliauth

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/pockode/server/agent"
	"github.com/pockode/server/session"
)

// LoginTimeout is how long a sign-in may wait for the user before Pockode ends
// it. Codex's device code lasts 15 minutes (its own text and its timeout error
// both say so, codex-cli 0.153.0). Claude's link has no published lifetime and
// `claude auth login` never gives up by itself, but a code pasted 15 minutes in
// still worked (measured, Claude Code 2.1.283), so both get the same deadline
// and the countdown the user sees is never longer than what the CLI allows.
const LoginTimeout = 15 * time.Minute

// LoginPhase is where a sign-in stands.
type LoginPhase string

const (
	// LoginStarting is the CLI being started; there is nothing to show yet.
	LoginStarting LoginPhase = "starting"
	// LoginWaiting is waiting for the user: the link (and Codex's code) is set.
	LoginWaiting LoginPhase = "waiting"
	// LoginVerifying is a code the user pasted being checked by the CLI.
	LoginVerifying LoginPhase = "verifying"
	LoginSucceeded LoginPhase = "succeeded"
	LoginFailed    LoginPhase = "failed"
	// LoginCanceled is a sign-in the user cancelled. It is not a failure: there
	// is nothing to explain.
	LoginCanceled LoginPhase = "canceled"
)

// Ended reports whether nothing more will happen to a sign-in in this phase.
func (p LoginPhase) Ended() bool {
	return p == LoginSucceeded || p == LoginFailed || p == LoginCanceled
}

// AccountKind is which kind of account a sign-in is for, for a CLI that offers
// more than one.
type AccountKind string

const (
	// AccountClaudeAI is a Claude subscription (`claude auth login`).
	AccountClaudeAI AccountKind = "claude_ai"
	// AccountConsole is an API-billed Anthropic Console account
	// (`claude auth login --console`).
	AccountConsole AccountKind = "console"
)

// FailureReason says why a sign-in failed, in the words the client picks its
// copy by. Detail beside it carries the CLI's own message.
type FailureReason string

const (
	// FailureCodeRejected is a pasted code the CLI tried and the server refused
	// — wrong, already used, or from another sign-in. The CLI has ended, so the
	// only way on is a new sign-in with a new link. A code that is merely
	// malformed does not end the sign-in; see Login.CodeMalformed.
	FailureCodeRejected FailureReason = "code_rejected"
	// FailureExpired is a sign-in that ran past LoginTimeout or the CLI's own
	// lifetime for its code: to the user both mean "too slow, start again".
	FailureExpired FailureReason = "expired"
	// FailureDeviceAuth is Codex reporting that its device-code sign-in did not
	// succeed. Device-code authorization being switched off for the ChatGPT
	// account is one known cause, which Codex does not report distinctly, so
	// the client shows Detail with a hint to check that setting.
	FailureDeviceAuth FailureReason = "device_auth_failed"
	// FailureNotInstalled is a CLI this server cannot find.
	FailureNotInstalled FailureReason = "not_installed"
	// FailureExternal is a CLI whose credentials are managed outside Pockode, so
	// a sign-in here would not change what it uses, or is refused outright.
	// External says where they come from when the CLI reported it.
	FailureExternal FailureReason = "external"
	// FailureFlowBroken is a CLI that did not behave the way Pockode drives it:
	// no link, a link to the wrong place, no answer to a code, a response of
	// the wrong shape. This usually follows a CLI update. It exists so that a
	// flow that stopped matching ends with a reason instead of hanging.
	FailureFlowBroken FailureReason = "flow_broken"
	// FailureOther is any other failure; Detail says what.
	FailureOther FailureReason = "other"
)

// Login is one sign-in, as a client sees it.
//
// URL and UserCode are secrets while the sign-in runs — whoever has them can
// finish it into their own account — so they go to clients and nowhere else:
// never into a log. They are cleared once the sign-in ends.
type Login struct {
	ID    string            `json:"id"`
	Agent session.AgentType `json:"agent"`
	// Revision grows with every change to any sign-in. A command's reply and a
	// change notification travel separately and can arrive in either order, so
	// a client keeps whichever copy of a sign-in has the higher revision.
	// Only copies with the same ID compare: revisions restart with the server.
	Revision int64 `json:"revision"`
	// AccountKind is set for a CLI that offers more than one kind.
	AccountKind AccountKind `json:"account_kind,omitempty"`
	Phase       LoginPhase  `json:"phase"`
	// Version is the CLI's version, when it could be read: a flow that broke is
	// explained by it.
	Version   string    `json:"version,omitempty"`
	StartedAt time.Time `json:"started_at"`
	// ExpiresAt is when Pockode ends the sign-in if the user has not finished.
	ExpiresAt time.Time `json:"expires_at"`
	// URL is the page the user signs in on, from LoginWaiting on.
	URL string `json:"url,omitempty"`
	// UserCode is the code the user types into that page (Codex).
	UserCode string `json:"user_code,omitempty"`
	// CodeMalformed says the last pasted code was refused before it was tried —
	// part of it missing — and the CLI is waiting for another in the same
	// sign-in (Claude, back in LoginWaiting).
	CodeMalformed bool `json:"code_malformed,omitempty"`
	// Failure is set with LoginFailed.
	Failure *LoginFailure `json:"failure,omitempty"`
	// Account is set with LoginSucceeded when the CLI, read right after, said
	// whom it was signed in as. It is what happened, not what is: the record is
	// kept after it ends and a terminal can sign out meanwhile, so the status
	// card reads cli_auth.status, never this.
	Account *Account `json:"account,omitempty"`
}

type LoginFailure struct {
	Reason FailureReason `json:"reason"`
	// Detail is the CLI's own message, with the link and codes removed.
	Detail   string    `json:"detail,omitempty"`
	External *External `json:"external,omitempty"`
}

// LoginOptions is what a Provider's sign-in is asked to do.
type LoginOptions struct {
	// AccountKind is one of the Provider's AccountKinds, or empty when it has
	// none.
	AccountKind AccountKind
}

// Prompt is what a Provider's sign-in hands the user.
type Prompt struct {
	URL      string
	UserCode string
	// TakesCode says the sign-in finishes with a code the user pastes back
	// (Claude) rather than on its own once the browser is done (Codex).
	TakesCode bool
}

// LoginFlow is the running sign-in as a Provider's Login sees it.
type LoginFlow interface {
	// Prompt moves the sign-in from LoginStarting to LoginWaiting with what the
	// user needs. It is said once; a second is ignored.
	Prompt(Prompt)
	// Codes delivers each code the user submits. The sign-in is LoginVerifying
	// from the moment one is sent until the Provider says otherwise — by
	// CodeMalformed, or by returning.
	Codes() <-chan string
	// CodeMalformed puts the sign-in back in LoginWaiting after the CLI refused
	// the last code for its form and waits for another.
	CodeMalformed()
}

// LoginError is a sign-in failure a Provider has classified.
type LoginError struct {
	Reason   FailureReason
	Detail   string
	External *External
}

func (e *LoginError) Error() string {
	if e.Detail == "" {
		return string(e.Reason)
	}
	return string(e.Reason) + ": " + e.Detail
}

// Errors from the sign-in commands, each the client's mistake or a state it
// can act on.
var (
	ErrLoginNotFound      = errors.New("no such sign-in; it may have been replaced by a newer one")
	ErrInvalidAccountKind = errors.New("this CLI does not offer that account kind")
	ErrCodeNotExpected    = errors.New("this sign-in is not waiting for a code")
	ErrInvalidCode        = errors.New("the code must be a single, non-empty line")
	ErrShuttingDown       = errors.New("the server is shutting down")
)

// Why a sign-in's context ended, when Pockode ended it rather than the CLI.
var (
	errLoginCanceled = errors.New("sign-in canceled")
	errLoginExpired  = errors.New("sign-in expired")
)

// LoginListener hears that a CLI's sign-in changed. It is called outside any
// lock and must not block; Login reads what it now is.
type LoginListener interface {
	OnLoginChange(agentType session.AgentType)
}

// loginFlow is a Login and what drives it. Its login and secrets are guarded by
// Service.loginsMu.
type loginFlow struct {
	login     Login
	takesCode bool
	// secrets is every value that must not leave in a Failure's Detail: a link
	// with parameters and each of them (state, challenge), the user code, every
	// pasted code. A link without any is a public page and is left readable.
	secrets []string

	codes  chan string
	cancel context.CancelCauseFunc
	done   chan struct{}
}

func (f *loginFlow) addSecrets(values ...string) {
	for _, v := range values {
		// A short value would redact ordinary words out of the message; the
		// secrets that matter (state, challenge, codes) are all long.
		if len(v) >= 6 {
			f.secrets = append(f.secrets, v)
		}
	}
}

func (f *loginFlow) redact(s string) string {
	for _, secret := range f.secrets {
		s = strings.ReplaceAll(s, secret, "[redacted]")
	}
	return s
}

// flowHandle is the LoginFlow a Provider is given.
type flowHandle struct {
	s    *Service
	flow *loginFlow
}

func (h flowHandle) Prompt(p Prompt) {
	h.s.updateLogin(h.flow, func(f *loginFlow) {
		// Only from starting: back in waiting while a code is being checked,
		// the sign-in would take a second code the Provider is not reading.
		if f.login.Phase != LoginStarting {
			return
		}
		f.login.Phase = LoginWaiting
		f.login.URL = p.URL
		f.login.UserCode = p.UserCode
		f.takesCode = p.TakesCode
		f.addSecrets(p.UserCode)
		u, err := url.Parse(p.URL)
		if err != nil || u.RawQuery != "" {
			f.addSecrets(p.URL)
		}
		if err == nil {
			for _, values := range u.Query() {
				f.addSecrets(values...)
			}
		}
	})
}

func (h flowHandle) Codes() <-chan string { return h.flow.codes }

func (h flowHandle) CodeMalformed() {
	h.s.updateLogin(h.flow, func(f *loginFlow) {
		if f.login.Phase != LoginVerifying {
			return
		}
		f.login.Phase = LoginWaiting
		f.login.CodeMalformed = true
	})
}

// StartLogin starts a sign-in for agentType, or returns the one already running
// for it: two screens that both read "signed out" and both press start land in
// the same sign-in rather than racing two CLIs over one credential file.
//
// The sign-in belongs to the server, not to the request or the connection that
// started it: it goes on through a reload or a dropped socket, until it ends,
// the user cancels it, or LoginTimeout passes.
func (s *Service) StartLogin(agentType session.AgentType, kind AccountKind) (Login, error) {
	p, ok := s.providers[agentType]
	if !ok {
		return Login{}, fmt.Errorf("%w: %q", ErrUnknownAgent, agentType)
	}
	kinds := p.AccountKinds()
	switch {
	case kind == "" && len(kinds) > 0:
		kind = kinds[0]
	case kind != "" && !containsKind(kinds, kind):
		return Login{}, fmt.Errorf("%w: %s has no %q", ErrInvalidAccountKind, agentType, kind)
	}

	s.loginsMu.Lock()
	if s.closed {
		s.loginsMu.Unlock()
		return Login{}, ErrShuttingDown
	}
	if f := s.logins[agentType]; f != nil && !f.login.Phase.Ended() {
		login := f.login
		s.loginsMu.Unlock()
		return login, nil
	}

	now := time.Now()
	f := &loginFlow{
		login: Login{
			ID:          uuid.NewString(),
			Agent:       agentType,
			AccountKind: kind,
			Phase:       LoginStarting,
			StartedAt:   now,
			ExpiresAt:   now.Add(s.loginTimeout),
		},
		codes: make(chan string, 1),
		done:  make(chan struct{}),
	}
	s.loginRevision++
	f.login.Revision = s.loginRevision
	ctx, cancel := context.WithCancelCause(s.baseCtx)
	ctx, cancelDeadline := context.WithDeadlineCause(ctx, f.login.ExpiresAt, errLoginExpired)
	f.cancel = cancel
	s.logins[agentType] = f
	// Wakes a status read or a sign-out waiting for this CLI's lock, which is
	// now the sign-in's.
	close(s.loginStarted[agentType])
	s.loginStarted[agentType] = make(chan struct{})
	login := f.login
	// Under loginsMu, which Close takes before waiting: a sign-in that got past
	// the closed check is always one Close waits for.
	s.loginWG.Go(func() {
		defer cancel(nil)
		defer cancelDeadline()
		s.runLogin(ctx, f, p, LoginOptions{AccountKind: kind})
	})
	s.loginsMu.Unlock()

	s.log.Info("AI CLI sign-in started", "cli", agentType, "loginId", login.ID, "accountKind", kind)
	s.notifyLogin(agentType)
	return login, nil
}

func containsKind(kinds []AccountKind, kind AccountKind) bool {
	for _, k := range kinds {
		if k == kind {
			return true
		}
	}
	return false
}

func (s *Service) runLogin(ctx context.Context, f *loginFlow, p Provider, opts LoginOptions) {
	defer close(f.done)
	agentType := f.login.Agent

	var version string
	var versions sync.WaitGroup
	versions.Go(func() {
		if version = s.version(ctx, p.Binary()); version != "" {
			s.updateLogin(f, func(f *loginFlow) { f.login.Version = version })
		}
	})

	// Held for the whole sign-in: the CLI writes the credential file at a moment
	// only it knows, and a sign-out or a refreshing status read must not race
	// that write. Status reads meanwhile answer StateSigningIn without asking.
	var st Status
	unlock, err := s.lockForLogin(ctx, agentType)
	if err == nil {
		st, err = p.Login(ctx, opts, flowHandle{s: s, flow: f})
		unlock()
	}
	// Why ctx ended, as of the Provider returning: a cancel landing after that
	// must not rewrite how the sign-in actually ended.
	ended, cause := ctx.Err(), context.Cause(ctx)
	versions.Wait()

	s.updateLogin(f, func(f *loginFlow) {
		f.login.URL, f.login.UserCode, f.login.CodeMalformed = "", "", false
		if err == nil {
			f.login.Phase = LoginSucceeded
			f.login.Account = st.Account
			return
		}
		if ended != nil && errors.Is(cause, errLoginCanceled) {
			f.login.Phase = LoginCanceled
			return
		}
		f.login.Phase = LoginFailed
		f.login.Failure = classifyLoginError(ended, cause, err)
		f.login.Failure.Detail = f.redact(f.login.Failure.Detail)
	})

	s.loginsMu.Lock()
	login := f.login
	s.loginsMu.Unlock()
	switch login.Phase {
	case LoginFailed:
		s.log.Warn("AI CLI sign-in failed", "cli", agentType, "loginId", login.ID, "reason", login.Failure.Reason, "detail", login.Failure.Detail)
	default:
		s.log.Info("AI CLI sign-in ended", "cli", agentType, "loginId", login.ID, "phase", login.Phase)
	}
}

// classifyLoginError turns what ended a sign-in that did not succeed into the
// reason the client shows. Pockode's own reasons for ending it come first: the
// CLI's error then is only the consequence of its process being killed.
func classifyLoginError(ended, cause, err error) *LoginFailure {
	if ended != nil {
		switch {
		case errors.Is(cause, errLoginExpired):
			return &LoginFailure{Reason: FailureExpired}
		case errors.Is(cause, ErrShuttingDown):
			return &LoginFailure{Reason: FailureOther, Detail: ErrShuttingDown.Error()}
		}
	}
	var loginErr *LoginError
	if errors.As(err, &loginErr) {
		return &LoginFailure{Reason: loginErr.Reason, Detail: loginErr.Detail, External: loginErr.External}
	}
	var notFound *agent.BinaryNotFoundError
	if errors.As(err, &notFound) {
		return &LoginFailure{Reason: FailureNotInstalled, Detail: err.Error()}
	}
	return &LoginFailure{Reason: FailureOther, Detail: err.Error()}
}

// SubmitCode hands the CLI a code the user pasted and moves the sign-in to
// LoginVerifying. What the CLI makes of it arrives as a change to the sign-in.
func (s *Service) SubmitCode(loginID, code string) (Login, error) {
	code = strings.TrimSpace(code)
	if code == "" || strings.ContainsAny(code, "\r\n") {
		return Login{}, ErrInvalidCode
	}

	s.loginsMu.Lock()
	f := s.findLogin(loginID)
	if f == nil {
		s.loginsMu.Unlock()
		return Login{}, ErrLoginNotFound
	}
	if !f.takesCode || f.login.Phase != LoginWaiting {
		s.loginsMu.Unlock()
		return Login{}, ErrCodeNotExpected
	}
	// The phase admits one code at a time and the Provider takes it off before
	// it can put the sign-in back in LoginWaiting, so there is room; if there
	// ever is not, the code is refused rather than blocking under loginsMu.
	select {
	case f.codes <- code:
	default:
		s.loginsMu.Unlock()
		return Login{}, ErrCodeNotExpected
	}
	f.login.Phase = LoginVerifying
	f.login.CodeMalformed = false
	f.addSecrets(code)
	f.addSecrets(strings.Split(code, "#")...)
	s.loginRevision++
	f.login.Revision = s.loginRevision
	login := f.login
	s.loginsMu.Unlock()

	s.notifyLogin(login.Agent)
	return login, nil
}

// cancelWait bounds how long CancelLogin waits for the CLI to be gone, so the
// sign-in it returns already says it was cancelled. Ending one is killing a
// process tree, which takes milliseconds; a sign-in that takes longer is
// returned as it is and its end arrives as a change.
const cancelWait = 10 * time.Second

// CancelLogin ends a running sign-in and its CLI. A sign-in that has already
// ended is returned as it is.
func (s *Service) CancelLogin(loginID string) (Login, error) {
	s.loginsMu.Lock()
	f := s.findLogin(loginID)
	s.loginsMu.Unlock()
	if f == nil {
		return Login{}, ErrLoginNotFound
	}

	f.cancel(errLoginCanceled)
	select {
	case <-f.done:
	case <-time.After(cancelWait):
	}

	s.loginsMu.Lock()
	defer s.loginsMu.Unlock()
	return f.login, nil
}

// Login is agentType's latest sign-in — the running one, or the last to end —
// or nil when it has had none since the server started. The last one is kept
// so that a client that was away when it ended still learns how.
func (s *Service) Login(agentType session.AgentType) (*Login, error) {
	if _, ok := s.providers[agentType]; !ok {
		return nil, fmt.Errorf("%w: %q", ErrUnknownAgent, agentType)
	}
	s.loginsMu.Lock()
	defer s.loginsMu.Unlock()
	f := s.logins[agentType]
	if f == nil {
		return nil, nil
	}
	login := f.login
	return &login, nil
}

// AddLoginListener registers l to hear about every sign-in change. Not safe
// for use once sign-ins may be running.
func (s *Service) AddLoginListener(l LoginListener) {
	s.loginListeners = append(s.loginListeners, l)
}

// Close ends every running sign-in, status read and sign-out, and waits for
// their CLIs to be gone.
func (s *Service) Close() {
	s.loginsMu.Lock()
	s.closed = true
	s.loginsMu.Unlock()
	s.cancelBase(ErrShuttingDown)
	s.loginWG.Wait()
	s.commandWG.Wait()
}

// findLogin is the sign-in with id among each CLI's latest. Callers hold
// loginsMu.
func (s *Service) findLogin(id string) *loginFlow {
	for _, f := range s.logins {
		if f.login.ID == id {
			return f
		}
	}
	return nil
}

// runningLogin is agentType's sign-in if one is running. Callers hold loginsMu.
func (s *Service) runningLogin(agentType session.AgentType) *loginFlow {
	if f := s.logins[agentType]; f != nil && !f.login.Phase.Ended() {
		return f
	}
	return nil
}

func (s *Service) updateLogin(f *loginFlow, update func(*loginFlow)) {
	s.loginsMu.Lock()
	update(f)
	s.loginRevision++
	f.login.Revision = s.loginRevision
	agentType := f.login.Agent
	s.loginsMu.Unlock()
	s.notifyLogin(agentType)
}

func (s *Service) notifyLogin(agentType session.AgentType) {
	for _, l := range s.loginListeners {
		l.OnLoginChange(agentType)
	}
}
