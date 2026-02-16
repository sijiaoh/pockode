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

// AwaitsUserInput returns true for events where the AI pauses and waits for user input.
// These events transition the process state from running to idle:
// - done: AI completed its response
// - error: fatal error occurred (e.g., CLI crash)
// - interrupted: user interrupted the AI (updates session timestamp)
// - permission_request: AI is asking for permission (user action required)
// - ask_user_question: AI is asking a question (user action required)
func (e EventType) AwaitsUserInput() bool {
	switch e {
	case EventTypeDone, EventTypeError, EventTypeInterrupted,
		EventTypePermissionRequest, EventTypeAskUserQuestion:
		return true
	default:
		return false
	}
}

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
// When adding a new event type, implement all interface methods.
// The compiler will enforce completeness - no need to update switch statements elsewhere.
type AgentEvent interface {
	EventType() EventType

	// ToRecord converts the event to an EventRecord for persistence and notification.
	// EventRecord is the single source of truth for event serialization.
	ToRecord() EventRecord

	isAgentEvent() // unexported marker method to restrict implementations to this package
}

type TextEvent struct {
	Content string
}

func (TextEvent) EventType() EventType { return EventTypeText }
func (TextEvent) isAgentEvent()        {}

func (e TextEvent) ToRecord() EventRecord {
	return EventRecord{Type: e.EventType(), Content: e.Content}
}

type ToolCallEvent struct {
	ToolName  string
	ToolInput json.RawMessage
	ToolUseID string
}

func (ToolCallEvent) EventType() EventType { return EventTypeToolCall }
func (ToolCallEvent) isAgentEvent()        {}

func (e ToolCallEvent) ToRecord() EventRecord {
	return EventRecord{
		Type:      e.EventType(),
		ToolName:  e.ToolName,
		ToolInput: e.ToolInput,
		ToolUseID: e.ToolUseID,
	}
}

type ToolResultEvent struct {
	ToolUseID  string
	ToolResult string
}

func (ToolResultEvent) EventType() EventType { return EventTypeToolResult }
func (ToolResultEvent) isAgentEvent()        {}

func (e ToolResultEvent) ToRecord() EventRecord {
	return EventRecord{
		Type:       e.EventType(),
		ToolUseID:  e.ToolUseID,
		ToolResult: e.ToolResult,
	}
}

// WarningEvent represents a non-fatal warning (e.g., unsupported content type).
// Unlike ErrorEvent which represents a fatal error, this is displayed inline and the conversation continues.
type WarningEvent struct {
	Message string
	Code    string
}

func (WarningEvent) EventType() EventType { return EventTypeWarning }
func (WarningEvent) isAgentEvent()        {}

func (e WarningEvent) ToRecord() EventRecord {
	return EventRecord{
		Type:    e.EventType(),
		Message: e.Message,
		Code:    e.Code,
	}
}

type ErrorEvent struct {
	Error string
}

func (ErrorEvent) EventType() EventType { return EventTypeError }
func (ErrorEvent) isAgentEvent()        {}

func (e ErrorEvent) ToRecord() EventRecord {
	return EventRecord{Type: e.EventType(), Error: e.Error}
}

type DoneEvent struct{}

func (DoneEvent) EventType() EventType { return EventTypeDone }
func (DoneEvent) isAgentEvent()        {}

func (e DoneEvent) ToRecord() EventRecord {
	return EventRecord{Type: e.EventType()}
}

type InterruptedEvent struct{}

func (InterruptedEvent) EventType() EventType { return EventTypeInterrupted }
func (InterruptedEvent) isAgentEvent()        {}

func (e InterruptedEvent) ToRecord() EventRecord {
	return EventRecord{Type: e.EventType()}
}

type PermissionRequestEvent struct {
	RequestID             string
	ToolName              string
	ToolInput             json.RawMessage
	ToolUseID             string
	PermissionSuggestions []PermissionUpdate
}

func (PermissionRequestEvent) EventType() EventType { return EventTypePermissionRequest }
func (PermissionRequestEvent) isAgentEvent()        {}

func (e PermissionRequestEvent) ToRecord() EventRecord {
	return EventRecord{
		Type:                  e.EventType(),
		RequestID:             e.RequestID,
		ToolName:              e.ToolName,
		ToolInput:             e.ToolInput,
		ToolUseID:             e.ToolUseID,
		PermissionSuggestions: e.PermissionSuggestions,
	}
}

type RequestCancelledEvent struct {
	RequestID string
}

func (RequestCancelledEvent) EventType() EventType { return EventTypeRequestCancelled }
func (RequestCancelledEvent) isAgentEvent()        {}

func (e RequestCancelledEvent) ToRecord() EventRecord {
	return EventRecord{Type: e.EventType(), RequestID: e.RequestID}
}

type AskUserQuestionEvent struct {
	RequestID string
	ToolUseID string
	Questions []AskUserQuestion
}

func (AskUserQuestionEvent) EventType() EventType { return EventTypeAskUserQuestion }
func (AskUserQuestionEvent) isAgentEvent()        {}

func (e AskUserQuestionEvent) ToRecord() EventRecord {
	return EventRecord{
		Type:      e.EventType(),
		RequestID: e.RequestID,
		ToolUseID: e.ToolUseID,
		Questions: e.Questions,
	}
}

type SystemEvent struct {
	Content string
}

func (SystemEvent) EventType() EventType { return EventTypeSystem }
func (SystemEvent) isAgentEvent()        {}

func (e SystemEvent) ToRecord() EventRecord {
	return EventRecord{Type: e.EventType(), Content: e.Content}
}

type ProcessEndedEvent struct{}

func (ProcessEndedEvent) EventType() EventType { return EventTypeProcessEnded }
func (ProcessEndedEvent) isAgentEvent()        {}

func (e ProcessEndedEvent) ToRecord() EventRecord {
	return EventRecord{Type: e.EventType()}
}

// MessageEvent represents a user message. Used for:
// - History replay: reconstructing past messages
// - Broadcast: notifying other clients when a user sends a message
type MessageEvent struct {
	Content string
}

func (MessageEvent) EventType() EventType { return EventTypeMessage }
func (MessageEvent) isAgentEvent()        {}

func (e MessageEvent) ToRecord() EventRecord {
	return EventRecord{Type: e.EventType(), Content: e.Content}
}

// PermissionResponseEvent is for history replay only, not sent as RPC notification.
type PermissionResponseEvent struct {
	RequestID string
	Choice    string // "deny", "allow", "always_allow"
}

func (PermissionResponseEvent) EventType() EventType { return EventTypePermissionResponse }
func (PermissionResponseEvent) isAgentEvent()        {}

func (e PermissionResponseEvent) ToRecord() EventRecord {
	return EventRecord{
		Type:      e.EventType(),
		RequestID: e.RequestID,
		Choice:    e.Choice,
	}
}

// QuestionResponseEvent is for history replay only, not sent as RPC notification.
type QuestionResponseEvent struct {
	RequestID string
	Answers   map[string]string // nil = cancelled
}

func (QuestionResponseEvent) EventType() EventType { return EventTypeQuestionResponse }
func (QuestionResponseEvent) isAgentEvent()        {}

func (e QuestionResponseEvent) ToRecord() EventRecord {
	return EventRecord{
		Type:      e.EventType(),
		RequestID: e.RequestID,
		Answers:   e.Answers,
	}
}

type RawEvent struct {
	Content string
}

func (RawEvent) EventType() EventType { return EventTypeRaw }
func (RawEvent) isAgentEvent()        {}

func (e RawEvent) ToRecord() EventRecord {
	return EventRecord{Type: e.EventType(), Content: e.Content}
}

type CommandOutputEvent struct {
	Content string
}

func (CommandOutputEvent) EventType() EventType { return EventTypeCommandOutput }
func (CommandOutputEvent) isAgentEvent()        {}

func (e CommandOutputEvent) ToRecord() EventRecord {
	return EventRecord{Type: e.EventType(), Content: e.Content}
}
