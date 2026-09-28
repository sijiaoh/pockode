package codex

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/pockode/server/cliauth"
)

// The app-server's device-code sign-in, as of codex-cli 0.153.0:
// account/login/start answers at once with a link and a code, and
// account/login/completed arrives once the user has entered the code in a
// browser — or the code has expired.
const (
	methodLoginStart     = "account/login/start"
	methodLoginCompleted = "account/login/completed"
	loginTypeDeviceCode  = "chatgptDeviceCode"
)

// loginDisabledText is in the error account/login/start answers with when the
// config forces API-key sign-in (forced_login_method = "api"): "ChatGPT login
// is disabled. Use API key login instead."
const loginDisabledText = "login is disabled"

// deviceCodeExpiredText is in the error a device code that ran out ends with:
// "device auth timed out after 15 minutes". Not "timed out" alone: a request
// that timed out is a failure to show as it is, not a code to start again for.
const deviceCodeExpiredText = "device auth timed out"

type loginStartResponse struct {
	Type            string `json:"type"`
	LoginID         string `json:"loginId"`
	VerificationURL string `json:"verificationUrl"`
	UserCode        string `json:"userCode"`
}

type loginCompletedNotification struct {
	LoginID *string `json:"loginId"`
	// Success is a pointer so that a completion without it is told apart from
	// a failure.
	Success *bool   `json:"success"`
	Error   *string `json:"error"`

	// unreadable is set for a completion Pockode could not read. It is still
	// delivered: dropping it would leave the sign-in waiting out its deadline
	// for an end that already came.
	unreadable bool
}

func (c *authClient) deliverLoginCompleted(params json.RawMessage) {
	var n loginCompletedNotification
	if err := json.Unmarshal(params, &n); err != nil || n.Success == nil {
		n = loginCompletedNotification{unreadable: true}
	}
	select {
	case c.loginCompleted <- n:
	default:
	}
}

// AccountKinds is nil: Codex signs in to a ChatGPT account only.
func (a *Auth) AccountKinds() []cliauth.AccountKind { return nil }

// Login runs a device-code sign-in on an app-server of its own, which stays up
// until the sign-in ends: the sign-in lives in that process. The status read
// afterwards is asked of it too, as Logout's is — its cache is the one the
// sign-in has just updated.
//
// Only the start is bounded here (authTimeout, like any other account call);
// the wait for the user is ctx's, whose deadline the Service sets.
func (a *Auth) Login(ctx context.Context, _ cliauth.LoginOptions, flow cliauth.LoginFlow) (cliauth.Status, error) {
	startCtx, cancel := context.WithTimeout(ctx, authTimeout)
	defer cancel()

	c, err := startAuthClient(ctx, startCtx, a.log, a.binary, a.workDir)
	if err != nil {
		return cliauth.Status{}, cliauth.TimeoutError(startCtx, err, "starting the codex app-server", authTimeout)
	}
	defer c.close()

	result, err := c.call(startCtx, methodLoginStart, map[string]any{"type": loginTypeDeviceCode})
	if err != nil {
		return cliauth.Status{}, loginStartError(startCtx, err)
	}
	var resp loginStartResponse
	if err := json.Unmarshal(result, &resp); err != nil || resp.Type != loginTypeDeviceCode || resp.LoginID == "" || resp.VerificationURL == "" || resp.UserCode == "" {
		return cliauth.Status{}, flowBroken(methodLoginStart + " did not answer with a device code")
	}
	cancel()
	flow.Prompt(cliauth.Prompt{URL: resp.VerificationURL, UserCode: resp.UserCode})

	var done loginCompletedNotification
	for {
		select {
		case done = <-c.loginCompleted:
		case <-c.readDone:
			// An app-server that announced the end and then exited has
			// answered; only one that exited without doing so has not.
			select {
			case done = <-c.loginCompleted:
			default:
				return cliauth.Status{}, c.exitError(methodLoginCompleted)
			}
		case <-ctx.Done():
			return cliauth.Status{}, ctx.Err()
		}
		// Only one sign-in runs on this app-server, so a completion without an
		// id can only be this one's.
		if done.unreadable || done.LoginID == nil || *done.LoginID == resp.LoginID {
			break
		}
	}
	if done.unreadable {
		return cliauth.Status{}, flowBroken(methodLoginCompleted + " arrived in a shape Pockode cannot read")
	}
	if !*done.Success {
		return cliauth.Status{}, loginCompletedError(done)
	}

	readCtx, cancelRead := context.WithTimeout(ctx, authTimeout)
	defer cancelRead()
	st, err := a.read(readCtx, c)
	if err != nil {
		return cliauth.ErrorStatus(err), nil
	}
	return st, nil
}

func loginStartError(ctx context.Context, err error) error {
	var callErr *accountCallError
	if errors.As(err, &callErr) {
		switch {
		case callErr.rpc.Code == methodNotFound:
			return flowBroken(callErr.Error())
		case strings.Contains(strings.ToLower(callErr.rpc.Message), loginDisabledText):
			return &cliauth.LoginError{Reason: cliauth.FailureExternal, Detail: callErr.rpc.Message}
		}
	}
	return cliauth.TimeoutError(ctx, err, "codex "+methodLoginStart, authTimeout)
}

// loginCompletedError reads a sign-in that ended without success. Its error is
// Codex's own text, and the only failure it words distinctly is the code
// expiring; anything else — device-code authorization being off for the
// account included — is shown as Codex put it.
func loginCompletedError(n loginCompletedNotification) error {
	msg := ""
	if n.Error != nil {
		msg = *n.Error
	}
	switch {
	case strings.Contains(msg, deviceCodeExpiredText):
		return &cliauth.LoginError{Reason: cliauth.FailureExpired, Detail: msg}
	case msg == "":
		return &cliauth.LoginError{Reason: cliauth.FailureDeviceAuth, Detail: "codex reported that the sign-in did not complete"}
	default:
		return &cliauth.LoginError{Reason: cliauth.FailureDeviceAuth, Detail: msg}
	}
}

func flowBroken(detail string) error {
	return &cliauth.LoginError{Reason: cliauth.FailureFlowBroken, Detail: detail + "; this Codex version may sign in differently than Pockode expects"}
}
