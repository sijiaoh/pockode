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
	EventTypeRequestCancelled  EventType = "request_cancelled"
	EventTypeAskUserQuestion   EventType = "ask_user_question"
	EventTypeSystem            EventType = "system"
	EventTypeProcessEnded      EventType = "process_ended"
)

// PermissionBehavior represents the permission action.
type PermissionBehavior string

const (
	PermissionBehaviorAllow PermissionBehavior = "allow"
	PermissionBehaviorDeny  PermissionBehavior = "deny"
	PermissionBehaviorAsk   PermissionBehavior = "ask"
)

// PermissionUpdateDestination represents where the permission update is stored.
type PermissionUpdateDestination string

const (
	PermissionDestinationUserSettings    PermissionUpdateDestination = "userSettings"
	PermissionDestinationProjectSettings PermissionUpdateDestination = "projectSettings"
	PermissionDestinationLocalSettings   PermissionUpdateDestination = "localSettings"
	PermissionDestinationSession         PermissionUpdateDestination = "session"
)

// PermissionUpdateType represents the type of permission update.
type PermissionUpdateType string

const (
	PermissionUpdateAddRules          PermissionUpdateType = "addRules"
	PermissionUpdateReplaceRules      PermissionUpdateType = "replaceRules"
	PermissionUpdateRemoveRules       PermissionUpdateType = "removeRules"
	PermissionUpdateSetMode           PermissionUpdateType = "setMode"
	PermissionUpdateAddDirectories    PermissionUpdateType = "addDirectories"
	PermissionUpdateRemoveDirectories PermissionUpdateType = "removeDirectories"
)

// PermissionMode represents the permission mode for setMode updates.
type PermissionMode string

const (
	PermissionModeDefault           PermissionMode = "default"
	PermissionModeAcceptEdits       PermissionMode = "acceptEdits"
	PermissionModeBypassPermissions PermissionMode = "bypassPermissions"
	PermissionModePlan              PermissionMode = "plan"
)

// PermissionRuleValue represents a single permission rule.
type PermissionRuleValue struct {
	ToolName    string `json:"toolName"`
	RuleContent string `json:"ruleContent,omitempty"`
}

// PermissionUpdate represents a permission update operation.
type PermissionUpdate struct {
	Type        PermissionUpdateType        `json:"type"`
	Behavior    PermissionBehavior          `json:"behavior,omitempty"`
	Destination PermissionUpdateDestination `json:"destination"`
	Rules       []PermissionRuleValue       `json:"rules,omitempty"`
	Mode        PermissionMode              `json:"mode,omitempty"`
	Directories []string                    `json:"directories,omitempty"`
}

// QuestionOption represents a single option for a user question.
type QuestionOption struct {
	Label       string `json:"label"`
	Description string `json:"description"`
}

// AskUserQuestion represents a question to ask the user.
type AskUserQuestion struct {
	Question    string           `json:"question"`
	Header      string           `json:"header"`
	Options     []QuestionOption `json:"options"`
	MultiSelect bool             `json:"multiSelect"`
}

// --- AgentEvent: Interface + Individual Types ---

// AgentEvent represents an event from an AI agent.
// Each event type has its own struct with only the relevant fields.
type AgentEvent interface {
	EventType() EventType
	isAgentEvent() // unexported marker method to restrict implementations to this package
}

// TextEvent represents a text output event.
type TextEvent struct {
	Content string
}

func (TextEvent) EventType() EventType { return EventTypeText }
func (TextEvent) isAgentEvent()        {}

// ToolCallEvent represents a tool invocation event.
type ToolCallEvent struct {
	ToolName  string
	ToolInput json.RawMessage
	ToolUseID string
}

func (ToolCallEvent) EventType() EventType { return EventTypeToolCall }
func (ToolCallEvent) isAgentEvent()        {}

// ToolResultEvent represents a tool result event.
type ToolResultEvent struct {
	ToolUseID  string
	ToolResult string
}

func (ToolResultEvent) EventType() EventType { return EventTypeToolResult }
func (ToolResultEvent) isAgentEvent()        {}

// ErrorEvent represents an error event.
type ErrorEvent struct {
	Error string
}

func (ErrorEvent) EventType() EventType { return EventTypeError }
func (ErrorEvent) isAgentEvent()        {}

// DoneEvent signals that the current message response is complete.
type DoneEvent struct{}

func (DoneEvent) EventType() EventType { return EventTypeDone }
func (DoneEvent) isAgentEvent()        {}

// InterruptedEvent signals that the agent was interrupted.
type InterruptedEvent struct{}

func (InterruptedEvent) EventType() EventType { return EventTypeInterrupted }
func (InterruptedEvent) isAgentEvent()        {}

// PermissionRequestEvent represents a permission request from the agent.
type PermissionRequestEvent struct {
	RequestID             string
	ToolName              string
	ToolInput             json.RawMessage
	ToolUseID             string
	PermissionSuggestions []PermissionUpdate
}

func (PermissionRequestEvent) EventType() EventType { return EventTypePermissionRequest }
func (PermissionRequestEvent) isAgentEvent()        {}

// RequestCancelledEvent signals that a pending request was cancelled.
type RequestCancelledEvent struct {
	RequestID string
}

func (RequestCancelledEvent) EventType() EventType { return EventTypeRequestCancelled }
func (RequestCancelledEvent) isAgentEvent()        {}

// AskUserQuestionEvent represents a question event from the agent.
type AskUserQuestionEvent struct {
	RequestID string
	ToolUseID string
	Questions []AskUserQuestion
}

func (AskUserQuestionEvent) EventType() EventType { return EventTypeAskUserQuestion }
func (AskUserQuestionEvent) isAgentEvent()        {}

// SystemEvent represents a system message event.
type SystemEvent struct {
	Content string
}

func (SystemEvent) EventType() EventType { return EventTypeSystem }
func (SystemEvent) isAgentEvent()        {}

// ProcessEndedEvent signals that the agent process has ended.
type ProcessEndedEvent struct{}

func (ProcessEndedEvent) EventType() EventType { return EventTypeProcessEnded }
func (ProcessEndedEvent) isAgentEvent()        {}

// --- ServerMessage: For WebSocket communication ---

// ServerMessage represents a message sent from the server to the client.
// This is the canonical type used for WebSocket communication and history persistence.
type ServerMessage struct {
	Type                  EventType          `json:"type"`
	SessionID             string             `json:"session_id,omitempty"`
	Content               string             `json:"content,omitempty"`
	ToolName              string             `json:"tool_name,omitempty"`
	ToolInput             json.RawMessage    `json:"tool_input,omitempty"`
	ToolUseID             string             `json:"tool_use_id,omitempty"`
	ToolResult            string             `json:"tool_result,omitempty"`
	Error                 string             `json:"error,omitempty"`
	RequestID             string             `json:"request_id,omitempty"`
	PermissionSuggestions []PermissionUpdate `json:"permission_suggestions,omitempty"`
	Questions             []AskUserQuestion  `json:"questions,omitempty"`
	ProcessRunning        bool               `json:"process_running"`
	Success               bool               `json:"success,omitempty"`
}

// NewServerMessage creates a ServerMessage from an AgentEvent.
func NewServerMessage(sessionID string, event AgentEvent) ServerMessage {
	msg := ServerMessage{
		Type:      event.EventType(),
		SessionID: sessionID,
	}

	switch e := event.(type) {
	case TextEvent:
		msg.Content = e.Content
	case ToolCallEvent:
		msg.ToolName = e.ToolName
		msg.ToolInput = e.ToolInput
		msg.ToolUseID = e.ToolUseID
	case ToolResultEvent:
		msg.ToolUseID = e.ToolUseID
		msg.ToolResult = e.ToolResult
	case ErrorEvent:
		msg.Error = e.Error
	case PermissionRequestEvent:
		msg.RequestID = e.RequestID
		msg.ToolName = e.ToolName
		msg.ToolInput = e.ToolInput
		msg.ToolUseID = e.ToolUseID
		msg.PermissionSuggestions = e.PermissionSuggestions
	case RequestCancelledEvent:
		msg.RequestID = e.RequestID
	case AskUserQuestionEvent:
		msg.RequestID = e.RequestID
		msg.ToolUseID = e.ToolUseID
		msg.Questions = e.Questions
	case SystemEvent:
		msg.Content = e.Content
	}

	return msg
}
