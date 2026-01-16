package agent

import "encoding/json"

// HistoryRecord wraps an AgentEvent for JSON serialization with a type field.
// This is used for persisting events to history storage.
type HistoryRecord struct {
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

// NewHistoryRecord creates a HistoryRecord from an AgentEvent.
func NewHistoryRecord(event AgentEvent) HistoryRecord {
	r := HistoryRecord{Type: event.EventType()}

	switch e := event.(type) {
	case TextEvent:
		r.Content = e.Content
	case ToolCallEvent:
		r.ToolName = e.ToolName
		r.ToolInput = e.ToolInput
		r.ToolUseID = e.ToolUseID
	case ToolResultEvent:
		r.ToolUseID = e.ToolUseID
		r.ToolResult = e.ToolResult
	case WarningEvent:
		r.Message = e.Message
		r.Code = e.Code
	case ErrorEvent:
		r.Error = e.Error
	case PermissionRequestEvent:
		r.RequestID = e.RequestID
		r.ToolName = e.ToolName
		r.ToolInput = e.ToolInput
		r.ToolUseID = e.ToolUseID
		r.PermissionSuggestions = e.PermissionSuggestions
	case RequestCancelledEvent:
		r.RequestID = e.RequestID
	case AskUserQuestionEvent:
		r.RequestID = e.RequestID
		r.ToolUseID = e.ToolUseID
		r.Questions = e.Questions
	case SystemEvent:
		r.Content = e.Content
	case MessageEvent:
		r.Content = e.Content
	case CommandOutputEvent:
		r.Content = e.Content
	case PermissionResponseEvent:
		r.RequestID = e.RequestID
		r.Choice = e.Choice
	case QuestionResponseEvent:
		r.RequestID = e.RequestID
		r.Answers = e.Answers
		// DoneEvent, InterruptedEvent, ProcessEndedEvent have no additional fields
	}

	return r
}
