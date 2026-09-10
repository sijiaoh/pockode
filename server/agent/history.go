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
	IsError               bool               `json:"is_error,omitempty"`
	Error                 string             `json:"error,omitempty"`
	Message               string             `json:"message,omitempty"`
	Code                  string             `json:"code,omitempty"`
	RequestID             string             `json:"request_id,omitempty"`
	PermissionSuggestions []PermissionUpdate `json:"permission_suggestions,omitempty"`
	Questions             []AskUserQuestion  `json:"questions,omitempty"`
	Choice                string             `json:"choice,omitempty"`
	Answers               map[string]string  `json:"answers,omitempty"`
	Origin                MessageOrigin      `json:"origin,omitempty"`
	Subtype               string             `json:"subtype,omitempty"`
	Meta                  *MessageMeta       `json:"meta,omitempty"`
	// ProviderMessageID is the agent's own id for the message this event was
	// parsed out of, when the agent hands one out. It is a fact the event
	// arrived with, not Pockode state, which is why it is recorded here rather
	// than tracked alongside the session.
	//
	// It exists so a fork can name the point it was cut at in the agent's own
	// terms: Pockode's history sequence means nothing to a CLI, and one message
	// of the agent's can produce several records here (an assistant turn with
	// text and a tool call), so position cannot be recovered from the records
	// either. Empty for events with no message behind them (a warning Pockode
	// raised itself), for agents that expose no ids, and for every record
	// written before this field existed.
	ProviderMessageID string `json:"provider_message_id,omitempty"`
}

// NewEventRecord creates an EventRecord from an AgentEvent.
func NewEventRecord(event AgentEvent) EventRecord {
	return event.ToRecord()
}
