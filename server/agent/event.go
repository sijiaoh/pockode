package agent

import (
	"encoding/json"
	"time"
)

// EventType defines the type of agent event.
type EventType string

const (
	EventTypeText              EventType = "text"
	EventTypeToolCall          EventType = "tool_call"
	EventTypeToolResult        EventType = "tool_result"
	EventTypeWarning           EventType = "warning"
	EventTypeError             EventType = "error"
	EventTypeDone              EventType = "done"
	EventTypeInterrupted       EventType = "interrupted"
	EventTypePermissionRequest EventType = "permission_request"
	EventTypeRequestCancelled  EventType = "request_cancelled"
	// EventTypeAskUserQuestion is read, never written: it is the CLI's own
	// blocking question, which Pockode no longer lets a CLI ask (see
	// agent.CLIQuestionRefusal). Transcripts written before that still hold
	// these, and fork truncation still has to recognise one left unanswered.
	EventTypeAskUserQuestion    EventType = "ask_user_question"
	EventTypeSystem             EventType = "system"
	EventTypeProcessEnded       EventType = "process_ended"
	EventTypeMessage            EventType = "message"             // User message
	EventTypePermissionResponse EventType = "permission_response" // User permission response
	// EventTypeQuestionResponse is read, never written: the answer to an
	// EventTypeAskUserQuestion, from the same transcripts. Only the *type* is read
	// here — fork truncation needs to know such a record settles a request — and
	// the answers it carries are the client's to draw, off the raw record. There
	// is deliberately no field for them on EventRecord: nothing in Go reads them,
	// and replay preserves every field a record has on disk whether this struct
	// knows about it or not (session.stampHistorySeq round-trips through a raw
	// field map). The shape is written down in docs/agent-event.md.
	EventTypeQuestionResponse EventType = "question_response"
	EventTypeRaw              EventType = "raw"            // Unprocessed CLI output
	EventTypeCommandOutput    EventType = "command_output" // Local command output (e.g., /context)
	// EventTypeToolActivity reports what a tool call that has not returned is
	// doing right now. The only event Pockode broadcasts without recording;
	// see Persisted.
	EventTypeToolActivity EventType = "tool_activity"
	// EventTypeBackgroundWait says the turn has been parked on work that
	// outlives the tool call that started it. See BackgroundWaitEvent.
	EventTypeBackgroundWait EventType = "background_wait"
	// EventTypeQuestionPosted is a question an agent handed to Pockode to ask on
	// its behalf. See QuestionPostedEvent.
	EventTypeQuestionPosted EventType = "question_posted"
	// EventTypeMessageIngested says the agent has taken in a message that
	// reached it while it was already working. See MessageIngestedEvent.
	EventTypeMessageIngested EventType = "message_ingested"
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
// nothing until someone acts: the three that end a turn and the one that blocks
// it on a person.
//
// - done: AI completed its response
// - error: fatal error occurred (e.g., CLI crash)
// - interrupted: user interrupted the AI
// - permission_request: AI is asking for permission (user action required)
//
// A question is deliberately not here. The only question an agent can ask now is
// one it posts through question_post, and nothing waits for that answer — the
// turn carries on, and the session's unanswered list holds the question after
// the turn is over.
//
// It no longer decides what the turn becomes — session.ReduceTurn does, and it
// tells these four apart because they do not all mean the same thing there. What
// is left of this predicate is the question they do share: the two callers ask
// it to refresh the session's timestamp, and to disarm a background wait that
// an ending has overtaken.
func (e EventType) AwaitsUserInput() bool {
	switch e {
	case EventTypeDone, EventTypeError, EventTypeInterrupted,
		EventTypePermissionRequest:
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
	// OriginToolUseID names an earlier call this one is about, when the input
	// only identifies it by something Pockode's join key cannot be recovered
	// from. See EventRecord.OriginToolUseID.
	OriginToolUseID string
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
		OriginToolUseID:   e.OriginToolUseID,
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
// Two of the four belong to a permission request and two to a posted question,
// and nothing produces both kinds for one record: a permission request is the
// only thing a process holds open, so it is the only thing that can run out of
// time or die with one, while a posted question belongs to the session and can
// only be withdrawn deliberately.
type CancelReason string

const (
	// ReasonProcessEnded is the process that raised a permission request going
	// away — reaped, crashed, or killed with the server.
	ReasonProcessEnded CancelReason = "process_ended"
	// ReasonTimeout is a permission request's answer lease running out (see
	// session.LeaseAnswer).
	ReasonTimeout CancelReason = "timeout"
	// ReasonWorkClosed is the work above the session having been closed. Nobody
	// is coming back to answer, so the prompt is withdrawn rather than left
	// pending forever — and unlike the first two this one is a fact about the
	// work layer, which is why the work layer is what produces it.
	ReasonWorkClosed CancelReason = "work_closed"
	// ReasonStepDone is the step the question was asked during having been
	// completed. The work carries on, so this is the softer of the two work-layer
	// reasons: the agent has moved past what it was asking about, and an answer
	// to it would arrive for a step that is over.
	ReasonStepDone CancelReason = "step_done"
)

type RequestCancelledEvent struct {
	RequestID string
	// Reason is empty when the agent itself withdrew the request: the CLI said
	// it no longer needs an answer and did not say why, and inventing one would
	// be worse than saying nothing.
	Reason CancelReason
	// At is when the withdrawal happened, and is only set for the posted
	// questions Pockode withdraws itself (the question_cancel tool, a work
	// closing). A cancellation forwarded from a CLI leaves it zero: the CLI does
	// not timestamp them, and the record would then be claiming the moment
	// Pockode happened to parse the frame. Same job as
	// QuestionAnswer.AnsweredAt — it is what a later attempt to act on the
	// question is refused with.
	At time.Time
}

func (RequestCancelledEvent) EventType() EventType { return EventTypeRequestCancelled }
func (RequestCancelledEvent) isAgentEvent()        {}

func (e RequestCancelledEvent) ToRecord() EventRecord {
	return EventRecord{Type: e.EventType(), RequestID: e.RequestID, Reason: e.Reason, ResolvedAt: optionalTime(e.At)}
}

// QuestionPostedEvent is one question an agent asked through the question_post
// tool, recorded at the moment it was asked.
//
// One question per record, and therefore one request id per question: an answer
// names a question, and so does a refusal to answer one, so a record covering
// three questions leaves "I will not answer the second" with no subject. Older
// transcripts hold ask_user_question records carrying several at once — those came
// from the CLI's own blocking prompt, and the client draws each of their questions
// as a card of this shape, sharing the one request id they were asked under.
//
// It is the immutable half of a posted question. That it is still unanswered is
// not in here and must never be: that is state, it changes, and it lives on the
// session's turn (session.PendingQuestion).
//
// Written by the server rather than parsed out of a CLI's stream, so it never
// reaches session.ReduceTurn through process.turnInputFor — the turn signal is
// applied by whoever wrote the record.
type QuestionPostedEvent struct {
	RequestID string
	Question  AskUserQuestion
	AskedAt   time.Time
}

func (QuestionPostedEvent) EventType() EventType { return EventTypeQuestionPosted }
func (QuestionPostedEvent) isAgentEvent()        {}

func (e QuestionPostedEvent) ToRecord() EventRecord {
	return EventRecord{
		Type:      e.EventType(),
		RequestID: e.RequestID,
		// A one-element list rather than a field of its own, so that a client
		// draws a posted question with the same code it draws the CLI's own.
		Questions: []AskUserQuestion{e.Question},
		AskedAt:   optionalTime(e.AskedAt),
	}
}

// QuestionAnswer is one question answered — or deliberately not answered — by
// the message that carries it (MessageEvent.Answering).
//
// The message *is* the answer record: there is no second record per question,
// because a second one would be a second account of the same act, and the two
// could disagree about a question answered while the transcript was being
// written.
//
// Header and Question are copied in rather than resolved from the question's
// own record. A client renders the bubble from this alone, and the record that
// asked may be thousands of messages back — outside every page it will ever
// load — so a bubble that had to find it would be a bubble that sometimes says
// nothing.
type QuestionAnswer struct {
	RequestID string `json:"request_id"`
	Header    string `json:"header,omitempty"`
	Question  string `json:"question,omitempty"`
	// Answers are option labels the question itself offered, and only ever
	// those. Empty when the user answered in their own words, and when
	// Declined.
	Answers []string `json:"answers,omitempty"`
	// Text is what the user wrote themselves — the whole answer to a question
	// that offered no options, or the "Other" beside ones it did.
	//
	// Kept apart from Answers rather than appended to it so that the agent can
	// tell the two apart. An option label is the agent's own word handed back;
	// this is the user's. Putting them in one list would let a string the agent
	// never offered read as one it did, which is the one thing the label check
	// in chat.validateAnswer exists to prevent.
	Text string `json:"text,omitempty"`
	// Declined says the user chose not to answer this question. It is an answer
	// in the sense that matters — the agent is told, and stops waiting — which
	// is why it travels with the ones that are.
	Declined bool `json:"declined,omitempty"`
	// Note is what the user added beside a decline. Optional and free text.
	Note string `json:"note,omitempty"`
	// ResolvedBy says who gave this answer.
	//
	// It used to be derivable and no longer is. While the only answer was a
	// person's, the record type *was* the answer — an entry like this one meant
	// the user, and a request_cancelled record meant the agent that asked — and
	// that inference is what the question_answer tool broke: an agent can now
	// answer another agent's question, and the record it writes is this one.
	//
	// Absent on records written before the tool existed, which were all the
	// user's; every record written now sets it, including the user's own. The
	// legacy reading is a rule about old transcripts, not a default worth
	// leaning on twice.
	ResolvedBy *QuestionResolver `json:"resolved_by,omitempty"`
	// AnsweredAt is when this was sent. Recorded per entry rather than per
	// message because it is the only timestamp a question's fate has: an
	// EventRecord carries no clock, and "answered by the user at 14:02" is what
	// a later attempt to answer the same question is refused with.
	//
	// Always set, so no `omitempty` to be misread: it would do nothing for a
	// struct anyway, and claiming otherwise is how the two fields on
	// EventRecord went wrong.
	AnsweredAt time.Time `json:"answered_at"`
}

// ResolverKind says which kind of answerer a QuestionResolver names.
type ResolverKind string

const (
	// ResolverUser is a person answering in the chat.
	ResolverUser ResolverKind = "user"
	// ResolverAgent is another agent answering through the question_answer
	// tool. It is never the agent that asked: answering your own question would
	// record an answer nobody gave, and the tool refuses it.
	ResolverAgent ResolverKind = "agent"
)

// QuestionResolver names who answered a question (QuestionAnswer.ResolvedBy).
//
// WorkID and Title are the *answering* work, and they are copied in for the
// same reason QuestionAnswer copies the header and the question: the reader is
// a bubble in someone else's transcript, and the work that answered is not one
// it can look up. They are empty for a user, and also for an agent running in a
// session no work owns — a plain chat can answer too, and has no title to give.
type QuestionResolver struct {
	Kind   ResolverKind `json:"kind"`
	WorkID string       `json:"work_id,omitempty"`
	Title  string       `json:"title,omitempty"`
}

// UserResolver is who a question answered in the chat was answered by.
func UserResolver() QuestionResolver { return QuestionResolver{Kind: ResolverUser} }

// optionalTime is how a moment reaches an EventRecord: the zero time means the
// event carried none, and an absent field is the honest way to record that.
func optionalTime(at time.Time) *time.Time {
	if at.IsZero() {
		return nil
	}
	return &at
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
	// MessageOriginAgent marks a message another agent put into this session:
	// today, an answer to a posted question given through question_answer.
	//
	// It is its own origin rather than either of the other two because it is
	// neither. Drawn as a user bubble it would claim the person said something
	// they did not; folded into the system line it would read as Pockode's own
	// annotation, and the answer would lose the one fact that matters about it.
	// Who exactly answered is on the answer itself (QuestionAnswer.ResolvedBy),
	// which is where a reader of the *record* needs it.
	MessageOriginAgent MessageOrigin = "agent"
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
	// MessageID is Pockode's own id for this message, minted where the message
	// is sent (chat.Client.sendEvent) so that a later message_ingested record can
	// name the message the agent read. See EventRecord.MessageID.
	MessageID string
	// Answering are the posted questions this message answers, if any. The
	// content still carries the answers in prose — that is what the agent reads
	// — and this is the structured copy a client draws the bubble from, so a
	// bubble never has to parse the prose back apart.
	Answering []QuestionAnswer
}

func (MessageEvent) EventType() EventType { return EventTypeMessage }
func (MessageEvent) isAgentEvent()        {}

func (e MessageEvent) ToRecord() EventRecord {
	return EventRecord{
		Type:      e.EventType(),
		Content:   e.Content,
		Origin:    e.Origin,
		Subtype:   e.Subtype,
		Meta:      e.Meta,
		Answering: e.Answering,
		MessageID: e.MessageID,
	}
}

// MessageIngestedEvent says the agent has taken in a message that arrived while
// it was already working, and that everything it produces from here answers
// that message rather than the one before it.
//
// It is the one signal a client needs to know where to cut: a message sent
// mid-turn is steered into the running turn, so the turn's own ending says
// nothing about which message the output belongs to (agent.Session.SendMessage).
// One turn has one ending; it can have any number of these.
//
// The agents differ in what they can report and the difference stops here.
// Codex echoes a message back when it reads it, so this is written from that
// echo and is exact. Claude reports nothing of the kind, so Pockode writes it
// the moment the message is handed over, which cuts slightly early — a little of
// what was already being written lands under the new message. That is the
// conservative direction: the alternative shows the whole answer to a question
// above the question. Which agent did which is deliberately not on the record.
//
// It is only written for a message that arrived mid-turn. One that started its
// turn has nothing above it to cut away, so a signal for it would only add a
// boundary where the message record already is.
type MessageIngestedEvent struct {
	// MessageID names the message record the agent took in. Empty when the id
	// could not be established — an agent whose echo carries none, or a message
	// whose own record failed to be written.
	//
	// Not what a client cuts on, and it must not become that: the record's
	// position already says which message was read, while the client that *sent*
	// a message is never told the id minted for it — it is the one subscriber
	// excluded from that broadcast (chat.Client.sendEvent) — so a transcript laid
	// out by this id would differ between the sending tab and every other tab,
	// and differ again after a reload. It is recorded because it is what the echo
	// carried and the only thing that says *which* of several queued messages a
	// read point belongs to.
	MessageID string
}

func (MessageIngestedEvent) EventType() EventType { return EventTypeMessageIngested }
func (MessageIngestedEvent) isAgentEvent()        {}

func (e MessageIngestedEvent) ToRecord() EventRecord {
	return EventRecord{Type: e.EventType(), MessageID: e.MessageID}
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
