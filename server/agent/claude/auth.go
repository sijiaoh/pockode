package claude

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/cliauth"
)

// The auth commands' budgets. `auth status` answered in under a second in every
// measurement (Claude Code 2.1.283), so 15s only has to outlast a contended
// machine. `auth logout` was not timed separately; it gets twice that because a
// sign-out may reach the network to revoke the token, and a sign-out cut short
// leaves the user not knowing whether it happened.
const (
	authStatusTimeout = 15 * time.Second
	authLogoutTimeout = 30 * time.Second
)

// Auth is the cliauth.Provider for Claude Code, driving `claude auth`. Its
// sign-in is in login.go.
type Auth struct {
	log *slog.Logger
	// binary is the executable run; Binary everywhere but in tests, which put a
	// fake claude in its place.
	binary string
	// workDir is where the commands run. Claude reads the project's
	// .claude/settings.json from its working directory, and that file can put an
	// API key or an apiKeyHelper in front of the sign-in — so the status has to
	// be read where the sessions run, or it describes credentials they do not use.
	workDir string
	// linkTimeout and verifyTimeout bound the steps of a sign-in; see login.go.
	linkTimeout, verifyTimeout time.Duration
}

func NewAuth(workDir string) *Auth {
	return &Auth{
		log:           slog.With("cli", Binary),
		binary:        Binary,
		workDir:       workDir,
		linkTimeout:   linkTimeout,
		verifyTimeout: verifyTimeout,
	}
}

func (a *Auth) Binary() string { return a.binary }

func (a *Auth) Status(ctx context.Context) (cliauth.Status, error) {
	ctx, cancel := context.WithTimeout(ctx, authStatusTimeout)
	defer cancel()

	// --json is the default, and asked for anyway: the text form is the one a
	// future version is free to reword.
	res, err := agent.Run(ctx, a.log, a.binary, a.workDir, "auth", "status", "--json")
	if err != nil {
		return cliauth.Status{}, cliauth.TimeoutError(ctx, err, "claude auth status", authStatusTimeout)
	}
	return parseAuthStatus(res)
}

func (a *Auth) Logout(ctx context.Context) (cliauth.Status, error) {
	if err := a.logout(ctx); err != nil {
		return cliauth.Status{}, err
	}
	st, err := a.Status(ctx)
	if err != nil {
		return cliauth.ErrorStatus(err), nil
	}
	return st, nil
}

func (a *Auth) logout(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, authLogoutTimeout)
	defer cancel()

	res, err := agent.Run(ctx, a.log, a.binary, a.workDir, "auth", "logout")
	if err != nil {
		return cliauth.TimeoutError(ctx, err, "claude auth logout", authLogoutTimeout)
	}
	if res.ExitCode != 0 {
		return fmt.Errorf("claude auth logout failed: %s", failureReason(res))
	}
	return nil
}

// authStatus is `claude auth status --json`. The two fields the state is decided
// by are pointers, so an output that lacks them is told apart from one that says
// "false" and "".
type authStatus struct {
	LoggedIn         *bool   `json:"loggedIn"`
	AuthMethod       *string `json:"authMethod"`
	APIProvider      string  `json:"apiProvider"`
	APIKeySource     string  `json:"apiKeySource"`
	Email            string  `json:"email"`
	OrgName          string  `json:"orgName"`
	SubscriptionType string  `json:"subscriptionType"`
}

// Claude's authMethod values, as of Claude Code 2.1.283. A sign-in is claude.ai,
// none, or an api_key that a Console sign-in saved (apiKeySourceLogin); every
// other value, including ones a later version adds, is a credential from
// somewhere else.
const (
	authMethodClaudeAI     = "claude.ai"
	authMethodNone         = "none"
	authMethodAPIKey       = "api_key"
	authMethodAPIKeyHelper = "api_key_helper"
	authMethodOAuthToken   = "oauth_token"
	authMethodThirdParty   = "third_party"
)

// apiKeySourceLogin is the apiKeySource of a key `claude auth login --console`
// created and saved — a sign-in like any other, which `auth logout` clears. The
// CLI's own schema describes it as "an API key created and stored by /login with
// an Anthropic Console account" (Claude Code 2.1.283).
const apiKeySourceLogin = "/login managed key"

// parseAuthStatus reads the answer. The exit status is not what decides it —
// signed out exits 1 and still prints the same JSON — but an exit with no JSON
// behind it is a failure, and its stderr says why.
//
// Which credentials the CLI actually uses is authMethod's to say, not loggedIn's:
// an environment variable outranks the credential file, so a machine with
// ANTHROPIC_API_KEY set reads as api_key even when a subscription is signed in
// too, and it is the key that every session would use.
func parseAuthStatus(res agent.RunResult) (cliauth.Status, error) {
	var st authStatus
	if err := json.Unmarshal([]byte(res.Stdout), &st); err != nil {
		if res.ExitCode != 0 {
			return cliauth.Status{}, fmt.Errorf("claude auth status failed: %s", statusFailureReason(res))
		}
		return cliauth.Status{}, errors.New("claude auth status did not print JSON; this Claude Code version may report its sign-in differently than Pockode expects")
	}
	if st.LoggedIn == nil || st.AuthMethod == nil {
		if res.ExitCode != 0 {
			return cliauth.Status{}, fmt.Errorf("claude auth status failed: %s", statusFailureReason(res))
		}
		return cliauth.Status{}, errors.New("claude auth status did not report loggedIn and authMethod; this Claude Code version may report its sign-in differently than Pockode expects")
	}

	switch method := *st.AuthMethod; method {
	case authMethodClaudeAI:
		// Expired credentials that could not be refreshed come back as
		// claude.ai with loggedIn false: a fresh sign-in is what they need.
		if !*st.LoggedIn {
			return cliauth.Status{State: cliauth.StateSignedOut}, nil
		}
		return signedIn(st), nil
	case authMethodNone:
		return cliauth.Status{State: cliauth.StateSignedOut}, nil
	case authMethodAPIKey:
		if st.APIKeySource == apiKeySourceLogin {
			return signedIn(st), nil
		}
		return cliauth.ExternalStatus(cliauth.External{Kind: cliauth.ExternalAPIKey, Source: st.APIKeySource}), nil
	case authMethodAPIKeyHelper:
		return cliauth.ExternalStatus(cliauth.External{Kind: cliauth.ExternalAPIKeyHelper, Source: st.APIKeySource}), nil
	case authMethodOAuthToken:
		return cliauth.ExternalStatus(cliauth.External{Kind: cliauth.ExternalOAuthToken}), nil
	case authMethodThirdParty:
		return cliauth.ExternalStatus(cliauth.External{Kind: cliauth.ExternalCloudProvider, Provider: st.APIProvider}), nil
	default:
		ext := cliauth.External{Kind: cliauth.ExternalOther, Method: method, Source: st.APIKeySource}
		if st.APIProvider != "firstParty" {
			ext.Provider = st.APIProvider
		}
		return cliauth.ExternalStatus(ext), nil
	}
}

// statusFailureReason is failureReason without the stdout fallback: what `auth
// status` prints on stdout is its JSON, account details included, and a reason
// becomes an error that is logged.
func statusFailureReason(res agent.RunResult) string {
	if line := cliauth.LastLine(res.Stderr); line != "" {
		return line
	}
	return fmt.Sprintf("exit status %d", res.ExitCode)
}

func signedIn(st authStatus) cliauth.Status {
	return cliauth.Status{
		State: cliauth.StateSignedIn,
		Account: &cliauth.Account{
			Email:        st.Email,
			Organization: st.OrgName,
			Plan:         st.SubscriptionType,
		},
	}
}

// failureReason is what a failed auth command said about why: its last stderr
// line ("Logout failed: ..."), falling back to stdout and then to the bare exit
// status.
func failureReason(res agent.RunResult) string {
	if line := cliauth.LastLine(res.Stderr); line != "" {
		return line
	}
	if line := cliauth.LastLine(res.Stdout); line != "" {
		return line
	}
	return fmt.Sprintf("exit status %d", res.ExitCode)
}
