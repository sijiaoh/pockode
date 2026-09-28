// Package cliauth answers whether each AI CLI is signed in on this machine,
// signs it in, and signs it out.
//
// What a CLI is signed in as belongs to the CLI, not to Pockode: the credentials
// sit in the CLI's own files, shared by every process of the OS user — other
// projects, other cluster nodes, a terminal. So nothing here is cached or pushed.
// Every read asks the CLI again, because most of the ways the answer changes
// (a login in a terminal, a token expiring, another node signing out) happen
// where no Pockode process could see them. See docs/code/cli-auth.md.
//
// What each CLI says and how it is read lives beside the rest of that CLI's
// integration (agent/claude, agent/codex), as a Provider; this package holds
// what the two share.
package cliauth

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/session"
)

// State is where a CLI stands, as far as signing in from Pockode goes.
type State string

const (
	// StateSignedIn is a CLI signed in to an account Pockode can sign out of.
	StateSignedIn State = "signed_in"
	// StateSignedOut is a CLI that needs a sign-in before it can run a turn.
	// Expired credentials that could not be refreshed read as this too.
	StateSignedOut State = "signed_out"
	// StateExternal is a CLI whose credentials come from somewhere Pockode
	// neither created nor can remove — an environment variable, a cloud
	// provider, a config file. Signing in or out from Pockode would not change
	// what the CLI uses, so External says where they come from instead.
	StateExternal State = "external"
	// StateNotInstalled is a CLI this server cannot find.
	StateNotInstalled State = "not_installed"
	// StateSigningIn is a CLI with a sign-in running; LoginID names it. Its
	// credentials are not read meanwhile: the sign-in may be writing them.
	StateSigningIn State = "signing_in"
	// StateUnavailable is a status that could not be read. It is never folded
	// into StateSignedOut: guessing the benign state would send the user into a
	// sign-in that cannot fix whatever is actually wrong.
	StateUnavailable State = "unavailable"
)

// Status is one CLI's answer.
type Status struct {
	Agent session.AgentType `json:"agent"`
	State State             `json:"state"`
	// Version is the CLI's version when it could be read. It is here for the day
	// a CLI update changes what Pockode reads: it is the first thing anyone asks.
	Version string `json:"version,omitempty"`
	// Account is set with StateSignedIn, holding what the CLI reports.
	Account *Account `json:"account,omitempty"`
	// External is set with StateExternal.
	External *External `json:"external,omitempty"`
	// Error is why, with StateUnavailable and StateNotInstalled.
	Error string `json:"error,omitempty"`
	// LoginID is the running sign-in, with StateSigningIn.
	LoginID string `json:"login_id,omitempty"`
}

// Account is what a signed-in CLI reports about whom it is signed in as. Every
// field is optional: a CLI reports what it knows.
type Account struct {
	Email        string `json:"email,omitempty"`
	Organization string `json:"organization,omitempty"`
	// Plan is the subscription as the CLI names it ("max", "plus", ...).
	Plan string `json:"plan,omitempty"`
}

// ExternalKind says what kind of credential a CLI is using instead of a
// sign-in, in Pockode's words rather than either CLI's, so a client does not
// have to know each CLI's vocabulary.
type ExternalKind string

const (
	// ExternalAPIKey is an API key — from the environment (Source names the
	// variable) or stored by the CLI itself.
	ExternalAPIKey ExternalKind = "api_key"
	// ExternalAPIKeyHelper is a command configured to print a key.
	ExternalAPIKeyHelper ExternalKind = "api_key_helper"
	// ExternalOAuthToken is a token handed to the CLI directly, such as
	// CLAUDE_CODE_OAUTH_TOKEN.
	ExternalOAuthToken ExternalKind = "oauth_token"
	// ExternalCloudProvider is a cloud platform's own credentials; Provider
	// names the platform.
	ExternalCloudProvider ExternalKind = "cloud_provider"
	// ExternalNoSignInNeeded is a CLI configured for a model provider that does
	// not use the vendor's sign-in at all.
	ExternalNoSignInNeeded ExternalKind = "no_sign_in_needed"
	// ExternalOther is anything a CLI reports that is none of the above; Method
	// carries the CLI's own word for it.
	ExternalOther ExternalKind = "other"
)

// External is where the credentials of a StateExternal CLI come from. It names
// sources and never carries a value.
type External struct {
	Kind ExternalKind `json:"kind"`
	// Source is where the credential is read from, when the CLI says: an
	// environment variable name such as ANTHROPIC_API_KEY, or "apiKeyHelper".
	Source string `json:"source,omitempty"`
	// Provider is the platform for ExternalCloudProvider ("bedrock", "vertex",
	// "foundry"), and whatever platform the CLI names alongside ExternalOther.
	Provider string `json:"provider,omitempty"`
	// Method is the CLI's own name for the credential, for ExternalOther.
	Method string `json:"method,omitempty"`
}

// Provider is one CLI's side of signing in and out.
//
// Status and Logout bound their own time: only the CLI's integration knows how
// long its commands take. Login is bounded by the Service, which owns the
// sign-in's deadline and its cancellation, and ends it through ctx. A status
// that could not be read is ErrorStatus's to describe, so a Provider only ever
// builds the states it actually read.
type Provider interface {
	// Binary is the executable the CLI is run as.
	Binary() string
	// Status reads the CLI's sign-in state. Agent and Version are filled in by
	// the Service.
	Status(ctx context.Context) (Status, error)
	// Logout signs the CLI out and returns its status read afterwards — which is
	// not necessarily signed out: credentials from the environment outlive a
	// sign-out. Signing out a CLI that is not signed in succeeds.
	//
	// The error is the sign-out's alone, and is shown to the user as it is, so it
	// has to say what went wrong in words they can act on. A read afterwards that
	// fails is ErrorStatus(err) in the returned status: the sign-out did happen.
	Logout(ctx context.Context) (Status, error)
	// AccountKinds lists the kinds of account a sign-in can be for, the default
	// first; nil for a CLI with one kind.
	AccountKinds() []AccountKind
	// Login runs one sign-in to its end and returns the CLI's status read
	// afterwards — ErrorStatus(err) when that read fails, since the sign-in
	// did happen.
	//
	// It returns once the CLI has finished, or with ctx's error once ctx is
	// done — in both cases with the CLI's process gone, since the Service
	// hands the CLI to the next command as soon as it returns. A failure it
	// can name is a *LoginError; any other error is shown as it is, a
	// *agent.BinaryNotFoundError as the CLI not being installed. The link,
	// codes and anything the CLI prints around them must not reach a log.
	Login(ctx context.Context, opts LoginOptions, flow LoginFlow) (Status, error)
}

// ErrUnknownAgent is a request naming a CLI no Provider is registered for.
var ErrUnknownAgent = errors.New("unknown agent")

// Service is the one place the sign-in state of every CLI is read and changed.
type Service struct {
	log       *slog.Logger
	agents    []session.AgentType // registration order, which is display order
	providers map[session.AgentType]Provider
	// cliLocks holds one lock per CLI, taken around everything that runs one of
	// its auth commands. A sign-out and a sign-in rewrite the same credential
	// file, and so may a status read: Claude refreshes expired credentials when
	// asked for its status. Nothing inside a CLI coordinates two of its own
	// processes doing that, so a read racing a sign-out could write back the
	// credentials it just removed.
	//
	// A channel rather than a sync.Mutex so that waiting for it can be given up
	// on: a caller whose client has gone must not stay queued behind a sign-out.
	//
	// A running sign-in holds its CLI's lock throughout; see runLogin.
	cliLocks map[session.AgentType]chan struct{}

	// loginsMu guards logins, loginStarted, closed and every loginFlow's state.
	loginsMu sync.Mutex
	// logins is each CLI's latest sign-in, running or ended.
	logins map[session.AgentType]*loginFlow
	// loginStarted is closed, and replaced, when a sign-in starts on the CLI:
	// what waits for the CLI's lock has to learn that it is now a sign-in's,
	// held for minutes, rather than wait for it.
	loginStarted   map[session.AgentType]chan struct{}
	loginListeners []LoginListener
	closed         bool
	// baseCtx ends every sign-in, status read and sign-out; Close cancels it.
	baseCtx    context.Context
	cancelBase context.CancelCauseFunc
	loginWG    sync.WaitGroup
	// commandWG counts running status reads and sign-outs. Their contexts are
	// the connection's, and srv.Shutdown does not wait for a hijacked
	// WebSocket, so without it their CLIs could outlive the server.
	commandWG sync.WaitGroup
	// loginRevision is the last Login.Revision handed out.
	loginRevision int64
	// loginTimeout is LoginTimeout everywhere but in tests.
	loginTimeout time.Duration
}

func NewService(log *slog.Logger) *Service {
	baseCtx, cancelBase := context.WithCancelCause(context.Background())
	return &Service{
		log:          log,
		providers:    make(map[session.AgentType]Provider),
		cliLocks:     make(map[session.AgentType]chan struct{}),
		logins:       make(map[session.AgentType]*loginFlow),
		loginStarted: make(map[session.AgentType]chan struct{}),
		baseCtx:      baseCtx,
		cancelBase:   cancelBase,
		loginTimeout: LoginTimeout,
	}
}

// Register adds a CLI. Statuses lists CLIs in the order they were registered.
// Not safe for use once the Service is serving requests.
func (s *Service) Register(agentType session.AgentType, p Provider) {
	if _, ok := s.providers[agentType]; !ok {
		s.agents = append(s.agents, agentType)
		s.cliLocks[agentType] = make(chan struct{}, 1)
		s.loginStarted[agentType] = make(chan struct{})
	}
	s.providers[agentType] = p
}

// Statuses reads every registered CLI at once, or only agentType when it is not
// empty. A CLI whose read failed is in the list as StateUnavailable, and one
// with a sign-in running as StateSigningIn; the only errors are ErrUnknownAgent
// and ErrShuttingDown.
func (s *Service) Statuses(ctx context.Context, agentType session.AgentType) ([]Status, error) {
	agents := s.agents
	if agentType != "" {
		if _, ok := s.providers[agentType]; !ok {
			return nil, fmt.Errorf("%w: %q", ErrUnknownAgent, agentType)
		}
		agents = []session.AgentType{agentType}
	}
	ctx, end, err := s.beginCommand(ctx)
	if err != nil {
		return nil, err
	}
	defer end()

	// Concurrently: the CLIs are unrelated, and one of them (Codex) can take
	// seconds to answer, which the other should not have to wait out.
	statuses := make([]Status, len(agents))
	var wg sync.WaitGroup
	for i, t := range agents {
		wg.Go(func() {
			statuses[i] = s.withVersion(ctx, t, func() Status {
				unlock, loginID, err := s.lockUnlessSigningIn(ctx, t)
				if err != nil {
					return ErrorStatus(err)
				}
				if loginID != "" {
					return Status{State: StateSigningIn, LoginID: loginID}
				}
				defer unlock()

				st, err := s.providers[t].Status(ctx)
				if err != nil {
					s.logReadFailure(ctx, t, err)
					return ErrorStatus(err)
				}
				return st
			})
		})
	}
	wg.Wait()
	return statuses, nil
}

// Logout signs agentType out and returns its status read afterwards, so the
// caller does not have to ask again to find out what the sign-out left behind.
// A failed sign-out is the error; a failed read afterwards is not, and shows up
// as StateUnavailable in the returned status.
func (s *Service) Logout(ctx context.Context, agentType session.AgentType) (Status, error) {
	p, ok := s.providers[agentType]
	if !ok {
		return Status{}, fmt.Errorf("%w: %q", ErrUnknownAgent, agentType)
	}
	ctx, end, err := s.beginCommand(ctx)
	if err != nil {
		return Status{}, err
	}
	defer end()

	unlock, loginID, err := s.lockUnlessSigningIn(ctx, agentType)
	if err != nil {
		return Status{}, err
	}
	if loginID != "" {
		return Status{}, fmt.Errorf("a sign-in to %s is in progress; cancel it before signing out", agentType)
	}
	defer unlock()

	var logoutErr error
	st := s.withVersion(ctx, agentType, func() Status {
		st, err := p.Logout(ctx)
		logoutErr = err
		return st
	})
	if logoutErr != nil {
		s.log.Warn("AI CLI sign-out failed", "cli", agentType, "error", logoutErr)
		return Status{}, logoutErr
	}
	s.log.Info("AI CLI signed out", "cli", agentType)
	if st.State == StateUnavailable {
		s.log.Warn("could not read AI CLI sign-in status after signing out", "cli", agentType, "error", st.Error)
	}
	return st, nil
}

// beginCommand ties a status read or a sign-out to the Service's lifetime as
// well as to ctx, so that Close ends its CLI and waits for it to be gone.
func (s *Service) beginCommand(ctx context.Context) (context.Context, func(), error) {
	s.loginsMu.Lock()
	defer s.loginsMu.Unlock()
	if s.closed {
		return nil, nil, ErrShuttingDown
	}
	s.commandWG.Add(1)
	ctx, cancel := context.WithCancelCause(ctx)
	stop := context.AfterFunc(s.baseCtx, func() { cancel(context.Cause(s.baseCtx)) })
	return ctx, func() {
		stop()
		cancel(nil)
		s.commandWG.Done()
	}, nil
}

// lockWaitTimeout bounds how long a call waits for another command on the same
// CLI to finish. The caller's own context is the connection's and ends only when
// the client goes away, so without it a Codex read queued behind a Codex
// sign-out could take both of their 45s budgets — past the point where the
// client has stopped waiting. 20s on top of the longest budget (45s) keeps a
// reply within the 75s the client gives agent-starting requests; see
// docs/code/cli-auth.md.
const lockWaitTimeout = 20 * time.Second

// lockForLogin takes agentType's lock for a sign-in, waiting until ctx is done.
// lockWaitTimeout is not for it: that bounds a request someone is waiting on,
// and a sign-in has a deadline and a Cancel of its own. Queued behind a slow
// Codex read, it would otherwise fail as "another command was running".
func (s *Service) lockForLogin(ctx context.Context, agentType session.AgentType) (unlock func(), err error) {
	l := s.cliLocks[agentType]
	select {
	case l <- struct{}{}:
		return func() { <-l }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// lockUnlessSigningIn takes agentType's lock, or gives up after
// lockWaitTimeout or when ctx is done, whichever comes first — unless a
// sign-in is running on the CLI, or starts while this waits: that holds the
// lock for minutes, so its id is returned instead, and no lock.
func (s *Service) lockUnlessSigningIn(ctx context.Context, agentType session.AgentType) (unlock func(), loginID string, err error) {
	l := s.cliLocks[agentType]
	timer := time.NewTimer(lockWaitTimeout)
	defer timer.Stop()
	for {
		s.loginsMu.Lock()
		running := s.runningLogin(agentType)
		started := s.loginStarted[agentType]
		if running != nil {
			loginID = running.login.ID
		}
		s.loginsMu.Unlock()
		if loginID != "" {
			return nil, loginID, nil
		}

		select {
		case l <- struct{}{}:
			return func() { <-l }, "", nil
		case <-started:
		case <-timer.C:
			return nil, "", lockTimeoutError(agentType)
		case <-ctx.Done():
			return nil, "", ctx.Err()
		}
	}
}

func lockTimeoutError(agentType session.AgentType) error {
	return fmt.Errorf("another %s sign-in command was still running after %s; try again", agentType, lockWaitTimeout)
}

// withVersion runs read while the CLI's version is asked for alongside it —
// `--version` touches no credentials, so it needs no lock — and stamps both the
// agent and the version on what read returns.
func (s *Service) withVersion(ctx context.Context, agentType session.AgentType, read func() Status) Status {
	var version string
	var versions sync.WaitGroup
	versions.Go(func() { version = s.version(ctx, s.providers[agentType].Binary()) })

	st := read()
	versions.Wait()
	st.Agent = agentType
	st.Version = version
	return st
}

// logReadFailure logs a status that could not be read, unless nobody is waiting
// for it any more: a client that went away is not a failure of the CLI.
func (s *Service) logReadFailure(ctx context.Context, agentType session.AgentType, err error) {
	if errors.Is(ctx.Err(), context.Canceled) {
		return
	}
	var notFound *agent.BinaryNotFoundError
	if errors.As(err, &notFound) {
		return
	}
	s.log.Warn("could not read AI CLI sign-in status", "cli", agentType, "error", err)
}

// ErrorStatus is the status of a CLI whose status read failed with err:
// StateNotInstalled for a CLI that is not there, StateUnavailable otherwise.
func ErrorStatus(err error) Status {
	var notFound *agent.BinaryNotFoundError
	if errors.As(err, &notFound) {
		return Status{State: StateNotInstalled, Error: err.Error()}
	}
	return Status{State: StateUnavailable, Error: err.Error()}
}

// ExternalStatus is the status of a CLI using the credentials ext describes.
func ExternalStatus(ext External) Status {
	return Status{State: StateExternal, External: &ext}
}

// versionTimeout bounds `<cli> --version`, which prints a constant and reaches
// nothing; a CLI that takes longer is one whose version is not worth waiting for.
const versionTimeout = 10 * time.Second

// versionPattern finds the version in what `--version` prints: "2.1.283 (Claude
// Code)" and "codex-cli 0.153.0" as of the versions this was written against.
var versionPattern = regexp.MustCompile(`\d+\.\d+[0-9A-Za-z.+-]*`)

// version is best effort: the version is there to help explain a failure, and
// not knowing it must not become one. Why it is missing goes to the log.
func (s *Service) version(ctx context.Context, binary string) string {
	ctx, cancel := context.WithTimeout(ctx, versionTimeout)
	defer cancel()

	res, err := agent.Run(ctx, s.log, binary, "", "--version")
	if err != nil {
		var notFound *agent.BinaryNotFoundError
		if !errors.As(err, &notFound) && !errors.Is(err, context.Canceled) {
			s.log.Warn("could not read AI CLI version", "cli", binary, "error", err)
		}
		return ""
	}
	if res.ExitCode != 0 {
		s.log.Warn("AI CLI version command failed", "cli", binary, "exitCode", res.ExitCode, "stderr", LastLine(res.Stderr))
		return ""
	}
	return parseVersion(res.Stdout)
}

// parseVersion picks the version number out of what a CLI's `--version`
// printed, or returns "" when there is none.
func parseVersion(out string) string {
	return versionPattern.FindString(out)
}

// LastLine is the last non-blank line of a CLI's output, trimmed. A CLI that
// fails says why on its last line, after whatever progress it printed first,
// which makes this the part worth showing a user.
func LastLine(out string) string {
	lines := strings.Split(strings.TrimSpace(out), "\n")
	return strings.TrimSpace(lines[len(lines)-1])
}

// TimeoutError turns a deadline that ran out into a sentence naming what did not
// finish; any other error is returned as it is. what reads like "claude auth
// status", and budget is the time the provider allows it. A caller's own,
// shorter deadline can be the one that ran out, which is why the budget is
// given as the limit rather than as the time that passed.
func TimeoutError(ctx context.Context, err error, what string, budget time.Duration) error {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return fmt.Errorf("%s did not finish in time (limit %s)", what, budget)
	}
	return err
}
