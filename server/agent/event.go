package agent

import "encoding/json"

// EventType defines the type of agent event.
type EventType string

const (
	EventTypeText               EventType = "text"
	EventTypeToolCall           EventType = "tool_call"
	EventTypeToolResult         EventType = "tool_result"
	EventTypeWarning            EventType = "warning"
	EventTypeError              EventType = "error"
	EventTypeDone               EventType = "done"
	EventTypeInterrupted        EventType = "interrupted"
	EventTypePermissionRequest  EventType = "permission_request"
	EventTypeRequestCancelled   EventType = "request_cancelled"
	EventTypeAskUserQuestion    EventType = "ask_user_question"
	EventTypeSystem             EventType = "system"
	EventTypeProcessEnded       EventType = "process_ended"
	EventTypeMessage            EventType = "message"             // User message
	EventTypePermissionResponse EventType = "permission_response" // User permission response
	EventTypeQuestionResponse   EventType = "question_response"   // User question response
	EventTypeRaw                EventType = "raw"                 // Unprocessed CLI output
	EventTypeCommandOutput      EventType = "command_output"      // Local command output (e.g., /context)
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

// AgentEvent represents an event from an AI agent.
// Each event type has its own struct with only the relevant fields.
//
// When adding a new event type:
//   - Add case to NewHistoryRecord in history.go
//   - Add case to NewNotifyParams in rpc/types.go
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

// WarningEvent represents a non-fatal warning (e.g., unsupported content type).
// Unlike ErrorEvent which represents a fatal error, this is displayed inline and the conversation continues.
type WarningEvent struct {
	Message string
	Code    string
}

func (WarningEvent) EventType() EventType { return EventTypeWarning }
func (WarningEvent) isAgentEvent()        {}

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

// MessageEvent represents a user message.
type MessageEvent struct {
	Content string
}

func (MessageEvent) EventType() EventType { return EventTypeMessage }
func (MessageEvent) isAgentEvent()        {}

// PermissionResponseEvent represents a user's response to a permission request.
type PermissionResponseEvent struct {
	RequestID string
	Choice    string // "deny", "allow", "always_allow"
}

func (PermissionResponseEvent) EventType() EventType { return EventTypePermissionResponse }
func (PermissionResponseEvent) isAgentEvent()        {}

// QuestionResponseEvent represents a user's response to a question.
type QuestionResponseEvent struct {
	RequestID string
	Answers   map[string]string // nil = cancelled
}

func (QuestionResponseEvent) EventType() EventType { return EventTypeQuestionResponse }
func (QuestionResponseEvent) isAgentEvent()        {}

// RawEvent represents unprocessed CLI output (JSON preserved as-is).
type RawEvent struct {
	Content string
}

func (RawEvent) EventType() EventType { return EventTypeRaw }
func (RawEvent) isAgentEvent()        {}

// CommandOutputEvent represents local command output (e.g., /context, /help).
type CommandOutputEvent struct {
	Content string
}

func (CommandOutputEvent) EventType() EventType { return EventTypeCommandOutput }
func (CommandOutputEvent) isAgentEvent()        {}
