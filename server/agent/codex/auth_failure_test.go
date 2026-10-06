package codex

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/session"
)

func TestReadAuthVerdict(t *testing.T) {
	tests := []struct {
		info string
		want authVerdict
	}{
		// What a refused retry carries on codex-cli 0.153.0.
		{`{"responseStreamDisconnected":{"httpStatusCode":401}}`, authRefused},
		{`{"httpConnectionFailed":{"httpStatusCode":401}}`, authRefused},
		// The schema's own name, unused by 0.153.0 but kept for when it is.
		{`"unauthorized"`, authRefused},
		// Past authentication, failing for something else.
		{`{"responseStreamDisconnected":{"httpStatusCode":500}}`, authAccepted},
		{`{"responseStreamDisconnected":{"httpStatusCode":null}}`, authUnknown},
		// What the refused turn itself ends with.
		{`"other"`, authUnknown},
		{``, authUnknown},
		{`null`, authUnknown},
	}
	for _, tt := range tests {
		if got := readAuthVerdict(json.RawMessage(tt.info)); got != tt.want {
			t.Errorf("readAuthVerdict(%s) = %v, want %v", tt.info, got, tt.want)
		}
	}
}

func TestRedactSecrets(t *testing.T) {
	tests := []struct{ in, want string }{
		// As OpenAI words it on codex-cli 0.153.0: masked, but not wholly.
		{
			"unexpected status 401 Unauthorized: Incorrect API key provided: sk-proj-**************************9jkl. You can find your API key at https://platform.openai.com/account/api-keys.",
			"unexpected status 401 Unauthorized: Incorrect API key provided: [redacted]. You can find your API key at https://platform.openai.com/account/api-keys.",
		},
		{"Incorrect API key provided: not-an-sk-shaped-key", "Incorrect API key provided: [redacted]"},
		{"token sk-abc123 leaked.", "token [redacted] leaked."},
		{"Incorrect API key provided: 'xai-abc123'.", "Incorrect API key provided: '[redacted]'."},
		// A provider's JSON body quoted whole.
		{`{"message":"Incorrect API key provided: abc123xyz","type":"x"}`, `{"message":"Incorrect API key provided: [redacted]","type":"x"}`},
		{"Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload", "Authorization: Bearer [redacted]"},
		// Codex's own words when signed out: prose, not a token.
		{"Missing bearer or basic authentication", "Missing bearer or basic authentication"},
	}
	for _, tt := range tests {
		if got := redactSecrets(tt.in); got != tt.want {
			t.Errorf("redactSecrets(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

// The measured sequence (codex-cli 0.153.0, rejected key): refused retries
// carrying the 401, then a final error and a failed turn whose own info says
// only "other". The ending has to be
// marked from what the turn saw, and the early retry marked as it arrives.
func TestAuthFailure_RefusedTurnIsMarked(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()
	sess.adoptTurn("u")

	sess.notify("error", `{"threadId":"t","turnId":"u","willRetry":true,"error":{"message":"Reconnecting... 1/5","additionalDetails":"unexpected status 401 Unauthorized: Incorrect API key provided: sk-secret","codexErrorInfo":{"responseStreamDisconnected":{"httpStatusCode":401}}}}`)
	sess.notify("error", `{"threadId":"t","turnId":"u","willRetry":false,"error":{"message":"unexpected status 401 Unauthorized: Incorrect API key provided: sk-secret","codexErrorInfo":"other"}}`)
	sess.notify("turn/completed", `{"threadId":"t","turn":{"id":"u","items":[],"status":"failed","error":{"message":"unexpected status 401 Unauthorized: Incorrect API key provided: sk-secret","codexErrorInfo":"other"}}}`)

	events := drainEvents(sess.events)
	if len(events) != 2 {
		t.Fatalf("want a warning and an error, got %v", events)
	}
	want := &agent.AuthFailure{Agent: session.AgentTypeCodex}
	warning := events[0].(agent.WarningEvent)
	if warning.AuthFailure == nil || *warning.AuthFailure != *want {
		t.Errorf("retry warning auth = %v, want %v", warning.AuthFailure, want)
	}
	failure := events[1].(agent.ErrorEvent)
	if failure.AuthFailure == nil || *failure.AuthFailure != *want {
		t.Errorf("turn error auth = %v, want %v", failure.AuthFailure, want)
	}
	for _, text := range []string{warning.Message, failure.Error} {
		if strings.Contains(text, "sk-secret") {
			t.Errorf("key leaked into %q", text)
		}
	}

	// The next turn starts clean.
	sess.adoptTurn("v")
	sess.notify("turn/completed", `{"threadId":"t","turn":{"id":"v","items":[],"status":"failed","error":{"message":"boom","codexErrorInfo":"other"}}}`)
	if got := drainEvents(sess.events)[0].(agent.ErrorEvent); got.AuthFailure != nil {
		t.Errorf("a later failure inherited the auth mark: %+v", got)
	}
}

// A refusal the turn got past is not what it ended on.
func TestAuthFailure_LatestWordWins(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()
	sess.adoptTurn("u")

	sess.notify("error", `{"threadId":"t","turnId":"u","willRetry":true,"error":{"message":"Reconnecting... 1/5","codexErrorInfo":{"responseStreamDisconnected":{"httpStatusCode":401}}}}`)
	sess.notify("error", `{"threadId":"t","turnId":"u","willRetry":true,"error":{"message":"Reconnecting... 2/5","codexErrorInfo":{"responseStreamDisconnected":{"httpStatusCode":503}}}}`)
	sess.notify("turn/completed", `{"threadId":"t","turn":{"id":"u","items":[],"status":"failed","error":{"message":"overloaded","codexErrorInfo":"other"}}}`)

	events := drainEvents(sess.events)
	if got := events[len(events)-1].(agent.ErrorEvent); got.AuthFailure != nil {
		t.Errorf("turn marked as an auth failure after getting past it: %+v", got)
	}
}

// A refusal reported for no running turn, or for another one, is not carried
// into the turn that runs next; nor is one from a turn that was interrupted.
func TestAuthFailure_DoesNotCarryOver(t *testing.T) {
	refused := func(turnID string) string {
		return `{"threadId":"t","turnId":"` + turnID + `","willRetry":true,"error":{"message":"Reconnecting... 1/5","codexErrorInfo":{"responseStreamDisconnected":{"httpStatusCode":401}}}}`
	}
	failedTurn := func(turnID string) string {
		return `{"threadId":"t","turn":{"id":"` + turnID + `","items":[],"status":"failed","error":{"message":"boom","codexErrorInfo":"other"}}}`
	}

	t.Run("between turns", func(t *testing.T) {
		sess := newTestSession()
		defer sess.cancel()
		sess.notify("error", refused("old"))
		sess.adoptTurn("u")
		sess.notify("turn/completed", failedTurn("u"))
		assertNoAuthMark(t, drainEvents(sess.events))
	})

	t.Run("for another turn", func(t *testing.T) {
		sess := newTestSession()
		defer sess.cancel()
		sess.adoptTurn("u")
		sess.notify("error", refused("old"))
		sess.notify("turn/completed", failedTurn("u"))
		assertNoAuthMark(t, drainEvents(sess.events))
	})

	t.Run("after an interrupted turn", func(t *testing.T) {
		sess := newTestSession()
		defer sess.cancel()
		sess.adoptTurn("u")
		sess.notify("error", refused("u"))
		sess.notify("turn/completed", `{"threadId":"t","turn":{"id":"u","items":[],"status":"interrupted"}}`)
		sess.adoptTurn("v")
		sess.notify("turn/completed", failedTurn("v"))
		assertNoAuthMark(t, drainEvents(sess.events))
	})
}

// The stream reconnected and the model answered: the refusal was recovered from.
func TestAuthFailure_ModelOutputEndsTheRefusal(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()
	sess.adoptTurn("u")

	sess.notify("error", `{"threadId":"t","turnId":"u","willRetry":true,"error":{"message":"Reconnecting... 1/5","codexErrorInfo":{"responseStreamDisconnected":{"httpStatusCode":401}}}}`)
	sess.notify("item/completed", `{"threadId":"t","turnId":"u","item":{"type":"agentMessage","id":"m","text":"working"}}`)
	sess.notify("turn/completed", `{"threadId":"t","turn":{"id":"u","items":[],"status":"failed","error":{"message":"boom","codexErrorInfo":"other"}}}`)

	assertNoAuthMark(t, drainEvents(sess.events))
}

// Compaction calls the API too and can be refused along with the turn; its
// item proves nothing about credentials.
func TestAuthFailure_NonModelItemsKeepTheRefusal(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()
	sess.adoptTurn("u")

	sess.notify("error", `{"threadId":"t","turnId":"u","willRetry":true,"error":{"message":"Reconnecting... 1/5","codexErrorInfo":{"responseStreamDisconnected":{"httpStatusCode":401}}}}`)
	sess.notify("item/completed", `{"threadId":"t","turnId":"u","item":{"type":"contextCompaction","id":"c"}}`)
	sess.notify("turn/completed", `{"threadId":"t","turn":{"id":"u","items":[],"status":"failed","error":{"message":"boom","codexErrorInfo":"other"}}}`)

	events := drainEvents(sess.events)
	if got := events[len(events)-1].(agent.ErrorEvent); got.AuthFailure == nil {
		t.Errorf("auth mark lost to a compaction item: %+v", got)
	}
}

func assertNoAuthMark(t *testing.T, events []agent.AgentEvent) {
	t.Helper()
	for _, e := range events {
		if e, ok := e.(agent.ErrorEvent); ok && e.AuthFailure != nil {
			t.Errorf("unexpected auth mark on %+v", e)
		}
	}
}

func TestWarningNotification_IsRedacted(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()

	sess.notify("warning", `{"message":"Falling back from WebSockets to HTTPS transport. unexpected status 401 Unauthorized: Incorrect API key provided: sk-proj-secret."}`)

	if got := drainEvents(sess.events)[0].(agent.WarningEvent).Message; strings.Contains(got, "sk-proj-secret") {
		t.Errorf("key leaked into %q", got)
	}
}

// A subagent's thread reaching the model says nothing of this turn's
// credentials: its items are of its own turn.
func TestAuthFailure_SubagentItemsDoNotClearIt(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()
	sess.stateMu.Lock()
	sess.threadID = "t"
	sess.stateMu.Unlock()
	sess.adoptTurn("u")

	sess.notify("error", `{"threadId":"t","turnId":"u","willRetry":true,"error":{"message":"Reconnecting... 1/5","codexErrorInfo":{"responseStreamDisconnected":{"httpStatusCode":401}}}}`)
	sess.notify("item/completed", `{"threadId":"child","turnId":"turn-child","completedAtMs":2,"item":{"type":"agentMessage","id":"msg-1","text":"hello","phase":"final_answer"}}`)
	sess.notify("turn/completed", `{"threadId":"t","turn":{"id":"u","items":[],"status":"failed","error":{"message":"boom","codexErrorInfo":"other"}}}`)

	events := drainEvents(sess.events)
	if got := events[len(events)-1].(agent.ErrorEvent); got.AuthFailure == nil {
		t.Errorf("a subagent's item cleared the turn's auth mark: %+v", got)
	}
}
