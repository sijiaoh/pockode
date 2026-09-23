package claude

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/attachments"
	"github.com/pockode/server/session"
)

// parseTestLine mirrors streamOutput's decode-then-parse path so tests can feed
// raw lines (including empty and malformed JSON) directly to parseLine.
func parseTestLine(log *slog.Logger, line []byte, pendingRequests *sync.Map) []agent.AgentEvent {
	return parseTestLineWithDecline(log, line, pendingRequests, func(string, string) {})
}

func parseTestLineWithDecline(log *slog.Logger, line []byte, pendingRequests *sync.Map, decline declineFunc) []agent.AgentEvent {
	return parseTestLineFull(log, line, pendingRequests, &backgroundTaskTracker{}, testRefusals(decline, nil))
}

// testRefusals fills in whichever half a test does not care about.
func testRefusals(decline declineFunc, denyTool denyToolFunc) controlRefusals {
	if decline == nil {
		decline = func(string, string) {}
	}
	if denyTool == nil {
		denyTool = func(string, string, string) {}
	}
	return controlRefusals{decline: decline, denyTool: denyTool}
}

// parseTestLineWithTracker feeds lines through a caller-owned background task
// tracker, so a test can replay a whole sequence against one CLI process.
func parseTestLineWithTracker(log *slog.Logger, line []byte, backgroundTasks *backgroundTaskTracker) []agent.AgentEvent {
	return parseTestLineFull(log, line, &sync.Map{}, backgroundTasks, testRefusals(nil, nil))
}

func parseTestLineFull(log *slog.Logger, line []byte, pendingRequests *sync.Map, backgroundTasks *backgroundTaskTracker, refusals controlRefusals) []agent.AgentEvent {
	if len(line) == 0 {
		return nil
	}
	var event cliEvent
	if err := json.Unmarshal(line, &event); err != nil {
		return []agent.AgentEvent{agent.TextEvent{Content: string(line)}}
	}
	return parseLine(log, line, event, pendingRequests, backgroundTasks, refusals, attachments.Store{})
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
			// The uuid is what a fork names its cut point with, so it has to reach
			// every record one CLI message produces — the cut can fall between them.
			name:  "the CLI message uuid reaches every event the message produces",
			input: `{"type":"assistant","uuid":"msg-uuid","message":{"content":[{"type":"text","text":"reading"},{"type":"tool_use","id":"toolu_9","name":"Read","input":{"path":"a.go"}}]}}`,
			expected: []agent.AgentEvent{
				agent.TextEvent{Content: "reading", ProviderMessageID: "msg-uuid"},
				agent.ToolCallEvent{
					ToolUseID:         "toolu_9",
					ToolName:          "Read",
					ToolInput:         json.RawMessage(`{"path":"a.go"}`),
					ProviderMessageID: "msg-uuid",
				},
			},
		},
		{
			name:  "tool_result carries the uuid of the user message it arrived in",
			input: `{"type":"user","uuid":"result-uuid","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_9","content":"done"}]}}`,
			expected: []agent.AgentEvent{agent.ToolResultEvent{
				ToolUseID:         "toolu_9",
				ToolResult:        "done",
				ProviderMessageID: "result-uuid",
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
			// The Agent (subagent) tool reports this way and its report is
			// Markdown: the UI has to receive the text, not the JSON around it.
			name:  "user tool_result with text array content is joined",
			input: `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_arr","content":[{"type":"text","text":"line 1"},{"type":"text","text":"line 2"}]}]}}`,
			expected: []agent.AgentEvent{agent.ToolResultEvent{
				ToolUseID:  "toolu_arr",
				ToolResult: "line 1\nline 2",
			}},
		},
		{
			// A block type nobody has seen yet keeps its raw JSON — visible, so
			// it can be reported — without costing the text beside it.
			name:  "user tool_result with an unknown block keeps its raw JSON",
			input: `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_mix","content":[{"type":"text","text":"line 1"},{"type":"other","text":"line 2"}]}]}}`,
			expected: []agent.AgentEvent{agent.ToolResultEvent{
				ToolUseID:  "toolu_mix",
				ToolResult: "line 1\n" + `{"type":"other","text":"line 2"}`,
			}},
		},
		{
			name:  "user tool_result carries the CLI's error flag",
			input: `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_err","content":"Agent type not found","is_error":true}]}}`,
			expected: []agent.AgentEvent{agent.ToolResultEvent{
				ToolUseID:  "toolu_err",
				ToolResult: "Agent type not found",
				IsError:    true,
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
			// Never surfaced as a question: the CLI's own ask-the-user tool does
			// not reach a Pockode user, so it is refused and the user is told.
			name:     "control_request AskUserQuestion tool",
			input:    `{"type":"control_request","request_id":"req-q-123","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","tool_use_id":"toolu_q_abc","input":{"questions":[{"question":"Which library?","header":"Library","options":[{"label":"A","description":"Option A"}],"multiSelect":false}]}}}`,
			expected: []agent.AgentEvent{agent.CLIQuestionRefusedWarning("Claude")},
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

// buildArgs already keeps AskUserQuestion out of the model's hands, so this
// covers the CLI that stops honouring that flag: the question is refused where
// the CLI waits for it, with the one refusal text both CLIs use, and the user
// gets a record of a question they were never shown.
//
// The deny must not interrupt — see cliSession.denyTool for what the CLI does
// with the message otherwise — and it must name the tool_use_id, which is how
// the CLI matches the refusal to the call.
func TestParseLine_AskUserQuestionIsRefusedRatherThanAsked(t *testing.T) {
	input := `{"type":"control_request","request_id":"req-q-store","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","tool_use_id":"toolu_q","input":{"questions":[{"question":"q?","header":"H","options":[{"label":"a","description":"d"}],"multiSelect":false}]}}}`

	var gotRequestID, gotToolUseID, gotMessage string
	var denials int
	refusals := testRefusals(nil, func(requestID, toolUseID, message string) {
		denials++
		gotRequestID, gotToolUseID, gotMessage = requestID, toolUseID, message
	})

	results := parseTestLineFull(testLogger(), []byte(input), &sync.Map{}, &backgroundTaskTracker{}, refusals)

	if denials != 1 || gotRequestID != "req-q-store" || gotToolUseID != "toolu_q" {
		t.Fatalf("denials = %d on request %q / tool use %q, want one on req-q-store / toolu_q",
			denials, gotRequestID, gotToolUseID)
	}
	if gotMessage != agent.CLIQuestionRefusal {
		t.Errorf("deny message = %q, want the shared refusal text", gotMessage)
	}
	if len(results) != 1 {
		t.Fatalf("expected one event, got %+v", results)
	}
	warning, ok := results[0].(agent.WarningEvent)
	if !ok || warning.Code != agent.CLIQuestionRefusedCode {
		t.Fatalf("expected the user to be warned, got %#v", results[0])
	}
}

// The shape the CLI is sent, rather than the fact that something was sent.
// interrupt is what decides whether the refusal text survives at all.
func TestToolDenial_DoesNotInterruptTheTurn(t *testing.T) {
	content := toolDenial("toolu_q", agent.CLIQuestionRefusal)
	if content.Behavior != "deny" {
		t.Errorf("behavior = %q, want deny", content.Behavior)
	}
	if content.Interrupt {
		t.Error("the deny interrupts the turn; the CLI then replaces the message with its own and aborts")
	}
	data, err := json.Marshal(content)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(data), "interrupt") {
		t.Errorf("the response carries an interrupt field: %s", data)
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

// A cancel from the CLI is a withdrawal of whatever it had open, and the only
// thing it can still have open is a permission request.
func TestParseLine_ControlCancelWithdrawsTheRequest(t *testing.T) {
	results := parseTestLine(testLogger(), []byte(`{"type":"control_cancel_request","request_id":"req-cancel"}`), &sync.Map{})
	if len(results) != 1 {
		t.Fatalf("expected 1 event, got %d", len(results))
	}
	cancelled, ok := results[0].(agent.RequestCancelledEvent)
	if !ok {
		t.Fatalf("expected RequestCancelledEvent, got %T", results[0])
	}
	if cancelled.RequestID != "req-cancel" {
		t.Errorf("request id = %q, want req-cancel", cancelled.RequestID)
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
			// A forked session's transcript is not its own conversation, so
			// activation must not send it off to resume one.
			name:   "an unstarted session starts a provider session of its own",
			state:  &claudeResumeState{Unstarted: true},
			resume: true,
			want:   claudeLaunch{sessionID: "pockode-session"},
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
			// What a fork taken in the middle of a conversation seeds: the same
			// replay, cut short at the message the fork was taken from.
			name:   "fork stage carries the message to stop the replay at",
			state:  &claudeResumeState{SessionID: "claude-session", Recovery: recoveryFork, ResumeAt: "msg-7"},
			resume: true,
			want:   claudeLaunch{sessionID: "claude-session", resume: true, fork: true, resumeAt: "msg-7"},
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

	err := sess.SendMessage(agent.Prompt{Text: "Hello, Claude!"})
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

// readMCPArgs parses an mcp-config.json and returns the pockode proxy's args.
func readMCPArgs(t *testing.T, path string) []string {
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
	return cfg.McpServers.Pockode.Args
}

// TestWriteMCPConfig_CarriesIdentity locks both halves of what the config says:
// where the server is, and who is calling it. The dirs are deliberately split
// the way a named worktree splits them — session state in the worktree's data
// dir, server.json in the main one — because pointing the proxy at the worktree
// dir would leave the agent with no work_* tools at all.
func TestWriteMCPConfig_CarriesIdentity(t *testing.T) {
	dataDir := t.TempDir()
	serverDir := t.TempDir()

	path, remove, err := writeMCPConfig(agent.StartOptions{
		DataDir:      dataDir,
		MCPServerDir: serverDir,
		SessionID:    "s1",
		Worktree:     "feature-x",
	})
	if err != nil {
		t.Fatalf("writeMCPConfig: %v", err)
	}

	if want := sessionDir(dataDir, "s1"); filepath.Dir(path) != want {
		t.Errorf("mcp-config written to %s, want a file in %s", path, want)
	}
	args := readMCPArgs(t, path)
	for _, tc := range [][2]string{
		{"--data-dir", serverDir},
		{"--session-id", "s1"},
		{"--worktree", "feature-x"},
	} {
		if !hasFlagValue(args, tc[0], tc[1]) {
			t.Errorf("args %v missing %s %s", args, tc[0], tc[1])
		}
	}

	// The config is only good for the process it was written for, so the spawn
	// takes it away again.
	remove()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Errorf("mcp-config still present after remove: %v", err)
	}
}

// TestWriteMCPConfig_MainWorktreeIsUnnamed: the main worktree has no name, and
// passing an empty --worktree would make the proxy's flags depend on which
// worktree it happens to be in.
func TestWriteMCPConfig_MainWorktreeIsUnnamed(t *testing.T) {
	path, _, err := writeMCPConfig(agent.StartOptions{DataDir: t.TempDir(), SessionID: "s1"})
	if err != nil {
		t.Fatalf("writeMCPConfig: %v", err)
	}
	for _, arg := range readMCPArgs(t, path) {
		if arg == "--worktree" {
			t.Errorf("main worktree session passed --worktree: %v", readMCPArgs(t, path))
		}
	}
}

// TestWriteMCPConfig_PerProcessRun: a replaced process cleans up while its
// successor is already starting, so two runs of the same session must not share
// a file name — otherwise that cleanup deletes the config the successor's CLI
// has not read yet, and it comes up with no work_* tools.
func TestWriteMCPConfig_PerProcessRun(t *testing.T) {
	dataDir := t.TempDir()
	opts := agent.StartOptions{DataDir: dataDir, SessionID: "s1"}

	first, removeFirst, err := writeMCPConfig(opts)
	if err != nil {
		t.Fatalf("writeMCPConfig first run: %v", err)
	}
	second, _, err := writeMCPConfig(opts)
	if err != nil {
		t.Fatalf("writeMCPConfig second run: %v", err)
	}
	if first == second {
		t.Fatalf("both runs of the session wrote %s", first)
	}

	removeFirst()
	if _, err := os.Stat(second); err != nil {
		t.Errorf("the replaced process removed its successor's config: %v", err)
	}
}

// hasFlagValue reports whether args contains flag followed by value.
func hasFlagValue(args []string, flag, value string) bool {
	for i := 0; i+1 < len(args); i++ {
		if args[i] == flag && args[i+1] == value {
			return true
		}
	}
	return false
}

// The tool is disabled on every launch, not just the default mode: yolo turns
// permission prompts off, and a question is not a permission prompt.
func TestBuildArgs_DisablesTheCLIsOwnQuestionTool(t *testing.T) {
	for _, mode := range []session.Mode{session.ModeDefault, session.ModeYolo} {
		args := buildArgs(agent.StartOptions{Mode: mode}, claudeLaunch{})
		if !hasFlagValue(args, "--disallowedTools", "AskUserQuestion") {
			t.Errorf("mode %q: expected --disallowedTools AskUserQuestion in %v", mode, args)
		}
	}
}

func TestBuildArgs_ModelAndEffort(t *testing.T) {
	args := buildArgs(agent.StartOptions{Model: "opus", Effort: "xhigh"}, claudeLaunch{})

	if !hasFlagValue(args, "--model", "opus") {
		t.Errorf("expected --model opus in %v", args)
	}
	if !hasFlagValue(args, "--effort", "xhigh") {
		t.Errorf("expected --effort xhigh in %v", args)
	}

	// Nothing selected must leave both flags out entirely, so the CLI keeps its
	// own defaults instead of being handed an empty value.
	args = buildArgs(agent.StartOptions{}, claudeLaunch{})
	for _, flag := range []string{"--model", "--effort"} {
		if slices.Contains(args, flag) {
			t.Errorf("expected no %s when nothing is selected, got %v", flag, args)
		}
	}
}

// TestBuildArgs_Launch covers how a resolved launch reaches the CLI: which of
// --session-id and --resume is chosen, and that the fork rung's two flags travel
// with it. They are the only arguments assembled from state rather than fixed,
// so a rung that lost a flag here would start a CLI that silently continued the
// wrong conversation.
func TestBuildArgs_Launch(t *testing.T) {
	tests := []struct {
		name    string
		launch  claudeLaunch
		want    []string
		unwant  []string
		wantVal map[string]string
	}{
		{
			name:    "fresh session names itself",
			launch:  claudeLaunch{sessionID: "sess-1"},
			unwant:  []string{"--resume", "--fork-session", "--resume-session-at"},
			wantVal: map[string]string{"--session-id": "sess-1"},
		},
		{
			name:    "resume reopens by id",
			launch:  claudeLaunch{sessionID: "sess-1", resume: true},
			unwant:  []string{"--session-id", "--fork-session", "--resume-session-at"},
			wantVal: map[string]string{"--resume": "sess-1"},
		},
		{
			name:    "fork resumes at a point under a new id",
			launch:  claudeLaunch{sessionID: "sess-1", resume: true, fork: true, resumeAt: "msg-7"},
			want:    []string{"--fork-session"},
			unwant:  []string{"--session-id"},
			wantVal: map[string]string{"--resume": "sess-1", "--resume-session-at": "msg-7"},
		},
		{
			name:   "no session id leaves every launch flag out",
			launch: claudeLaunch{},
			unwant: []string{"--session-id", "--resume", "--fork-session", "--resume-session-at"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			args := buildArgs(agent.StartOptions{}, tt.launch)

			for _, flag := range tt.want {
				if !slices.Contains(args, flag) {
					t.Errorf("expected %s in %v", flag, args)
				}
			}
			for _, flag := range tt.unwant {
				if slices.Contains(args, flag) {
					t.Errorf("expected no %s, got %v", flag, args)
				}
			}
			for flag, value := range tt.wantVal {
				if !hasFlagValue(args, flag, value) {
					t.Errorf("expected %s %s in %v", flag, value, args)
				}
			}
		})
	}
}
