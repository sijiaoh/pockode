package agent

import "encoding/json"

// EventRecord is the serialized form of an AgentEvent.
// Used for persistence (history storage) and notifications (WebSocket).
type EventRecord struct {
	Type                  EventType          `json:"type"`
	Content               string             `json:"content,omitempty"`
	ToolName              string             `json:"tool_name,omitempty"`
	ToolInput             json.RawMessage    `json:"tool_input,omitempty"`
	ToolUseID             string             `json:"tool_use_id,omitempty"`
	ToolResult            string             `json:"tool_result,omitempty"`
	Error                 string             `json:"error,omitempty"`
	Message               string             `json:"message,omitempty"`
	Code                  string             `json:"code,omitempty"`
	RequestID             string             `json:"request_id,omitempty"`
	PermissionSuggestions []PermissionUpdate `json:"permission_suggestions,omitempty"`
	Questions             []AskUserQuestion  `json:"questions,omitempty"`
	Choice                string             `json:"choice,omitempty"`
	Answers               map[string]string  `json:"answers,omitempty"`
}

// NewEventRecord creates an EventRecord from an AgentEvent.
func NewEventRecord(event AgentEvent) EventRecord {
	return event.ToRecord()
}
