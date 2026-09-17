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
	// EventTypeToolActivity reports what a tool call that has not returned is
	// doing right now. The only event Pockode broadcasts without recording;
	// see Persisted.
	EventTypeToolActivity EventType = "tool_activity"
	// EventTypeBackgroundWait says the turn has been parked on work that
	// outlives the tool call that started it. See BackgroundWaitEvent.
	EventTypeBackgroundWait EventType = "background_wait"
)

// Persisted returns true for the events that belong in session history.
//
// A denylist, unlike the other three predicates, because the default is the
// safe one here: an event says what was true at one moment, and that stays
// true, so a new type left unnamed is recorded rather than lost.
//
// The exception is an event that reports the *latest value* of something still
// changing. A snapshot of that in a transcript becomes a lie the moment the
// next one arrives — the same argument that keeps token usage out of the event
// stream (docs/agent-event.md). An unpersisted event reaches subscribers with
// no sequence number (session.NoHistorySeq), because there is no record for one
// to name.
func (e EventType) Persisted() bool {
	return e != EventTypeToolActivity
}

// AwaitsUserInput returns true for the events after which the agent produces
// nothing until someone acts: the three that end a turn and the two that block
// it on a person.
//
// - done: AI completed its response
// - error: fatal error occurred (e.g., CLI crash)
// - interrupted: user interrupted the AI
// - permission_request: AI is asking for permission (user action required)
// - ask_user_question: AI is asking a question (user action required)
//
// It no longer decides what the turn becomes — session.ReduceTurn does, and it
// tells these five apart because they do not all mean the same thing there. What
// is left of this predicate is the question they do share: the two callers ask
// it to refresh the session's timestamp, and to disarm a background wait that
// an ending has overtaken.
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
// turn is under way. They say the turn is alive; they do not say the agent has
// contributed anything to it.
//
// It is a whitelist for what it keeps *out*, not for what it lets in. A type
// wrongly listed here is inert: it becomes session.SignalNoise, which moves no
// turn at all, so the claim "this only arrives mid-turn" is one the reducer no
// longer has to take on trust. That was not always so — noise used to open a
// turn, and the startup warning Codex emits for a session it cannot resume
// stranded one as `running` with nothing running — and the fix was to stop the
// signal from being able to do that rather than to keep this list perfect.
//
// What the list still decides is the boundary with ActivatesSession below, where
// being wrong is expensive in both directions, and that is where the care
// belongs.
//
// Excluded, and why they are not oversights: AwaitsUserInput events end or block
// the turn, so they drive those transitions instead (the two predicates never
// overlap); request_cancelled and process_ended likewise have signals of their
// own, named in process.turnInputFor before this predicate is ever asked; and a
// warning is how a session-level problem is reported, which can happen before
// the first message ever goes out. The remaining types are only ever replayed
// from history, never streamed.
//
// System and tool_activity events belong here but not in ActivatesSession, and
// the gap between the two predicates is exactly the set that must *not* end a
// background wait: the background task list changing is a `system` frame, so
// counting it would make a task finishing look like the turn coming back (see
// process.turnInputFor). That gap is this predicate's whole remaining job.
func (e EventType) IndicatesAgentActivity() bool {
	return e == EventTypeSystem || e == EventTypeToolActivity || e.ActivatesSession()
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
	// ProviderMessageID names the part of the agent's own conversation this text
	// came out of, when the agent puts ids on them. See
	// EventRecord.ProviderMessageID.
	ProviderMessageID string
}

func (TextEvent) EventType() EventType { return EventTypeText }
func (TextEvent) isAgentEvent()        {}

func (e TextEvent) ToRecord() EventRecord {
	return EventRecord{Type: e.EventType(), Content: e.Content, ProviderMessageID: e.ProviderMessageID}
}

type ToolCallEvent struct {
	ToolName  string
	ToolInput json.RawMessage
	ToolUseID string
	// ProviderMessageID names the part of the agent's own conversation this call
	// came out of, when the agent puts ids on them. See
	// EventRecord.ProviderMessageID.
	ProviderMessageID string
}

func (ToolCallEvent) EventType() EventType { return EventTypeToolCall }
func (ToolCallEvent) isAgentEvent()        {}

func (e ToolCallEvent) ToRecord() EventRecord {
	return EventRecord{
		Type:              e.EventType(),
		ToolName:          e.ToolName,
		ToolInput:         e.ToolInput,
		ToolUseID:         e.ToolUseID,
		ProviderMessageID: e.ProviderMessageID,
	}
}

// Subtypes a tool_result event can carry. An absent subtype is the ordinary
// case: the result is the whole of what the call produced, and it is what the
// agent read.
const (
	// ToolResultBackgroundStarted marks a result that is only a placeholder —
	// the call handed work to something that outlives it, and the real outcome
	// arrives later as ToolResultBackgroundResult. Recorded rather than tracked
	// live because "this call handed back a placeholder" stays true forever, and
	// without it a replayed transcript shows unfinished background work as
	// successfully completed.
	ToolResultBackgroundStarted = "background_started"
	// ToolResultBackgroundResult marks the real outcome of that work. The
	// subtype is what keeps the record honest: the agent never read this, it
	// read the placeholder.
	ToolResultBackgroundResult = "background_result"
	// ToolResultBackgroundLost marks an outcome Pockode wrote itself: the CLI
	// process ended while the work was still running, so no outcome was ever
	// reported and none is coming. Kept apart from ToolResultBackgroundResult
	// because the two have different authors — that one is what the CLI said,
	// this one is what Pockode observed of a process it killed or watched die.
	// Wearing the same subtype would claim the agent's own tooling reported an
	// ending it never did.
	ToolResultBackgroundLost = "background_lost"
)

type ToolResultEvent struct {
	ToolUseID  string
	ToolResult string
	// Subtype marks a result that is not simply "what the call produced"; see
	// the ToolResultBackground* constants. Empty for every ordinary result.
	Subtype string
	// DurationMs is how long the call took, when the agent CLI reports it as a
	// figure. Zero when it does not (Claude reports none), which is why it is
	// not inferred from arrival times: a replayed record has no honest one.
	DurationMs int64
	// ExitCode is the process exit status of a command the agent ran, when the
	// CLI reports it separately from the result text. Nil for every tool that is
	// not a command, and for a command that never ran.
	ExitCode *int
	// Contents is the result cut into blocks, set only when the agent returned
	// something that is not prose — an image, a file. A result that is all text
	// leaves it nil and travels in ToolResult alone, which is every result
	// recorded before this field existed and still the overwhelming majority.
	//
	// When it is set it holds the whole result, text blocks included, in the
	// agent's own order, and ToolResult is empty: splitting the prose off into
	// the other field would lose where it sat relative to the files.
	Contents []ContentBlock
	// IsError reports that the tool call failed. Best-effort: only set when the
	// agent CLI says so, never inferred from the result text.
	IsError bool
	// ProviderMessageID names the part of the agent's own conversation this
	// result came out of, when the agent puts ids on them. See
	// EventRecord.ProviderMessageID.
	ProviderMessageID string
}

func (ToolResultEvent) EventType() EventType { return EventTypeToolResult }
func (ToolResultEvent) isAgentEvent()        {}

func (e ToolResultEvent) ToRecord() EventRecord {
	return EventRecord{
		Type:              e.EventType(),
		ToolUseID:         e.ToolUseID,
		ToolResult:        e.ToolResult,
		Subtype:           e.Subtype,
		DurationMs:        e.DurationMs,
		ExitCode:          e.ExitCode,
		Contents:          e.Contents,
		IsError:           e.IsError,
		ProviderMessageID: e.ProviderMessageID,
	}
}

// ToolActivityEvent reports what a tool call that has not returned yet is
// doing. It is broadcast and never recorded (EventType.Persisted), so a client
// that was not listening at the time has missed it — which is why a process
// also keeps the newest Activity of every call still in flight, to hand to a
// client that subscribes mid-run.
type ToolActivityEvent struct {
	// ToolUseID is the call this is about. An activity that cannot be joined to
	// one is dropped by the adapter rather than sent: a progress line with no
	// call behind it says something is happening without saying what asked for
	// it, which is worse than silence.
	ToolUseID string
	// Activity is the CLI's own one-line description of what the call is doing
	// now. A latest value, not an increment: each one replaces the last.
	Activity string
	// OutputDelta is the next chunk of output the call has produced, for the
	// engines that stream one. Unlike Activity it accumulates, and it is safe to
	// lose: the whole output arrives again with the result.
	OutputDelta string
}

func (ToolActivityEvent) EventType() EventType { return EventTypeToolActivity }
func (ToolActivityEvent) isAgentEvent()        {}

func (e ToolActivityEvent) ToRecord() EventRecord {
	return EventRecord{
		Type:        e.EventType(),
		ToolUseID:   e.ToolUseID,
		Activity:    e.Activity,
		OutputDelta: e.OutputDelta,
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

// CancelReason says why a prompt stopped waiting for its answer, for the two
// records that can report it — a request cancelled, and a request that expired
// with the process that raised it. One field for both, because "why did this
// stop waiting for me" is one question.
//
// Only ReasonWorkClosed is produced today; the other two are the shapes the
// session layer already has cases for, and the client's copy for them lands
// with the code that fills them in.
type CancelReason string

const (
	// ReasonProcessEnded is the process that raised the prompt going away —
	// reaped, crashed, or killed with the server.
	ReasonProcessEnded CancelReason = "process_ended"
	// ReasonTimeout is the answer lease running out (see session.LeaseAnswer).
	ReasonTimeout CancelReason = "timeout"
	// ReasonWorkClosed is the work above the session having been closed. Nobody
	// is coming back to answer, so the prompt is withdrawn rather than left
	// pending forever — and unlike the other two this one is a fact about the
	// work layer, which is why the work engine is what produces it.
	ReasonWorkClosed CancelReason = "work_closed"
)

type RequestCancelledEvent struct {
	RequestID string
	// Reason is empty when the agent itself withdrew the request: the CLI said
	// it no longer needs an answer and did not say why, and inventing one would
	// be worse than saying nothing.
	Reason CancelReason
}

func (RequestCancelledEvent) EventType() EventType { return EventTypeRequestCancelled }
func (RequestCancelledEvent) isAgentEvent()        {}

func (e RequestCancelledEvent) ToRecord() EventRecord {
	return EventRecord{Type: e.EventType(), RequestID: e.RequestID, Reason: e.Reason}
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

// BackgroundWaitEvent says the turn is parked: the CLI ended it with an
// ordinary result frame, but work it started outlives that frame and it will
// resume output by itself when that work finishes.
//
// It exists because the alternative was tried. The adapter used to swallow the
// CLI's pseudo-ending so the wait read as one long thought, and the cost was
// that every surface drew a running turn — spinner, Stop button, a work item
// reported as in progress — for up to two hours of nothing. Saying it outright
// is what lets session.ReduceTurn park the turn on a blocker instead, and what
// lets the transcript show the wait where it happened.
//
// Recorded, like any other event: that the turn was parked at this point stays
// true afterwards. Nothing about the tasks themselves is carried, because that
// is live state — see backgroundTaskTracker, which is deliberately never
// written into a record.
type BackgroundWaitEvent struct{}

func (BackgroundWaitEvent) EventType() EventType { return EventTypeBackgroundWait }
func (BackgroundWaitEvent) isAgentEvent()        {}

func (e BackgroundWaitEvent) ToRecord() EventRecord {
	return EventRecord{Type: e.EventType()}
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

// ChildInfo identifies the child work a system message reports on: the one that
// closed (child_done), or the one whose leaving left its parent's wait with
// nothing that could end it (wait_stranded).
type ChildInfo struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}

// MessageMeta carries summary data for a system-origin message so the frontend
// can render it without parsing the prompt body.
type MessageMeta struct {
	// WorkID is the work that owns the session this message was delivered to —
	// the receiver, never the subject. A message about a child is delivered to
	// the parent's session, so its WorkID is the parent's. The frontend opens this
	// work from the message; a subject id here would send the reader somewhere
	// the message was never delivered.
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
