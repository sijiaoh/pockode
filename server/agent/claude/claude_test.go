package claude

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"sync"
	"testing"

	"github.com/pockode/server/agent"
)

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
			name:     "result event success",
			input:    `{"type":"result","subtype":"success","result":"Hello"}`,
			expected: []agent.AgentEvent{agent.DoneEvent{}},
		},
		{
			name:     "result event interrupted",
			input:    `{"type":"result","subtype":"error_during_execution","errors":["Error: Request was aborted."]}`,
			expected: []agent.AgentEvent{agent.InterruptedEvent{}},
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
			name:     "control_request non-permission request ignored",
			input:    `{"type":"control_request","request_id":"req-456","request":{"subtype":"other_type"}}`,
			expected: nil,
		},
		{
			name:     "control_request with nil request ignored",
			input:    `{"type":"control_request","request_id":"req-789"}`,
			expected: nil,
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
			results := parseLine(testLogger(), []byte(tt.input), pendingRequests)

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
	default:
		return false
	}
}

func TestParseLine_ControlResponseWithPendingInterrupt(t *testing.T) {
	pendingRequests := &sync.Map{}
	requestID := "interrupt-123"

	// Store interrupt marker (simulating what SendInterrupt does)
	pendingRequests.Store(requestID, interruptMarker{})

	input := `{"type":"control_response","response":{"subtype":"success","request_id":"interrupt-123"}}`
	results := parseLine(testLogger(), []byte(input), pendingRequests)

	expected := []agent.AgentEvent{agent.InterruptedEvent{}}
	if !agentEventsEqual(results, expected) {
		t.Errorf("expected %+v, got %+v", expected, results)
	}

	// Verify marker was removed
	if _, exists := pendingRequests.Load(requestID); exists {
		t.Error("interrupt marker should be removed after processing")
	}
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
	sess := &cliSession{
		log:             testLogger(),
		stdin:           nopWriteCloser{&buf},
		pendingRequests: &sync.Map{},
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
		Answers map[string]string `json:"answers"`
	}
	if err := json.Unmarshal(response.Response.Response.UpdatedInput, &updatedInput); err != nil {
		t.Fatalf("failed to unmarshal updatedInput: %v", err)
	}
	if updatedInput.Answers["Which library?"] != "date-fns" {
		t.Errorf("expected answer 'date-fns', got %q", updatedInput.Answers["Which library?"])
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
