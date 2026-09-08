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

// IndicatesAgentActivity returns true for the events that only arrive while a
// turn is under way. These move the process state to running.
//
// It is a whitelist because being wrong is not symmetric. An event wrongly
// counted as activity marks a session running with nothing running, and nothing
// corrects that until the idle reaper collects the process hours later — the
// startup warning Codex emits for a session it cannot resume did exactly that.
// An event wrongly left out costs at most one missed transition, because the
// send that started the turn has already set running.
//
// Excluded, and why they are not oversights: AwaitsUserInput events end or pause
// the turn, so they drive idle instead (the two predicates never overlap);
// warning is how a session-level problem is reported, which can happen before the
// first message; request_cancelled withdraws a prompt the user may never have
// answered, so the process is likely idle already; process_ended is an obituary.
// The remaining types are only ever replayed from history, never streamed.
//
// System events belong here but not in ActivatesSession: they only appear once a
// turn is running, yet they are not the agent contributing anything to it.
func (e EventType) IndicatesAgentActivity() bool {
	return e == EventTypeSystem || e.ActivatesSession()
}

// ActivatesSession returns true for the events that put something on the agent's
// side of the conversation, which is what makes a session "started": there is now
// context that switching backends would throw away.
//
// Narrower than IndicatesAgentActivity on purpose. That predicate answers "is a
// turn under way", and a turn can be under way from start to finish without the
// agent ever contributing to it: a first message sent through an expired login or
// a dead endpoint gets an init, a stream of system/api_retry, the CLI's own
// account of the failure, and a result flagged as an error — every one of them
// produced without the model being reached (measured on claude 2.1.259 against a
// refused port and against a local endpoint answering 401). Note the result frame
// carries subtype "success" and reports the failure through is_error, so look at
// the flag rather than the subtype when reproducing this. Treating the turn as a
// started session would lock it to the agent that just failed, which is the one
// situation where being able to switch agents is the only way out.
//
// That the CLI's account of the failure lands outside this set is not automatic.
// Claude delivers it as an assistant message, and only claude.syntheticNotice
// keeping those off the text path stops it from starting the session here.
//
// The bias here is the opposite of IndicatesAgentActivity's: counting an event
// too eagerly costs the user their escape hatch, while missing one only leaves a
// session switchable slightly longer than it should be, until the agent's next
// output. The borderline cases (a local command's output, output we could not
// parse) are in anyway, despite that bias: neither can come from a turn that
// failed to start, so including them cannot cost anyone the escape hatch.
func (e EventType) ActivatesSession() bool {
	switch e {
	case EventTypeText, EventTypeToolCall, EventTypeToolResult,
		EventTypeCommandOutput, EventTypeRaw:
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
	// IsError reports that the tool call failed. Best-effort: only set when the
	// agent CLI says so, never inferred from the result text.
	IsError bool
}

func (ToolResultEvent) EventType() EventType { return EventTypeToolResult }
func (ToolResultEvent) isAgentEvent()        {}

func (e ToolResultEvent) ToRecord() EventRecord {
	return EventRecord{
		Type:       e.EventType(),
		ToolUseID:  e.ToolUseID,
		ToolResult: e.ToolResult,
		IsError:    e.IsError,
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

// MessageOrigin distinguishes who produced a message event.
// An empty value (default) means a user-typed message, kept empty for
// backward compatibility with history recorded before this field existed.
type MessageOrigin string

const (
	MessageOriginUser MessageOrigin = "user"
	// MessageOriginSystem marks a message produced by Pockode itself rather
	// than typed by the user. The work engine is the current producer; other
	// system sources may emit these in the future.
	MessageOriginSystem MessageOrigin = "system"
)

// StepInfo is a 1-indexed step position carried by a system message's summary.
type StepInfo struct {
	Current int `json:"current"`
	Total   int `json:"total"`
}

// ChildInfo identifies the child work whose completion triggered a child_done
// system message.
type ChildInfo struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}

// MessageMeta carries summary data for a system-origin message so the frontend
// can render it without parsing the prompt body.
type MessageMeta struct {
	// WorkID is the work that owns the session this message was delivered to —
	// the receiver, never the subject. A child_done message is delivered to the
	// parent's session, so its WorkID is the parent's. The frontend groups
	// messages by this key into one card per work; a subject id here would
	// shatter that card.
	WorkID string `json:"work_id,omitempty"`
	// WorkType is the receiving work's type ("story" or "task").
	WorkType string `json:"work_type,omitempty"`
	Title    string `json:"title,omitempty"`
	// Step is where the work stood when this message was sent — a historical
	// fact, not a live position. See docs/code/work-system.md.
	Step  *StepInfo  `json:"step,omitempty"`
	Child *ChildInfo `json:"child,omitempty"`
}

// MessageEvent represents a message sent to the agent. Used for:
// - History replay: reconstructing past messages
// - Broadcast: notifying other clients when a message is sent
//
// Origin distinguishes user-typed messages (empty/"user") from system-driven
// automatic messages ("system"); Subtype and Meta describe the latter.
type MessageEvent struct {
	Content string
	Origin  MessageOrigin
	Subtype string
	Meta    *MessageMeta
}

func (MessageEvent) EventType() EventType { return EventTypeMessage }
func (MessageEvent) isAgentEvent()        {}

func (e MessageEvent) ToRecord() EventRecord {
	return EventRecord{
		Type:    e.EventType(),
		Content: e.Content,
		Origin:  e.Origin,
		Subtype: e.Subtype,
		Meta:    e.Meta,
	}
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
