package claude

import (
	"encoding/json"
	"log/slog"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/session"
)

// authFailedError is the CLI's own label for a request refused for its
// credentials. Where: the `error` field of a synthetic assistant frame and of a
// system/api_retry frame, as spelled by claude 2.1.283. Matched instead of the
// text beside it, which changes with the cause ("Not logged in · Please run
// /login", "Invalid API key · Fix external API key", "OAuth session expired
// ...") and with the CLI version.
const authFailedError = "authentication_failed"

// authFailedRetryCode labels the warning raised on the first auth-refused retry
// of a turn; see authFailureTracker.retry.
const authFailedRetryCode = "authentication_failed_retry"

func claudeAuthFailure() *agent.AuthFailure {
	return &agent.AuthFailure{Agent: session.AgentTypeClaude}
}

// authFailureTracker remembers, for the turn under way, whether the CLI has said
// it was refused for its credentials. The result frame that ends such a turn
// carries only is_error and a terminal reason shared with every other API
// failure, so the ending cannot be told apart on its own.
//
// Owned by the goroutine reading the CLI's output; not safe for concurrent use.
type authFailureTracker struct {
	failed bool
	warned bool
}

// retry reads a system/api_retry frame. The CLI retries an auth refusal like
// any other API error — ten times over about three minutes for a rejected key,
// measured on 2.1.259 — so the turn's ending can be minutes away. The first
// refused retry of a turn is reported at once, so the user can sign in without
// waiting for the CLI to give up. The turn itself is left alone: a retry after
// a token refresh can still succeed.
func (t *authFailureTracker) retry(log *slog.Logger, line []byte) []agent.AgentEvent {
	var frame struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(line, &frame); err != nil {
		return nil
	}
	// The latest retry's reason is the turn's: a refusal the CLI got past (a
	// token refreshed) before failing for something else does not mark it.
	t.failed = frame.Error == authFailedError
	if !t.failed || t.warned {
		return nil
	}
	t.warned = true
	log.Info("claude was refused for its credentials, retrying")
	return []agent.AgentEvent{agent.WarningEvent{
		Message:     "Claude couldn't authenticate and is retrying",
		Code:        authFailedRetryCode,
		AuthFailure: claudeAuthFailure(),
	}}
}

// notice reads the label of a synthetic assistant frame and says whether it is
// an auth failure — the CLI's own account of one, just ahead of the result.
// It is the last word before the result, so it settles the turn either way.
func (t *authFailureTracker) notice(code string) *agent.AuthFailure {
	t.failed = code == authFailedError
	if !t.failed {
		return nil
	}
	return claudeAuthFailure()
}

// modelReached reads an assistant frame the model wrote: the turn got past
// authentication, so a refusal earlier in it is not what it ends on.
func (t *authFailureTracker) modelReached() {
	t.failed = false
}

// ended closes the turn and reports whether it was refused for its credentials.
func (t *authFailureTracker) ended() *agent.AuthFailure {
	failed := t.failed
	*t = authFailureTracker{}
	if !failed {
		return nil
	}
	return claudeAuthFailure()
}
