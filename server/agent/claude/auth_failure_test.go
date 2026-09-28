package claude

import (
	"encoding/json"
	"reflect"
	"sync"
	"testing"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/attachments"
	"github.com/pockode/server/session"
)

// parseTestTurns feeds lines through one set of per-process trackers, the way
// streamOutput does for one CLI process.
func parseTestTurns(t *testing.T, lines ...string) []agent.AgentEvent {
	t.Helper()
	backgroundTasks := &backgroundTaskTracker{}
	authFailures := &authFailureTracker{}
	var events []agent.AgentEvent
	for _, line := range lines {
		var event cliEvent
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			t.Fatalf("bad test line %s: %v", line, err)
		}
		events = append(events, parseLine(testLogger(), []byte(line), event, &sync.Map{}, backgroundTasks, authFailures, testRefusals(nil, nil), attachments.Store{})...)
	}
	return events
}

func authFailuresIn(events []agent.AgentEvent) (warnings, errors []agent.AgentEvent) {
	for _, e := range events {
		switch e := e.(type) {
		case agent.WarningEvent:
			if e.AuthFailure != nil {
				warnings = append(warnings, e)
			}
		case agent.ErrorEvent:
			errors = append(errors, e)
		}
	}
	return warnings, errors
}

var claudeAuth = &agent.AuthFailure{Agent: session.AgentTypeClaude}

// Frames captured from claude 2.1.259/2.1.283 (see
// TestParseLine_FailedFirstTurnLeavesSessionSwitchable for the retrying case).
const (
	authRetryFrame     = `{"type":"system","subtype":"api_retry","attempt":1,"max_retries":10,"retry_delay_ms":611,"error_status":401,"error":"authentication_failed"}`
	authNoticeFrame    = `{"type":"assistant","message":{"model":"<synthetic>","role":"assistant","type":"message","content":[{"type":"text","text":"Not logged in · Please run /login"}]},"error":"authentication_failed","is_api_error_message":true}`
	authResultFrame    = `{"type":"result","subtype":"success","is_error":true,"terminal_reason":"api_error","result":"Not logged in · Please run /login"}`
	overloadRetryFrame = `{"type":"system","subtype":"api_retry","attempt":1,"max_retries":10,"retry_delay_ms":611,"error_status":529,"error":"server_error"}`
	overloadResult     = `{"type":"result","subtype":"success","is_error":true,"terminal_reason":"api_error","result":"API Error: 529 Overloaded"}`
	doneResultFrame    = `{"type":"result","subtype":"success","is_error":false,"result":"hi"}`
)

func TestAuthFailure_NotSignedInMarksTheTurnsError(t *testing.T) {
	events := parseTestTurns(t, authNoticeFrame, authResultFrame)

	warnings, errors := authFailuresIn(events)
	if len(warnings) != 1 {
		t.Errorf("want the CLI's own notice marked, got %#v", events)
	}
	want := agent.ErrorEvent{Error: "Not logged in · Please run /login", AuthFailure: claudeAuth}
	if len(errors) != 1 || !reflect.DeepEqual(errors[0], want) {
		t.Errorf("errors = %#v, want %#v", errors, want)
	}
}

// The CLI retries a refused key for minutes, so the first refused retry is
// reported at once, and only the first.
func TestAuthFailure_FirstRefusedRetryIsReportedOnce(t *testing.T) {
	events := parseTestTurns(t, authRetryFrame, authRetryFrame, authRetryFrame)

	warnings, errors := authFailuresIn(events)
	if len(warnings) != 1 || len(errors) != 0 {
		t.Fatalf("want one early auth warning, got %#v", events)
	}
	if w := warnings[0].(agent.WarningEvent); w.Code != authFailedRetryCode {
		t.Errorf("code = %q, want %q", w.Code, authFailedRetryCode)
	}

	// The retry banners themselves still reach the transcript.
	var banners int
	for _, e := range events {
		if _, ok := e.(agent.SystemEvent); ok {
			banners++
		}
	}
	if banners != 3 {
		t.Errorf("got %d retry banners, want 3", banners)
	}
}

// What a turn ended as is the turn's own: a later turn that fails for another
// reason is not an auth failure, and a turn that recovered is not a failure.
func TestAuthFailure_IsPerTurn(t *testing.T) {
	events := parseTestTurns(t,
		authRetryFrame, doneResultFrame, // recovered after a refresh
		overloadRetryFrame, overloadResult, // failed, but not on credentials
		authRetryFrame, authNoticeFrame, authResultFrame, // failed on credentials
	)

	var endings []agent.AgentEvent
	for _, e := range events {
		if e.EventType().AwaitsUserInput() {
			endings = append(endings, e)
		}
	}
	want := []agent.AgentEvent{
		agent.DoneEvent{},
		agent.ErrorEvent{Error: "API Error: 529 Overloaded"},
		agent.ErrorEvent{Error: "Not logged in · Please run /login", AuthFailure: claudeAuth},
	}
	if len(endings) != len(want) {
		t.Fatalf("endings = %#v, want %#v", endings, want)
	}
	for i := range want {
		if !reflect.DeepEqual(endings[i], want[i]) {
			t.Errorf("ending %d = %#v, want %#v", i, endings[i], want[i])
		}
	}

	// The third turn warns early again: the second one reset the tracker.
	if warnings, _ := authFailuresIn(events); len(warnings) != 3 {
		t.Errorf("got %d auth warnings, want 3 (two early, one notice)", len(warnings))
	}
}

// A refusal the CLI got past (a token refreshed) before failing for something
// else is not what the turn ended on.
func TestAuthFailure_LatestRetryWins(t *testing.T) {
	events := parseTestTurns(t, authRetryFrame, overloadRetryFrame, overloadResult)

	_, errors := authFailuresIn(events)
	want := agent.ErrorEvent{Error: "API Error: 529 Overloaded"}
	if len(errors) != 1 || !reflect.DeepEqual(errors[0], want) {
		t.Errorf("errors = %#v, want %#v", errors, want)
	}
}

// A refusal followed by the model answering was recovered from; a later
// failure with no notice of its own is not an auth failure.
func TestAuthFailure_ModelOutputEndsTheRefusal(t *testing.T) {
	events := parseTestTurns(t,
		authRetryFrame,
		`{"type":"assistant","message":{"model":"claude-opus","role":"assistant","content":[{"type":"text","text":"working"}]}}`,
		`{"type":"result","subtype":"error_during_execution","is_error":true,"terminal_reason":"model_error","errors":["boom"]}`,
	)

	_, errors := authFailuresIn(events)
	want := agent.ErrorEvent{Error: "boom"}
	if len(errors) != 1 || !reflect.DeepEqual(errors[0], want) {
		t.Errorf("errors = %#v, want %#v", errors, want)
	}
}
