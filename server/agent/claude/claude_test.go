package claude

import (
	"bytes"
	"encoding/json"
	"reflect"
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
			name:  "invalid json falls back to raw text",
			input: "not json",
			expected: []agent.AgentEvent{{
				Type:    agent.EventTypeText,
				Content: "not json",
			}},
		},
		{
			name:     "system init event is filtered",
			input:    `{"type":"system","subtype":"init","cwd":"/tmp"}`,
			expected: nil,
		},
		{
			name:  "result event success",
			input: `{"type":"result","subtype":"success","result":"Hello"}`,
			expected: []agent.AgentEvent{
				{Type: agent.EventTypeDone},
			},
		},
		{
			name:  "result event interrupted",
			input: `{"type":"result","subtype":"error_during_execution","errors":["Error: Request was aborted."]}`,
			expected: []agent.AgentEvent{
				{Type: agent.EventTypeInterrupted},
			},
		},
		{
			name:  "assistant text message",
			input: `{"type":"assistant","message":{"content":[{"type":"text","text":"Hello World"}]}}`,
			expected: []agent.AgentEvent{{
				Type:    agent.EventTypeText,
				Content: "Hello World",
			}},
		},
		{
			name:  "assistant message with multiple text blocks",
			input: `{"type":"assistant","message":{"content":[{"type":"text","text":"Hello"},{"type":"text","text":" World"}]}}`,
			expected: []agent.AgentEvent{{
				Type:    agent.EventTypeText,
				Content: "Hello World",
			}},
		},
		{
			name:     "assistant message with empty content",
			input:    `{"type":"assistant","message":{"content":[]}}`,
			expected: nil,
		},
		{
			name:  "assistant tool_use message",
			input: `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_123","name":"Read","input":{"file":"test.go"}}]}}`,
			expected: []agent.AgentEvent{{
				Type:      agent.EventTypeToolCall,
				ToolUseID: "toolu_123",
				ToolName:  "Read",
				ToolInput: json.RawMessage(`{"file":"test.go"}`),
			}},
		},
		{
			name:  "assistant text and tool_use in same message",
			input: `{"type":"assistant","message":{"content":[{"type":"text","text":"I will read the file"},{"type":"tool_use","id":"toolu_456","name":"Read","input":{"path":"main.go"}}]}}`,
			expected: []agent.AgentEvent{
				{
					Type:    agent.EventTypeText,
					Content: "I will read the file",
				},
				{
					Type:      agent.EventTypeToolCall,
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
				{
					Type:      agent.EventTypeToolCall,
					ToolUseID: "toolu_1",
					ToolName:  "Read",
					ToolInput: json.RawMessage(`{"path":"a.go"}`),
				},
				{
					Type:      agent.EventTypeToolCall,
					ToolUseID: "toolu_2",
					ToolName:  "Read",
					ToolInput: json.RawMessage(`{"path":"b.go"}`),
				},
			},
		},
		{
			name:  "user tool_result with string content",
			input: `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_123","content":"file contents here"}]}}`,
			expected: []agent.AgentEvent{{
				Type:       agent.EventTypeToolResult,
				ToolUseID:  "toolu_123",
				ToolResult: "file contents here",
			}},
		},
		{
			name:  "user tool_result with array content",
			input: `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_img","content":[{"type":"image","source":{"type":"base64","data":"..."}},{"type":"text","text":"description"}]}]}}`,
			expected: []agent.AgentEvent{{
				Type:       agent.EventTypeToolResult,
				ToolUseID:  "toolu_img",
				ToolResult: `[{"type":"image","source":{"type":"base64","data":"..."}},{"type":"text","text":"description"}]`,
			}},
		},
		{
			name:  "user multiple tool_results (parallel tool results)",
			input: `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"result 1"},{"type":"tool_result","tool_use_id":"toolu_2","content":"result 2"}]}}`,
			expected: []agent.AgentEvent{
				{
					Type:       agent.EventTypeToolResult,
					ToolUseID:  "toolu_1",
					ToolResult: "result 1",
				},
				{
					Type:       agent.EventTypeToolResult,
					ToolUseID:  "toolu_2",
					ToolResult: "result 2",
				},
			},
		},
		{
			name:  "user event with invalid message falls back to raw text",
			input: `{"type":"user","message":"invalid message format"}`,
			expected: []agent.AgentEvent{{
				Type:    agent.EventTypeText,
				Content: `"invalid message format"`,
			}},
		},
		{
			name:  "unknown event type falls back to raw text",
			input: `{"type":"unknown_event"}`,
			expected: []agent.AgentEvent{{
				Type:    agent.EventTypeText,
				Content: `{"type":"unknown_event"}`,
			}},
		},
		{
			name:  "control_request permission request",
			input: `{"type":"control_request","request_id":"req-123","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"ruby --version"},"tool_use_id":"toolu_abc"}}`,
			expected: []agent.AgentEvent{{
				Type:      agent.EventTypePermissionRequest,
				RequestID: "req-123",
				ToolName:  "Bash",
				ToolInput: json.RawMessage(`{"command":"ruby --version"}`),
				ToolUseID: "toolu_abc",
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
			name:     "control_response ignored",
			input:    `{"type":"control_response","response":{"subtype":"success","request_id":"abc123"}}`,
			expected: nil,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			pendingRequests := &sync.Map{}
			results := parseLine([]byte(tt.input), pendingRequests)

			if !reflect.DeepEqual(results, tt.expected) {
				t.Errorf("expected %+v, got %+v", tt.expected, results)
			}
		})
	}
}

func TestParseControlRequest_StoresPendingRequest(t *testing.T) {
	pendingRequests := &sync.Map{}

	input := `{"type":"control_request","request_id":"req-789","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"ls"},"tool_use_id":"toolu_xyz"}}`
	results := parseLine([]byte(input), pendingRequests)

	if len(results) != 1 {
		t.Fatalf("expected 1 result, got %d", len(results))
	}

	// Verify request is stored in pending map
	stored, ok := pendingRequests.Load("req-789")
	if !ok {
		t.Fatal("expected pending request to be stored")
	}

	req := stored.(*controlRequest)
	if req.RequestID != "req-789" {
		t.Errorf("expected request_id 'req-789', got %q", req.RequestID)
	}
	if req.Request.ToolName != "Bash" {
		t.Errorf("expected tool_name 'Bash', got %q", req.Request.ToolName)
	}
	if req.Request.ToolUseID != "toolu_xyz" {
		t.Errorf("expected tool_use_id 'toolu_xyz', got %q", req.Request.ToolUseID)
	}
}

// nopWriteCloser wraps a Writer to implement WriteCloser
type nopWriteCloser struct {
	*bytes.Buffer
}

func (nopWriteCloser) Close() error { return nil }

func TestSession_SendPermissionResponse_Allow(t *testing.T) {
	var buf bytes.Buffer
	pendingRequests := &sync.Map{}

	// Store a pending request
	req := &controlRequest{
		RequestID: "req-perm-123",
		Request: &permissionData{
			ToolUseID: "toolu_perm",
			Input:     json.RawMessage(`{"command":"ls"}`),
		},
	}
	pendingRequests.Store("req-perm-123", req)

	sess := &session{
		stdin:           nopWriteCloser{&buf},
		pendingRequests: pendingRequests,
	}

	err := sess.SendPermissionResponse("req-perm-123", agent.PermissionAllow)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Verify request was removed from pending
	if _, ok := pendingRequests.Load("req-perm-123"); ok {
		t.Error("expected pending request to be removed")
	}

	// Verify response was written
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
	pendingRequests := &sync.Map{}

	req := &controlRequest{
		RequestID: "req-deny-456",
		Request: &permissionData{
			ToolUseID: "toolu_deny",
		},
	}
	pendingRequests.Store("req-deny-456", req)

	sess := &session{
		stdin:           nopWriteCloser{&buf},
		pendingRequests: pendingRequests,
	}

	err := sess.SendPermissionResponse("req-deny-456", agent.PermissionDeny)
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

func TestSession_SendPermissionResponse_InvalidRequestID(t *testing.T) {
	var buf bytes.Buffer
	pendingRequests := &sync.Map{}

	sess := &session{
		stdin:           nopWriteCloser{&buf},
		pendingRequests: pendingRequests,
	}

	err := sess.SendPermissionResponse("non-existent-id", agent.PermissionAllow)
	if err == nil {
		t.Fatal("expected error for non-existent request ID")
	}
	if err.Error() != "no pending request for id: non-existent-id" {
		t.Errorf("unexpected error message: %v", err)
	}
}

func TestSession_SendPermissionResponse_AlwaysAllow(t *testing.T) {
	var buf bytes.Buffer
	pendingRequests := &sync.Map{}

	// Store a pending request with permission suggestions
	suggestions := []agent.PermissionUpdate{
		json.RawMessage(`{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"npm install *"}],"behavior":"allow","destination":"localSettings"}`),
	}
	req := &controlRequest{
		RequestID: "req-always-789",
		Request: &permissionData{
			ToolUseID:             "toolu_always",
			Input:                 json.RawMessage(`{"command":"npm install lodash"}`),
			PermissionSuggestions: suggestions,
		},
	}
	pendingRequests.Store("req-always-789", req)

	sess := &session{
		stdin:           nopWriteCloser{&buf},
		pendingRequests: pendingRequests,
	}

	err := sess.SendPermissionResponse("req-always-789", agent.PermissionAlwaysAllow)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Verify response was written with updatedPermissions
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
	sess := &session{
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
