package agent

import "encoding/json"

// EventType defines the type of agent event.
type EventType string

const (
	EventTypeText              EventType = "text"
	EventTypeToolCall          EventType = "tool_call"
	EventTypeToolResult        EventType = "tool_result"
	EventTypeError             EventType = "error"
	EventTypeDone              EventType = "done"
	EventTypeSession           EventType = "session"
	EventTypePermissionRequest EventType = "permission_request"
)

// AgentEvent represents a unified event from an AI agent.
//
// For required fields per event type, see requireFields() in
// agent/claude/claude_integration_test.go (serves as schema documentation).
type AgentEvent struct {
	Type       EventType       `json:"type"`
	Content    string          `json:"content,omitempty"`
	ToolName   string          `json:"tool_name,omitempty"`
	ToolInput  json.RawMessage `json:"tool_input,omitempty"`
	ToolUseID  string          `json:"tool_use_id,omitempty"`
	ToolResult string          `json:"tool_result,omitempty"`
	Error      string          `json:"error,omitempty"`
	SessionID  string          `json:"session_id,omitempty"`
	// Permission request fields
	RequestID string `json:"request_id,omitempty"`
}
