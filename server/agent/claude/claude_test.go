package claude

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"

	"github.com/pockode/server/agent"
)

// parseTestLine mirrors streamOutput's decode-then-parse path so tests can feed
// raw lines (including empty and malformed JSON) directly to parseLine.
func parseTestLine(log *slog.Logger, line []byte, pendingRequests *sync.Map) []agent.AgentEvent {
	return parseTestLineWithDecline(log, line, pendingRequests, func(string, string) {})
}

func parseTestLineWithDecline(log *slog.Logger, line []byte, pendingRequests *sync.Map, decline declineFunc) []agent.AgentEvent {
	return parseTestLineFull(log, line, pendingRequests, &backgroundTaskTracker{}, decline)
}

// parseTestLineWithTracker feeds lines through a caller-owned background task
// tracker, so a test can replay a whole sequence against one CLI process.
func parseTestLineWithTracker(log *slog.Logger, line []byte, backgroundTasks *backgroundTaskTracker) []agent.AgentEvent {
	return parseTestLineFull(log, line, &sync.Map{}, backgroundTasks, func(string, string) {})
}

func parseTestLineFull(log *slog.Logger, line []byte, pendingRequests *sync.Map, backgroundTasks *backgroundTaskTracker, decline declineFunc) []agent.AgentEvent {
	if len(line) == 0 {
		return nil
	}
	var event cliEvent
	if err := json.Unmarshal(line, &event); err != nil {
		return []agent.AgentEvent{agent.TextEvent{Content: string(line)}}
	}
	return parseLine(log, line, event, pendingRequests, backgroundTasks, decline)
}

// observeLine decodes a raw line and forwards it to observe (test helper).
func (m *claudeResumeStateManager) observeLine(line []byte) {
	var event cliEvent
	if err := json.Unmarshal(line, &event); err != nil {
		return
	}
	m.observe(event)
}

func TestParseLine(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected []agent.AgentEvent
	}{
		{
			name:     "empty line",
			input:    "",
			expected: nil,
		},
		{
			name:     "invalid json falls back to raw text",
			input:    "not json",
			expected: []agent.AgentEvent{agent.TextEvent{Content: "not json"}},
		},
		{
			name:     "system init event is filtered",
			input:    `{"type":"system","subtype":"init","cwd":"/tmp"}`,
			expected: nil,
		},
		{
			name:     "system thinking_tokens event is filtered",
			input:    `{"type":"system","subtype":"thinking_tokens","estimated_tokens":50,"estimated_tokens_delta":50}`,
			expected: nil,
		},
		{
			name:     "system compact_boundary is forwarded",
			input:    `{"type":"system","subtype":"compact_boundary"}`,
			expected: []agent.AgentEvent{agent.SystemEvent{Content: `{"type":"system","subtype":"compact_boundary"}`}},
		},
		{
			name:     "system task_started is filtered",
			input:    `{"type":"system","subtype":"task_started","task_id":"bg1","task_type":"local_bash"}`,
			expected: nil,
		},
		{
			name:     "system task_notification is filtered",
			input:    `{"type":"system","subtype":"task_notification","task_id":"bg1","status":"completed"}`,
			expected: nil,
		},
		{
			name:     "system local_command_output becomes command output",
			input:    `{"type":"system","subtype":"local_command_output","content":"## Context Usage"}`,
			expected: []agent.AgentEvent{agent.CommandOutputEvent{Content: "## Context Usage"}},
		},
		{
			name:     "result event success",
			input:    `{"type":"result","subtype":"success","is_error":false,"terminal_reason":"completed","result":"Hello"}`,
			expected: []agent.AgentEvent{agent.DoneEvent{}},
		},
		{
			name:     "result event aborted by terminal_reason",
			input:    `{"type":"result","subtype":"error_during_execution","is_error":true,"terminal_reason":"aborted_tools","errors":["[ede_diagnostic] stop_reason=tool_use"]}`,
			expected: []agent.AgentEvent{agent.InterruptedEvent{}},
		},
		{
			// An abort reason this code predates still has to stop the work item
			// rather than let it auto-continue.
			name:     "result event aborted by an unknown aborted_ reason",
			input:    `{"type":"result","subtype":"error_during_execution","is_error":true,"terminal_reason":"aborted_by_something_new"}`,
			expected: []agent.AgentEvent{agent.InterruptedEvent{}},
		},
		{
			name:     "result event interrupted without terminal_reason",
			input:    `{"type":"result","subtype":"error_during_execution","errors":["Error: Request was aborted."]}`,
			expected: []agent.AgentEvent{agent.InterruptedEvent{}},
		},
		{
			name:     "result event failure surfaces error",
			input:    `{"type":"result","subtype":"error_max_turns","is_error":true,"terminal_reason":"max_turns","errors":["Reached maximum number of turns (10)"]}`,
			expected: []agent.AgentEvent{agent.ErrorEvent{Error: "Reached maximum number of turns (10)"}},
		},
		{
			name:     "result event success flagged is_error uses result text",
			input:    `{"type":"result","subtype":"success","is_error":true,"terminal_reason":"api_error","result":"API Error: overloaded"}`,
			expected: []agent.AgentEvent{agent.ErrorEvent{Error: "API Error: overloaded"}},
		},
		{
			// Blank entries must not leak a bare separator as the error text.
			name:     "result event failure without usable detail falls back to subtype",
			input:    `{"type":"result","subtype":"error_during_execution","is_error":true,"terminal_reason":"model_error","errors":["","  "]}`,
			expected: []agent.AgentEvent{agent.ErrorEvent{Error: "Claude ended the turn with an error (error_during_execution)"}},
		},
		{
			name:     "assistant text message",
			input:    `{"type":"assistant","message":{"content":[{"type":"text","text":"Hello World"}]}}`,
			expected: []agent.AgentEvent{agent.TextEvent{Content: "Hello World"}},
		},
		{
			name:     "assistant message with multiple text blocks",
			input:    `{"type":"assistant","message":{"content":[{"type":"text","text":"Hello"},{"type":"text","text":" World"}]}}`,
			expected: []agent.AgentEvent{agent.TextEvent{Content: "Hello World"}},
		},
		{
			name:     "assistant message with empty content",
			input:    `{"type":"assistant","message":{"content":[]}}`,
			expected: nil,
		},
		{
			// How Claude reports a turn that never reached the model: an assistant
			// message it wrote itself, marked by the <synthetic> model. Captured from
			// claude 2.1.259 against a local endpoint answering 401.
			name:  "synthetic assistant message becomes a warning labelled by the CLI",
			input: `{"type":"assistant","message":{"id":"58516ac7","model":"<synthetic>","role":"assistant","type":"message","content":[{"type":"text","text":"Invalid API key \u00b7 Fix external API key"}]},"session_id":"08165e10","error":"authentication_failed","is_api_error_message":true}`,
			expected: []agent.AgentEvent{agent.WarningEvent{
				Message: "Invalid API key \u00b7 Fix external API key",
				Code:    "authentication_failed",
			}},
		},
		{
			// The CLI answers its own resume continuation prompt with this, and does
			// not label it. Still not the agent talking, so it takes the same path.
			name:  "synthetic assistant message without a label falls back to a generic code",
			input: `{"type":"assistant","message":{"model":"<synthetic>","role":"assistant","type":"message","content":[{"type":"text","text":"No response requested."}]}}`,
			expected: []agent.AgentEvent{agent.WarningEvent{
				Message: "No response requested.",
				Code:    "synthetic_message",
			}},
		},
		{
			name:  "assistant tool_use message",
			input: `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_123","name":"Read","input":{"file":"test.go"}}]}}`,
			expected: []agent.AgentEvent{agent.ToolCallEvent{
				ToolUseID: "toolu_123",
				ToolName:  "Read",
				ToolInput: json.RawMessage(`{"file":"test.go"}`),
			}},
		},
		{
			name:  "assistant text and tool_use in same message",
			input: `{"type":"assistant","message":{"content":[{"type":"text","text":"I will read the file"},{"type":"tool_use","id":"toolu_456","name":"Read","input":{"path":"main.go"}}]}}`,
			expected: []agent.AgentEvent{
				agent.TextEvent{Content: "I will read the file"},
				agent.ToolCallEvent{
					ToolUseID: "toolu_456",
					ToolName:  "Read",
					ToolInput: json.RawMessage(`{"path":"main.go"}`),
				},
			},
		},
		{
			name:  "assistant multiple tool_use (parallel tools)",
			input: `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_1","name":"Read","input":{"path":"a.go"}},{"type":"tool_use","id":"toolu_2","name":"Read","input":{"path":"b.go"}}]}}`,
			expected: []agent.AgentEvent{
				agent.ToolCallEvent{
					ToolUseID: "toolu_1",
					ToolName:  "Read",
					ToolInput: json.RawMessage(`{"path":"a.go"}`),
				},
				agent.ToolCallEvent{
					ToolUseID: "toolu_2",
					ToolName:  "Read",
					ToolInput: json.RawMessage(`{"path":"b.go"}`),
				},
			},
		},
		{
			name:  "assistant server_tool_use (web search)",
			input: `{"type":"assistant","message":{"content":[{"type":"server_tool_use","id":"srvtoolu_123","name":"web_search","input":{"query":"golang concurrency"}}]}}`,
			expected: []agent.AgentEvent{agent.ToolCallEvent{
				ToolUseID: "srvtoolu_123",
				ToolName:  "web_search",
				ToolInput: json.RawMessage(`{"query":"golang concurrency"}`),
			}},
		},
		{
			name:  "user tool_result with string content",
			input: `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_123","content":"file contents here"}]}}`,
			expected: []agent.AgentEvent{agent.ToolResultEvent{
				ToolUseID:  "toolu_123",
				ToolResult: "file contents here",
			}},
		},
		{
			name:  "user tool_result with image content returns warning",
			input: `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_img","content":[{"type":"image","source":{"type":"base64","data":"..."}},{"type":"text","text":"description"}]}]}}`,
			expected: []agent.AgentEvent{agent.WarningEvent{
				Message: "Image content is not supported yet",
				Code:    "image_not_supported",
			}},
		},
		{
			name:  "user tool_result with non-image array content",
			input: `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_arr","content":[{"type":"text","text":"line 1"},{"type":"text","text":"line 2"}]}]}}`,
			expected: []agent.AgentEvent{agent.ToolResultEvent{
				ToolUseID:  "toolu_arr",
				ToolResult: `[{"type":"text","text":"line 1"},{"type":"text","text":"line 2"}]`,
			}},
		},
		{
			name:  "user multiple tool_results (parallel tool results)",
			input: `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"result 1"},{"type":"tool_result","tool_use_id":"toolu_2","content":"result 2"}]}}`,
			expected: []agent.AgentEvent{
				agent.ToolResultEvent{
					ToolUseID:  "toolu_1",
					ToolResult: "result 1",
				},
				agent.ToolResultEvent{
					ToolUseID:  "toolu_2",
					ToolResult: "result 2",
				},
			},
		},
		{
			name:     "user event with invalid message outputs as text",
			input:    `{"type":"user","message":"invalid message format"}`,
			expected: []agent.AgentEvent{agent.TextEvent{Content: `"invalid message format"`}},
		},
		{
			name:     "progress event is intentionally ignored",
			input:    `{"type":"progress","data":{"type":"bash_progress","output":"","fullOutput":"","elapsedTimeSeconds":2,"totalLines":0},"toolUseID":"bash-progress-0"}`,
			expected: nil,
		},
		{
			name:     "tool_progress event is intentionally ignored",
			input:    `{"type":"tool_progress","tool_use_id":"toolu_1","session_id":"s1"}`,
			expected: nil,
		},
		{
			name:     "rate_limit_event is intentionally ignored",
			input:    `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"},"session_id":"s1"}`,
			expected: nil,
		},
		{
			name:     "unknown event type is ignored",
			input:    `{"type":"unknown_event"}`,
			expected: nil,
		},
		{
			name:  "control_request permission request",
			input: `{"type":"control_request","request_id":"req-123","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"ruby --version"},"tool_use_id":"toolu_abc"}}`,
			expected: []agent.AgentEvent{agent.PermissionRequestEvent{
				RequestID: "req-123",
				ToolName:  "Bash",
				ToolInput: json.RawMessage(`{"command":"ruby --version"}`),
				ToolUseID: "toolu_abc",
			}},
		},
		{
			name:  "control_request AskUserQuestion tool",
			input: `{"type":"control_request","request_id":"req-q-123","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","tool_use_id":"toolu_q_abc","input":{"questions":[{"question":"Which library?","header":"Library","options":[{"label":"A","description":"Option A"}],"multiSelect":false}]}}}`,
			expected: []agent.AgentEvent{agent.AskUserQuestionEvent{
				RequestID: "req-q-123",
				ToolUseID: "toolu_q_abc",
				Questions: []agent.AskUserQuestion{
					{
						Question:    "Which library?",
						Header:      "Library",
						Options:     []agent.QuestionOption{{Label: "A", Description: "Option A"}},
						MultiSelect: false,
					},
				},
			}},
		},
		{
			name:     "system init event with session_id is filtered",
			input:    `{"type":"system","subtype":"init","session_id":"sess-abc-123"}`,
			expected: nil,
		},
		{
			name:     "assistant message with nil message",
			input:    `{"type":"assistant","subtype":"partial"}`,
			expected: nil,
		},
		{
			name:     "user event with nil message",
			input:    `{"type":"user"}`,
			expected: nil,
		},
		{
			name:     "control_response without pending interrupt ignored",
			input:    `{"type":"control_response","response":{"subtype":"success","request_id":"abc123"}}`,
			expected: nil,
		},
		{
			name:     "control_cancel_request cancels request",
			input:    `{"type":"control_cancel_request","request_id":"req-cancel-123"}`,
			expected: []agent.AgentEvent{agent.RequestCancelledEvent{RequestID: "req-cancel-123"}},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			pendingRequests := &sync.Map{}
			results := parseTestLine(testLogger(), []byte(tt.input), pendingRequests)

			if !agentEventsEqual(results, tt.expected) {
				t.Errorf("expected %+v, got %+v", tt.expected, results)
			}
		})
	}
}

// agentEventsEqual compares two slices of AgentEvent.
func agentEventsEqual(a, b []agent.AgentEvent) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if !agentEventEqual(a[i], b[i]) {
			return false
		}
	}
	return true
}

// agentEventEqual compares two AgentEvent values using type switch.
func agentEventEqual(a, b agent.AgentEvent) bool {
	switch av := a.(type) {
	case agent.TextEvent:
		bv, ok := b.(agent.TextEvent)
		return ok && av.Content == bv.Content
	case agent.ToolCallEvent:
		bv, ok := b.(agent.ToolCallEvent)
		return ok && av.ToolUseID == bv.ToolUseID && av.ToolName == bv.ToolName &&
			string(av.ToolInput) == string(bv.ToolInput)
	case agent.ToolResultEvent:
		bv, ok := b.(agent.ToolResultEvent)
		return ok && av.ToolUseID == bv.ToolUseID && av.ToolResult == bv.ToolResult
	case agent.WarningEvent:
		bv, ok := b.(agent.WarningEvent)
		return ok && av.Message == bv.Message && av.Code == bv.Code
	case agent.ErrorEvent:
		bv, ok := b.(agent.ErrorEvent)
		return ok && av.Error == bv.Error
	case agent.DoneEvent:
		_, ok := b.(agent.DoneEvent)
		return ok
	case agent.InterruptedEvent:
		_, ok := b.(agent.InterruptedEvent)
		return ok
	case agent.PermissionRequestEvent:
		bv, ok := b.(agent.PermissionRequestEvent)
		return ok && av.RequestID == bv.RequestID && av.ToolName == bv.ToolName &&
			av.ToolUseID == bv.ToolUseID && string(av.ToolInput) == string(bv.ToolInput)
	case agent.RequestCancelledEvent:
		bv, ok := b.(agent.RequestCancelledEvent)
		return ok && av.RequestID == bv.RequestID
	case agent.AskUserQuestionEvent:
		bv, ok := b.(agent.AskUserQuestionEvent)
		if !ok || av.RequestID != bv.RequestID || av.ToolUseID != bv.ToolUseID {
			return false
		}
		if len(av.Questions) != len(bv.Questions) {
			return false
		}
		for i := range av.Questions {
			if av.Questions[i].Question != bv.Questions[i].Question ||
				av.Questions[i].Header != bv.Questions[i].Header ||
				av.Questions[i].MultiSelect != bv.Questions[i].MultiSelect {
				return false
			}
			if len(av.Questions[i].Options) != len(bv.Questions[i].Options) {
				return false
			}
			for j := range av.Questions[i].Options {
				if av.Questions[i].Options[j].Label != bv.Questions[i].Options[j].Label ||
					av.Questions[i].Options[j].Description != bv.Questions[i].Options[j].Description {
					return false
				}
			}
		}
		return true
	case agent.SystemEvent:
		bv, ok := b.(agent.SystemEvent)
		return ok && av.Content == bv.Content
	case agent.ProcessEndedEvent:
		_, ok := b.(agent.ProcessEndedEvent)
		return ok
	case agent.RawEvent:
		bv, ok := b.(agent.RawEvent)
		return ok && av.Content == bv.Content
	case agent.CommandOutputEvent:
		bv, ok := b.(agent.CommandOutputEvent)
		return ok && av.Content == bv.Content
	default:
		return false
	}
}

// TestParseLine_FailedFirstTurnLeavesSessionSwitchable replays a whole turn that
// never reached the model and holds the property the transcript exists to
// protect: nothing in it may start the session, so a user whose login expired can
// still move the session to another agent.
//
// Where the report comes from: claude 2.1.259, ANTHROPIC_BASE_URL pointed at a
// local endpoint answering 401 to everything, run until the CLI exhausted its
// retries and exited on its own (3m15s). Shortened here to two retry banners; the
// assistant and result frames are the measured ones.
//
// The assistant frame is why this test is not redundant with the ones over
// hand-built event slices: reading it as agent output is what made the escape
// hatch unreachable in exactly the scenario it was built for, and only a test
// that goes through the parser can catch that.
func TestParseLine_FailedFirstTurnLeavesSessionSwitchable(t *testing.T) {
	report := []string{
		`{"type":"system","subtype":"api_retry","attempt":1,"max_retries":10,"retry_delay_ms":611,"error_status":401,"error":"authentication_failed","session_id":"08165e10"}`,
		`{"type":"system","subtype":"api_retry","attempt":10,"max_retries":10,"retry_delay_ms":38000,"error_status":401,"error":"authentication_failed","session_id":"08165e10"}`,
		`{"type":"assistant","message":{"id":"58516ac7","model":"<synthetic>","role":"assistant","stop_reason":"stop_sequence","type":"message","content":[{"type":"text","text":"Invalid API key \u00b7 Fix external API key"}]},"session_id":"08165e10","error":"authentication_failed","is_api_error_message":true}`,
		`{"type":"result","subtype":"success","is_error":true,"terminal_reason":"api_error","api_error_status":401,"result":"Invalid API key \u00b7 Fix external API key","session_id":"08165e10"}`,
	}

	var events []agent.AgentEvent
	for _, line := range report {
		events = append(events, parseTestLine(testLogger(), []byte(line), &sync.Map{})...)
	}

	if len(events) == 0 {
		t.Fatal("expected the failed turn to be reported to the user")
	}
	for _, e := range events {
		if e.EventType().ActivatesSession() {
			t.Errorf("a turn that never reached the model must not start the session, got %s from %#v",
				e.EventType(), e)
		}
	}

	// Silently dropping the CLI's account of the failure would trade one bug for
	// another, so it has to survive the change of event type. Asserted as its own
	// warning rather than by searching every event for the words: in this report
	// the trailing result repeats them verbatim, so a search would still pass with
	// the notice thrown away.
	var found bool
	for _, e := range events {
		if w, ok := e.(agent.WarningEvent); ok && strings.Contains(w.Message, "Invalid API key") {
			found = true
		}
	}
	if !found {
		t.Errorf("expected the CLI's account of the failure to reach the user, got %#v", events)
	}
}

func TestParseLine_AskUserQuestionStoresPendingInput(t *testing.T) {
	pendingRequests := &sync.Map{}
	input := `{"type":"control_request","request_id":"req-q-store","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","tool_use_id":"toolu_q","input":{"questions":[{"question":"q?","header":"H","options":[{"label":"a","description":"d"}],"multiSelect":false}]}}}`

	results := parseTestLine(testLogger(), []byte(input), pendingRequests)
	if len(results) != 1 {
		t.Fatalf("expected 1 event, got %d", len(results))
	}
	if _, ok := results[0].(agent.AskUserQuestionEvent); !ok {
		t.Fatalf("expected AskUserQuestionEvent, got %T", results[0])
	}

	stored, ok := pendingRequests.Load("req-q-store")
	if !ok {
		t.Fatal("expected pending input to be stored")
	}
	marker, ok := stored.(pendingQuestionMarker)
	if !ok {
		t.Fatalf("expected pendingQuestionMarker, got %T", stored)
	}
	var parsed struct {
		Questions []agent.AskUserQuestion `json:"questions"`
	}
	if err := json.Unmarshal(marker.Input, &parsed); err != nil {
		t.Fatalf("stored input is not valid JSON: %v", err)
	}
	if len(parsed.Questions) != 1 || parsed.Questions[0].Question != "q?" {
		t.Errorf("stored input does not preserve questions: %+v", parsed.Questions)
	}
}

// The CLI blocks the turn until a request it originates is answered, so every
// control request that is not can_use_tool has to be answered with an error.
// Leaving any of these shapes unanswered hangs the session for good, which is why
// they are covered together rather than one per known subtype.
func TestParseLine_UnservableControlRequestIsDeclined(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string // request id the CLI must be answered on
	}{
		{
			name:  "subtype Pockode cannot serve",
			input: `{"type":"control_request","request_id":"req-dialog","request":{"subtype":"request_user_dialog","dialog_kind":"plan"}}`,
			want:  "req-dialog",
		},
		{
			// Where an unknown subtype comes from is a CLI newer than this code.
			name:  "subtype this code has never seen",
			input: `{"type":"control_request","request_id":"req-unknown","request":{"subtype":"some_future_subtype"}}`,
			want:  "req-unknown",
		},
		{
			name:  "request without a body",
			input: `{"type":"control_request","request_id":"req-empty"}`,
			want:  "req-empty",
		},
		{
			// Unreadable is not unanswerable: the id survives a body of the
			// wrong shape, and answering matters more than understanding.
			name:  "request whose body is not an object",
			input: `{"type":"control_request","request_id":"req-broken","request":"nonsense"}`,
			want:  "req-broken",
		},
		{
			// The one shape that reaches here through can_use_tool: a question
			// whose input the CLI has restructured.
			name:  "AskUserQuestion with unreadable input",
			input: `{"type":"control_request","request_id":"req-q","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","input":{"questions":"not-a-list"}}}`,
			want:  "req-q",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var gotRequestID, gotMessage string
			decline := func(requestID, message string) {
				gotRequestID, gotMessage = requestID, message
			}

			results := parseTestLineWithDecline(testLogger(), []byte(tt.input), &sync.Map{}, decline)

			if len(results) != 1 {
				t.Fatalf("expected 1 event, got %+v", results)
			}
			warning, ok := results[0].(agent.WarningEvent)
			if !ok {
				t.Fatalf("expected WarningEvent, got %T", results[0])
			}
			if warning.Code != "unsupported_control_request" {
				t.Errorf("warning code = %q, want unsupported_control_request", warning.Code)
			}
			if gotRequestID != tt.want {
				t.Errorf("declined request id = %q, want %q", gotRequestID, tt.want)
			}
			if gotMessage == "" {
				t.Error("expected a non-empty decline message")
			}
		})
	}
}

// An unreadable request with no id left cannot be answered at all; the only thing
// that must not happen is a bogus response on an empty id.
func TestParseLine_ControlRequestWithoutIDIsNotDeclined(t *testing.T) {
	declined := false
	decline := func(string, string) { declined = true }

	input := `{"type":"control_request","request_id":123,"request":{"subtype":"whatever"}}`
	results := parseTestLineWithDecline(testLogger(), []byte(input), &sync.Map{}, decline)

	if declined {
		t.Error("must not answer a request whose id could not be read")
	}
	if len(results) != 0 {
		t.Errorf("expected no events, got %+v", results)
	}
}

func TestSession_DeclineControlRequest(t *testing.T) {
	var buf bytes.Buffer
	sess := &cliSession{
		log:             testLogger(),
		stdin:           nopWriteCloser{&buf},
		pendingRequests: &sync.Map{},
	}

	sess.declineControlRequest("req-1", "not supported")

	var response controlErrorResponse
	if err := json.Unmarshal(buf.Bytes(), &response); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}
	if response.Response.Subtype != "error" {
		t.Errorf("subtype = %q, want error", response.Response.Subtype)
	}
	if response.Response.RequestID != "req-1" {
		t.Errorf("request_id = %q, want req-1", response.Response.RequestID)
	}
	if response.Response.Error != "not supported" {
		t.Errorf("error = %q, want 'not supported'", response.Response.Error)
	}
}

func TestParseLine_ControlCancelRemovesPendingQuestion(t *testing.T) {
	pendingRequests := &sync.Map{}
	pendingRequests.Store("req-cancel", pendingQuestionMarker{Input: json.RawMessage(`{"questions":[]}`)})

	results := parseTestLine(testLogger(), []byte(`{"type":"control_cancel_request","request_id":"req-cancel"}`), pendingRequests)
	if len(results) != 1 {
		t.Fatalf("expected 1 event, got %d", len(results))
	}
	if _, ok := results[0].(agent.RequestCancelledEvent); !ok {
		t.Fatalf("expected RequestCancelledEvent, got %T", results[0])
	}

	if _, ok := pendingRequests.Load("req-cancel"); ok {
		t.Error("expected pending question entry to be deleted after cancel")
	}
}

func TestParseLine_ControlResponseWithPendingInterrupt(t *testing.T) {
	pendingRequests := &sync.Map{}
	requestID := "interrupt-123"

	// Store interrupt marker (simulating what SendInterrupt does)
	pendingRequests.Store(requestID, interruptMarker{})

	input := `{"type":"control_response","response":{"subtype":"success","request_id":"interrupt-123"}}`
	results := parseTestLine(testLogger(), []byte(input), pendingRequests)

	expected := []agent.AgentEvent{agent.InterruptedEvent{}}
	if !agentEventsEqual(results, expected) {
		t.Errorf("expected %+v, got %+v", expected, results)
	}

	// Verify marker was removed
	if _, exists := pendingRequests.Load(requestID); exists {
		t.Error("interrupt marker should be removed after processing")
	}
}

func TestClaudeResumeStateResolve(t *testing.T) {
	tests := []struct {
		name  string
		state *claudeResumeState
		// resume mirrors opts.Resume (the session was activated before).
		resume bool
		want   claudeLaunch
		// wantMintedID expects a freshly minted UUID instead of want.sessionID.
		wantMintedID bool
	}{
		{
			name: "new session claims the pockode session id",
			want: claudeLaunch{sessionID: "pockode-session"},
		},
		{
			name:   "activated session without recorded id is forked",
			resume: true,
			want:   claudeLaunch{sessionID: "pockode-session", resume: true, fork: true},
		},
		{
			name:   "recorded id is resumed",
			state:  &claudeResumeState{SessionID: "claude-session"},
			resume: true,
			want:   claudeLaunch{sessionID: "claude-session", resume: true},
		},
		{
			name:   "fork stage resumes with fork",
			state:  &claudeResumeState{SessionID: "claude-session", Recovery: recoveryFork},
			resume: true,
			want:   claudeLaunch{sessionID: "claude-session", resume: true, fork: true},
		},
		{
			name:         "fresh stage starts a new provider session",
			state:        &claudeResumeState{SessionID: "claude-session", Recovery: recoveryFresh},
			resume:       true,
			wantMintedID: true,
		},
		{
			name:   "unknown stage falls back to a plain resume",
			state:  &claudeResumeState{SessionID: "claude-session", Recovery: "bogus"},
			resume: true,
			want:   claudeLaunch{sessionID: "claude-session", resume: true},
		},
		{
			// A recorded id proves the CLI already owns that session, which
			// makes --session-id fatal no matter what the session store thinks.
			name:  "recorded id wins over a session that looks unactivated",
			state: &claudeResumeState{SessionID: "claude-session"},
			want:  claudeLaunch{sessionID: "claude-session", resume: true},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			manager := newTestResumeManager(t, tt.resume)
			if tt.state != nil {
				writeResumeState(t, manager, *tt.state)
			}

			got := manager.resolve()
			if tt.wantMintedID {
				if _, err := uuid.Parse(got.sessionID); err != nil {
					t.Fatalf("minted session id %q is not a UUID: %v", got.sessionID, err)
				}
				if got.sessionID == "pockode-session" || got.sessionID == "claude-session" {
					t.Fatalf("fresh stage reused session id %q", got.sessionID)
				}
				if got.resume || got.fork {
					t.Fatalf("fresh stage must not resume, got %+v", got)
				}
				return
			}
			if got != tt.want {
				t.Fatalf("launch = %+v, want %+v", got, tt.want)
			}
		})
	}
}

func TestClaudeResumeStateResolveIgnoresInvalidState(t *testing.T) {
	tests := []struct {
		name string
		data string
	}{
		{
			name: "malformed json",
			data: `{`,
		},
		{
			name: "empty session id",
			data: `{"sessionId":""}`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			manager := newTestResumeManager(t, true)
			path := manager.path()
			if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
				t.Fatalf("create resume dir: %v", err)
			}
			if err := os.WriteFile(path, []byte(tt.data), 0644); err != nil {
				t.Fatalf("write resume state: %v", err)
			}

			want := claudeLaunch{sessionID: "pockode-session", resume: true, fork: true}
			if got := manager.resolve(); got != want {
				t.Fatalf("launch = %+v, want %+v", got, want)
			}
		})
	}
}

func TestClaudeResumeStateSavesOnInit(t *testing.T) {
	manager := newTestResumeManager(t, false)
	manager.resolve()

	if _, err := os.Stat(manager.path()); !os.IsNotExist(err) {
		t.Fatalf("resume state should not exist before init, stat err = %v", err)
	}

	manager.observeLine([]byte(`{"type":"system","subtype":"init","session_id":"claude-session"}`))
	if got := readResumeState(t, manager); got != (claudeResumeState{SessionID: "claude-session"}) {
		t.Fatalf("resume state = %+v, want sessionId claude-session", got)
	}
}

func TestClaudeResumeStateInitDoesNotRewriteUnchangedState(t *testing.T) {
	manager := newTestResumeManager(t, true)
	// Formatting a save() would not reproduce, so any rewrite is visible in the
	// bytes on disk rather than only in a coarse-grained mtime.
	seeded := []byte("{\n  \"sessionId\": \"claude-session\"\n}\n")
	if err := os.MkdirAll(filepath.Dir(manager.path()), 0755); err != nil {
		t.Fatalf("create resume dir: %v", err)
	}
	if err := os.WriteFile(manager.path(), seeded, 0644); err != nil {
		t.Fatalf("write resume state: %v", err)
	}
	manager.resolve()

	// The CLI repeats init at the start of every turn.
	for range 3 {
		manager.observeLine([]byte(`{"type":"system","subtype":"init","session_id":"claude-session"}`))
	}

	data, err := os.ReadFile(manager.path())
	if err != nil {
		t.Fatalf("read resume state: %v", err)
	}
	if !bytes.Equal(data, seeded) {
		t.Fatalf("resume state was rewritten for an unchanged session id: %s", data)
	}
}

// The CLI does not always keep the id it was handed: resuming a session that
// another process still holds open silently forks it and reports a new id
// through init. Verified against claude 2.1.259.
func TestClaudeResumeStateInitAdoptsAReassignedID(t *testing.T) {
	manager := newTestResumeManager(t, true)
	writeResumeState(t, manager, claudeResumeState{SessionID: "claude-session"})
	if got := manager.resolve(); !got.resume || got.fork {
		t.Fatalf("launch = %+v, want a plain resume", got)
	}

	manager.observeLine([]byte(`{"type":"system","subtype":"init","session_id":"reassigned-session"}`))

	if got := readResumeState(t, manager); got != (claudeResumeState{SessionID: "reassigned-session"}) {
		t.Fatalf("resume state = %+v, want the id the CLI reported back", got)
	}
}

func TestClaudeResumeStateInitClearsRecovery(t *testing.T) {
	manager := newTestResumeManager(t, true)
	writeResumeState(t, manager, claudeResumeState{SessionID: "claude-session", Recovery: recoveryFork})
	manager.resolve()

	// A fork mints a new provider session id, reported through init.
	manager.observeLine([]byte(`{"type":"system","subtype":"init","session_id":"forked-session"}`))

	if got := readResumeState(t, manager); got != (claudeResumeState{SessionID: "forked-session"}) {
		t.Fatalf("resume state = %+v, want forked-session with cleared recovery", got)
	}
	// A later exit must not re-escalate a session that already succeeded.
	manager.processExited(false)
	if got := readResumeState(t, manager); got.Recovery != recoveryNone {
		t.Fatalf("recovery = %q after a successful launch, want empty", got.Recovery)
	}
}

func TestClaudeResumeStateEscalatesOnExitWithoutInit(t *testing.T) {
	tests := []struct {
		name  string
		state *claudeResumeState
		want  claudeResumeState
	}{
		{
			name: "new session escalates to fork",
			want: claudeResumeState{SessionID: "pockode-session", Recovery: recoveryFork},
		},
		{
			name:  "resume escalates to fork",
			state: &claudeResumeState{SessionID: "claude-session"},
			want:  claudeResumeState{SessionID: "claude-session", Recovery: recoveryFork},
		},
		{
			name:  "fork escalates to fresh",
			state: &claudeResumeState{SessionID: "claude-session", Recovery: recoveryFork},
			want:  claudeResumeState{SessionID: "claude-session", Recovery: recoveryFresh},
		},
		{
			name:  "fresh is terminal",
			state: &claudeResumeState{SessionID: "claude-session", Recovery: recoveryFresh},
			want:  claudeResumeState{SessionID: "claude-session", Recovery: recoveryFresh},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			manager := newTestResumeManager(t, tt.state != nil)
			if tt.state != nil {
				writeResumeState(t, manager, *tt.state)
			}
			manager.resolve()
			manager.processExited(false)

			if got := readResumeState(t, manager); got != tt.want {
				t.Fatalf("resume state = %+v, want %+v", got, tt.want)
			}
		})
	}
}

func TestClaudeResumeStateDoesNotEscalateWhenCancelled(t *testing.T) {
	manager := newTestResumeManager(t, true)
	writeResumeState(t, manager, claudeResumeState{SessionID: "claude-session"})
	manager.resolve()

	manager.processExited(true)

	if got := readResumeState(t, manager); got.Recovery != recoveryNone {
		t.Fatalf("recovery = %q after our own shutdown, want empty", got.Recovery)
	}
}

func TestClaudeResumeStatePendingWarningOnlyForFreshStage(t *testing.T) {
	manager := newTestResumeManager(t, true)
	writeResumeState(t, manager, claudeResumeState{SessionID: "claude-session", Recovery: recoveryFork})
	manager.resolve()
	if _, ok := manager.pendingWarning(); ok {
		t.Fatal("fork stage should not warn: it keeps the agent-side context")
	}

	manager = newTestResumeManager(t, true)
	writeResumeState(t, manager, claudeResumeState{SessionID: "claude-session", Recovery: recoveryFresh})
	manager.resolve()

	warning, ok := manager.pendingWarning()
	if !ok {
		t.Fatal("fresh stage should warn that the earlier context is gone")
	}
	if warning.Code != "session_not_resumable" {
		t.Fatalf("warning code = %q, want session_not_resumable", warning.Code)
	}
	if _, ok := manager.pendingWarning(); ok {
		t.Fatal("warning should be delivered only once")
	}
}

func newTestResumeManager(t *testing.T, resume bool) *claudeResumeStateManager {
	t.Helper()
	return newClaudeResumeStateManager(agent.StartOptions{
		DataDir:   t.TempDir(),
		SessionID: "pockode-session",
		Resume:    resume,
	}, testLogger())
}

// writeResumeState seeds claude_resume.json as a previous process would have
// left it, without going through the manager that is under test.
func writeResumeState(t *testing.T, m *claudeResumeStateManager, state claudeResumeState) {
	t.Helper()
	data, err := json.Marshal(state)
	if err != nil {
		t.Fatalf("marshal resume state: %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(m.path()), 0755); err != nil {
		t.Fatalf("create resume dir: %v", err)
	}
	if err := os.WriteFile(m.path(), data, 0644); err != nil {
		t.Fatalf("write resume state: %v", err)
	}
}

func readResumeState(t *testing.T, m *claudeResumeStateManager) claudeResumeState {
	t.Helper()
	data, err := os.ReadFile(m.path())
	if err != nil {
		t.Fatalf("read resume state: %v", err)
	}
	var state claudeResumeState
	if err := json.Unmarshal(data, &state); err != nil {
		t.Fatalf("parse resume state: %v", err)
	}
	return state
}

// nopWriteCloser wraps a Writer to implement WriteCloser
type nopWriteCloser struct {
	*bytes.Buffer
}

func (nopWriteCloser) Close() error { return nil }

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func TestSession_SendPermissionResponse_Allow(t *testing.T) {
	var buf bytes.Buffer
	sess := &cliSession{
		log:             testLogger(),
		stdin:           nopWriteCloser{&buf},
		pendingRequests: &sync.Map{},
	}

	data := agent.PermissionRequestData{
		RequestID: "req-perm-123",
		ToolUseID: "toolu_perm",
		ToolInput: json.RawMessage(`{"command":"ls"}`),
	}
	err := sess.SendPermissionResponse(data, agent.PermissionAllow)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var response controlResponse
	if err := json.Unmarshal(buf.Bytes(), &response); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}
	if response.Response.Response.Behavior != "allow" {
		t.Errorf("expected behavior 'allow', got %q", response.Response.Response.Behavior)
	}
}

func TestSession_SendPermissionResponse_Deny(t *testing.T) {
	var buf bytes.Buffer
	sess := &cliSession{
		log:             testLogger(),
		stdin:           nopWriteCloser{&buf},
		pendingRequests: &sync.Map{},
	}

	data := agent.PermissionRequestData{
		RequestID: "req-deny-456",
		ToolUseID: "toolu_deny",
	}
	err := sess.SendPermissionResponse(data, agent.PermissionDeny)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var response controlResponse
	if err := json.Unmarshal(buf.Bytes(), &response); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}
	if response.Response.Response.Behavior != "deny" {
		t.Errorf("expected behavior 'deny', got %q", response.Response.Response.Behavior)
	}
	if !response.Response.Response.Interrupt {
		t.Error("expected interrupt to be true")
	}
}

func TestSession_SendPermissionResponse_AlwaysAllow(t *testing.T) {
	var buf bytes.Buffer
	sess := &cliSession{
		log:             testLogger(),
		stdin:           nopWriteCloser{&buf},
		pendingRequests: &sync.Map{},
	}

	suggestions := []agent.PermissionUpdate{
		{
			Type:        agent.PermissionUpdateAddRules,
			Rules:       []agent.PermissionRuleValue{{ToolName: "Bash", RuleContent: "npm install *"}},
			Behavior:    agent.PermissionBehaviorAllow,
			Destination: agent.PermissionDestinationLocalSettings,
		},
	}
	data := agent.PermissionRequestData{
		RequestID:             "req-always-789",
		ToolUseID:             "toolu_always",
		ToolInput:             json.RawMessage(`{"command":"npm install lodash"}`),
		PermissionSuggestions: suggestions,
	}
	err := sess.SendPermissionResponse(data, agent.PermissionAlwaysAllow)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var response controlResponse
	if err := json.Unmarshal(buf.Bytes(), &response); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}
	if response.Response.Response.Behavior != "allow" {
		t.Errorf("expected behavior 'allow', got %q", response.Response.Response.Behavior)
	}
	if response.Response.Response.UpdatedPermissions == nil {
		t.Error("expected updatedPermissions to be set")
	}
}

func TestSession_SendMessage(t *testing.T) {
	var buf bytes.Buffer
	sess := &cliSession{
		log:   testLogger(),
		stdin: nopWriteCloser{&buf},
	}

	err := sess.SendMessage("Hello, Claude!")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var msg userMessage
	if err := json.Unmarshal(buf.Bytes(), &msg); err != nil {
		t.Fatalf("failed to unmarshal message: %v", err)
	}

	if msg.Type != "user" {
		t.Errorf("expected type 'user', got %q", msg.Type)
	}
	if msg.Message.Role != "user" {
		t.Errorf("expected role 'user', got %q", msg.Message.Role)
	}
	if len(msg.Message.Content) != 1 {
		t.Fatalf("expected 1 content block, got %d", len(msg.Message.Content))
	}
	if msg.Message.Content[0].Type != "text" {
		t.Errorf("expected content type 'text', got %q", msg.Message.Content[0].Type)
	}
	if msg.Message.Content[0].Text != "Hello, Claude!" {
		t.Errorf("expected text 'Hello, Claude!', got %q", msg.Message.Content[0].Text)
	}
}

func TestSession_SendQuestionResponse(t *testing.T) {
	var buf bytes.Buffer
	pending := &sync.Map{}
	originalInput := json.RawMessage(`{"questions":[{"question":"Which library?","header":"Library","options":[{"label":"date-fns","description":"d"}],"multiSelect":false}]}`)
	pending.Store("req-q-456", pendingQuestionMarker{Input: originalInput})

	sess := &cliSession{
		log:             testLogger(),
		stdin:           nopWriteCloser{&buf},
		pendingRequests: pending,
	}

	data := agent.QuestionRequestData{
		RequestID: "req-q-456",
		ToolUseID: "toolu_q",
	}
	answers := map[string]string{
		"Which library?": "date-fns",
		"Which format?":  "Other: custom",
	}

	err := sess.SendQuestionResponse(data, answers)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var response controlResponse
	if err := json.Unmarshal(buf.Bytes(), &response); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}
	if response.Response.RequestID != "req-q-456" {
		t.Errorf("expected request_id 'req-q-456', got %q", response.Response.RequestID)
	}
	if response.Response.Response.Behavior != "allow" {
		t.Errorf("expected behavior 'allow', got %q", response.Response.Response.Behavior)
	}

	var updatedInput struct {
		Questions []agent.AskUserQuestion `json:"questions"`
		Answers   map[string]string       `json:"answers"`
	}
	if err := json.Unmarshal(response.Response.Response.UpdatedInput, &updatedInput); err != nil {
		t.Fatalf("failed to unmarshal updatedInput: %v", err)
	}
	if updatedInput.Answers["Which library?"] != "date-fns" {
		t.Errorf("expected answer 'date-fns', got %q", updatedInput.Answers["Which library?"])
	}
	// The SDK requires the original `questions` field to remain in updatedInput.
	if len(updatedInput.Questions) != 1 || updatedInput.Questions[0].Question != "Which library?" {
		t.Errorf("expected questions to be preserved, got %+v", updatedInput.Questions)
	}

	// Pending entry should be consumed so a duplicate response doesn't echo it again.
	if _, ok := pending.Load("req-q-456"); ok {
		t.Error("expected pending question entry to be removed after response")
	}
}

// Claude may send `"input": null` (Unmarshal into our struct succeeds with
// nil Questions). The raw `null` bytes get stored in the marker and must not
// panic the merge step.
func TestSession_SendQuestionResponse_NullInput(t *testing.T) {
	var buf bytes.Buffer
	pending := &sync.Map{}
	pending.Store("req-q-null", pendingQuestionMarker{Input: json.RawMessage(`null`)})

	sess := &cliSession{
		log:             testLogger(),
		stdin:           nopWriteCloser{&buf},
		pendingRequests: pending,
	}

	err := sess.SendQuestionResponse(agent.QuestionRequestData{
		RequestID: "req-q-null",
		ToolUseID: "toolu_q",
	}, map[string]string{"q": "a"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var response controlResponse
	if err := json.Unmarshal(buf.Bytes(), &response); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}
	var updatedInput map[string]any
	if err := json.Unmarshal(response.Response.Response.UpdatedInput, &updatedInput); err != nil {
		t.Fatalf("failed to unmarshal updatedInput: %v", err)
	}
	if _, ok := updatedInput["answers"]; !ok {
		t.Error("expected answers field present after JSON null input")
	}
}

func TestSession_SendQuestionResponse_NoPendingInput(t *testing.T) {
	var buf bytes.Buffer
	sess := &cliSession{
		log:             testLogger(),
		stdin:           nopWriteCloser{&buf},
		pendingRequests: &sync.Map{},
	}

	data := agent.QuestionRequestData{
		RequestID: "req-q-orphan",
		ToolUseID: "toolu_q",
	}
	answers := map[string]string{"q": "a"}

	if err := sess.SendQuestionResponse(data, answers); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var response controlResponse
	if err := json.Unmarshal(buf.Bytes(), &response); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}
	if response.Response.Response.Behavior != "allow" {
		t.Errorf("expected behavior 'allow', got %q", response.Response.Response.Behavior)
	}
	var updatedInput map[string]any
	if err := json.Unmarshal(response.Response.Response.UpdatedInput, &updatedInput); err != nil {
		t.Fatalf("failed to unmarshal updatedInput: %v", err)
	}
	if _, ok := updatedInput["answers"]; !ok {
		t.Error("expected answers field present even without pending input")
	}
}

func TestSession_SendQuestionResponse_Cancel(t *testing.T) {
	var buf bytes.Buffer
	sess := &cliSession{
		log:             testLogger(),
		stdin:           nopWriteCloser{&buf},
		pendingRequests: &sync.Map{},
	}

	data := agent.QuestionRequestData{
		RequestID: "req-q-cancel",
		ToolUseID: "toolu_q_cancel",
	}
	err := sess.SendQuestionResponse(data, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var response controlResponse
	if err := json.Unmarshal(buf.Bytes(), &response); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}
	if response.Response.RequestID != "req-q-cancel" {
		t.Errorf("expected request_id 'req-q-cancel', got %q", response.Response.RequestID)
	}
	if response.Response.Response.Behavior != "deny" {
		t.Errorf("expected behavior 'deny', got %q", response.Response.Response.Behavior)
	}
	if response.Response.Response.ToolUseID != "toolu_q_cancel" {
		t.Errorf("expected toolUseID 'toolu_q_cancel', got %q", response.Response.Response.ToolUseID)
	}
	if response.Response.Response.UpdatedInput != nil {
		t.Error("expected updatedInput to be nil for cancel")
	}
	if !response.Response.Response.Interrupt {
		t.Error("expected interrupt to be true for cancel")
	}
}

func TestExtractEventsFromText(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected []agent.AgentEvent
	}{
		{
			name:     "plain text only",
			input:    "Hello world",
			expected: nil,
		},
		{
			name:     "single tag",
			input:    "<local-command-stdout>output</local-command-stdout>",
			expected: []agent.AgentEvent{agent.CommandOutputEvent{Content: "output"}},
		},
		{
			name:     "text before tag",
			input:    "Before text <local-command-stdout>output</local-command-stdout>",
			expected: []agent.AgentEvent{agent.CommandOutputEvent{Content: "output"}},
		},
		{
			name:     "text after tag",
			input:    "<local-command-stdout>output</local-command-stdout> After text",
			expected: []agent.AgentEvent{agent.CommandOutputEvent{Content: "output"}},
		},
		{
			name:     "text surrounding tag",
			input:    "Before <local-command-stdout>output</local-command-stdout> After",
			expected: []agent.AgentEvent{agent.CommandOutputEvent{Content: "output"}},
		},
		{
			name:  "multiple tags",
			input: "<local-command-stdout>first</local-command-stdout> middle <local-command-stdout>second</local-command-stdout>",
			expected: []agent.AgentEvent{
				agent.CommandOutputEvent{Content: "first"},
				agent.CommandOutputEvent{Content: "second"},
			},
		},
		{
			name:  "multiple tags with surrounding text",
			input: "start <local-command-stdout>first</local-command-stdout> middle <local-command-stdout>second</local-command-stdout> end",
			expected: []agent.AgentEvent{
				agent.CommandOutputEvent{Content: "first"},
				agent.CommandOutputEvent{Content: "second"},
			},
		},
		{
			name:     "empty input",
			input:    "",
			expected: nil,
		},
		{
			name:     "whitespace only",
			input:    "   ",
			expected: nil,
		},
		{
			name:     "unclosed tag",
			input:    "<local-command-stdout>unclosed",
			expected: nil,
		},
		{
			name:     "unclosed tag with text before",
			input:    "Before <local-command-stdout>unclosed",
			expected: nil,
		},
		{
			name:     "stderr tag",
			input:    "<local-command-stderr>Error: Compaction canceled.</local-command-stderr>",
			expected: []agent.AgentEvent{agent.CommandOutputEvent{Content: "Error: Compaction canceled."}},
		},
		{
			name:  "mixed stdout and stderr",
			input: "<local-command-stdout>output</local-command-stdout> <local-command-stderr>error</local-command-stderr>",
			expected: []agent.AgentEvent{
				agent.CommandOutputEvent{Content: "output"},
				agent.CommandOutputEvent{Content: "error"},
			},
		},
		{
			name:     "empty tag content",
			input:    "<local-command-stdout></local-command-stdout>",
			expected: nil,
		},
		{
			name:     "whitespace only tag content",
			input:    "<local-command-stdout>   </local-command-stdout>",
			expected: nil,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := extractEventsFromText(testLogger(), tt.input)
			if len(result) != len(tt.expected) {
				t.Fatalf("expected %d events, got %d: %+v", len(tt.expected), len(result), result)
			}
			for i, ev := range result {
				if ev != tt.expected[i] {
					t.Errorf("event[%d]: expected %+v, got %+v", i, tt.expected[i], ev)
				}
			}
		})
	}
}

// readMCPDataDir parses an mcp-config.json and returns the pockode server's
// --data-dir argument.
func readMCPDataDir(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read mcp-config: %v", err)
	}
	var cfg struct {
		McpServers struct {
			Pockode struct {
				Args []string `json:"args"`
			} `json:"pockode"`
		} `json:"mcpServers"`
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		t.Fatalf("parse mcp-config: %v", err)
	}
	args := cfg.McpServers.Pockode.Args
	for i, a := range args {
		if a == "--data-dir" && i+1 < len(args) {
			return args[i+1]
		}
	}
	t.Fatalf("no --data-dir in mcp-config args %v", args)
	return ""
}

func TestEnsureMCPConfig_PointsAtGivenDir(t *testing.T) {
	dir := t.TempDir()
	path, err := ensureMCPConfig(dir)
	if err != nil {
		t.Fatalf("ensureMCPConfig: %v", err)
	}
	if got := filepath.Dir(path); got != dir {
		t.Errorf("mcp-config written to %s, want under %s", path, dir)
	}
	if got := readMCPDataDir(t, path); got != dir {
		t.Errorf("--data-dir = %s, want %s", got, dir)
	}
}

// TestStart_MCPConfigUsesServerDir locks the worktree fix: for a named worktree,
// DataDir (session state) and MCPServerDir (server.json) differ, and the MCP
// proxy must be pointed at the server dir — the worktree DataDir has no
// server.json. ensureMCPConfig runs before the process spawns, so this holds
// whether or not the claude binary is installed.
func TestStart_MCPConfigUsesServerDir(t *testing.T) {
	sessionDir := t.TempDir() // per-worktree data dir
	serverDir := t.TempDir()  // main data dir holding server.json

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sess, _ := New().Start(ctx, agent.StartOptions{
		WorkDir:      t.TempDir(),
		DataDir:      sessionDir,
		MCPServerDir: serverDir,
		SessionID:    "s1",
	})
	if sess != nil {
		sess.Close()
	}

	// The MCP config must land in the server dir, pointing at the server dir.
	serverCfg := filepath.Join(serverDir, "mcp-config.json")
	if _, err := os.Stat(serverCfg); err != nil {
		t.Fatalf("mcp-config not written to server dir: %v", err)
	}
	if got := readMCPDataDir(t, serverCfg); got != serverDir {
		t.Errorf("--data-dir = %s, want server dir %s", got, serverDir)
	}
	// It must NOT be written to the per-worktree session dir.
	if _, err := os.Stat(filepath.Join(sessionDir, "mcp-config.json")); err == nil {
		t.Errorf("mcp-config unexpectedly written to session dir %s", sessionDir)
	}
}
