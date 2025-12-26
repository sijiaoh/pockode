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
	EventTypeInterrupted       EventType = "interrupted"
	EventTypePermissionRequest EventType = "permission_request"
	EventTypeSystem            EventType = "system"
	EventTypeProcessEnded      EventType = "process_ended"
)

// AgentEvent represents a unified event from an AI agent.
type AgentEvent struct {
	Type       EventType       `json:"type"`
	Content    string          `json:"content,omitempty"`
	ToolName   string          `json:"tool_name,omitempty"`
	ToolInput  json.RawMessage `json:"tool_input,omitempty"`
	ToolUseID  string          `json:"tool_use_id,omitempty"`
	ToolResult string          `json:"tool_result,omitempty"`
	Error      string          `json:"error,omitempty"`
	// Permission request fields
	RequestID string `json:"request_id,omitempty"`
}
