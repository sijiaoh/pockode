package agent

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"time"

	"github.com/pockode/server/htmlpage"
	"github.com/pockode/server/session"
)

// Wire is an event as it is serialized: a line of history.jsonl, or a live
// event as the process broadcasts it. Clients receive neither directly — they
// get the projection's items and the chat watcher's deltas built from them
// (docs/agent-chat.md#live-updates). Every Wire is exactly one of two kinds,
// and the kind is the type, not a flag on it:
//
//   - a Record, which belongs in session history and is written there whole;
//   - a LiveEvent, which reports the latest value of something still changing
//     and is broadcast but never stored (see LiveEvent).
//
// Each concrete type carries only its own fields. The JSON discriminator
// `type` is not a field: MarshalJSON writes it first, from Type(), so a value
// cannot be serialized under any type but its own. Field order and tags are the
// on-disk format — history.jsonl written by any Pockode version reads with any
// other — so a field is only ever added, never renamed or moved to a different
// meaning.
type Wire interface {
	Type() EventType
	json.Marshaler
	isWire()
}

// Record is one line of a session's history.jsonl. It says what was true at one
// moment and never changes afterwards; see docs/agent-event.md.
//
// DecodeRecord reads one back. A reader that needs a field switches on the
// concrete type, so a field a record type does not have cannot be read off it.
type Record interface {
	Wire
	// session.HistoryRecord is what AppendToHistory takes, so a LiveEvent,
	// which has no HistoryRecord method, cannot be written to history.
	session.HistoryRecord
}

// LiveEvent is a Wire that is broadcast and never recorded: an event that
// reports the latest value of something still changing. A snapshot of that in
// a transcript becomes a lie the moment the next one arrives — the same
// argument that keeps token usage out of the event stream
// (docs/agent-event.md). It reaches subscribers with no sequence number
// (session.NoHistorySeq), because there is no record for one to name.
//
// It does not implement Record — nor session.HistoryRecord, which is what
// AppendToHistory takes — so writing one to history does not compile.
type LiveEvent interface {
	Wire
	isLiveEvent()
}

// marshalWire writes fields — a record's own struct with its methods stripped,
// so this is not called again — with the discriminator in front of them, which
// is where the single flat struct this replaced put it.
func marshalWire(t EventType, fields any) ([]byte, error) {
	body, err := json.Marshal(fields)
	if err != nil {
		return nil, err
	}
	head, err := json.Marshal(t)
	if err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	buf.Grow(len(head) + len(body) + 9)
	buf.WriteString(`{"type":`)
	buf.Write(head)
	if len(body) > 2 { // not "{}"
		buf.WriteByte(',')
		buf.Write(body[1:])
	} else {
		buf.WriteByte('}')
	}
	return buf.Bytes(), nil
}

// ErrUnknownRecordType is what DecodeRecord returns for a line whose type no
// record of this version has: written by a newer server, or not a record at
// all. Readers treat it like a line that does not parse.
var ErrUnknownRecordType = errors.New("unknown history record type")

// wireTypes is every type an event can be serialized as, one zero value each:
// every record this version writes or reads (the two legacy ones included) and
// every live event. It is the one list of them — the decoder table is built
// from it, and it is what a generator of the client's types walks (WireTypes).
// A type missing here is one whose old transcripts Go can no longer read.
var wireTypes = []Wire{
	TextRecord{},
	ToolCallRecord{},
	ToolResultRecord{},
	ThinkingRecord{},
	WarningRecord{},
	ErrorRecord{},
	DoneRecord{},
	InterruptedRecord{},
	ProcessEndedRecord{},
	PermissionRequestRecord{},
	RequestCancelledRecord{},
	QuestionPostedRecord{},
	SystemRecord{},
	BackgroundWaitRecord{},
	MessageRecord{},
	MessageIngestedRecord{},
	MessageDiscardedRecord{},
	PermissionResponseRecord{},
	RawRecord{},
	CommandOutputRecord{},
	PlanRecord{},
	AskUserQuestionRecord{},
	QuestionResponseRecord{},
	TurnStartedRecord{},
	ToolActivityLiveEvent{},
	ThinkingDeltaLiveEvent{},
}

// WireTypes returns a zero value of every type an event can be serialized as;
// see wireTypes. Its Type() is the value of the `type` discriminator, and
// whether it is a Record or a LiveEvent says whether it is ever stored.
func WireTypes() []Wire {
	return append([]Wire(nil), wireTypes...)
}

// recordTypes maps each record type's discriminator to its Go type, for
// DecodeRecord. Live events are not in it: there is no history line for one.
var recordTypes = func() map[EventType]reflect.Type {
	m := make(map[EventType]reflect.Type)
	for _, w := range wireTypes {
		if _, ok := w.(Record); !ok {
			continue
		}
		if _, dup := m[w.Type()]; dup {
			panic("agent: two record types claim " + string(w.Type()))
		}
		m[w.Type()] = reflect.TypeOf(w)
	}
	return m
}()

// DecodeRecord reads one history line as the record type its `type` names.
// Fields the type does not have are ignored — so one of them holding a value
// of the wrong shape does not fail the line either — and a type this version
// does not know is ErrUnknownRecordType. A replay hands the client the raw
// line, not this.
func DecodeRecord(raw []byte) (Record, error) {
	var head struct {
		Type EventType `json:"type"`
	}
	if err := json.Unmarshal(raw, &head); err != nil {
		return nil, err
	}
	typ, ok := recordTypes[head.Type]
	if !ok {
		return nil, fmt.Errorf("%w %q", ErrUnknownRecordType, head.Type)
	}
	rec := reflect.New(typ)
	if err := json.Unmarshal(raw, rec.Interface()); err != nil {
		return nil, err
	}
	return rec.Elem().Interface().(Record), nil
}

// TextRecord is what the agent wrote.
type TextRecord struct {
	Content string `json:"content,omitempty"`
	// ParentToolUseID is the subagent call a text, thinking, tool_call,
	// tool_result or plan record was produced inside: the subagent's own words
	// and tool use, which the agent streams interleaved with the main
	// conversation's — a backgrounded subagent writes between the main agent's
	// own lines — so position cannot say whose they are. Empty for everything
	// the main conversation produced, and on every record written before the
	// field existed. A subagent's subagent names the call that spawned *it*, so
	// the field nests rather than flattens.
	//
	// It points at a call that need not be loaded, or exist at all — the call
	// may sit on an earlier history page, or have been dropped by a fork cut
	// that kept its children but not its result (see TruncateHistory). A
	// client that cannot find it shows the record where it sits, as it would
	// without the field.
	ParentToolUseID string `json:"parent_tool_use_id,omitempty"`
	// ProviderMessageID is the agent's own id for the piece of its conversation
	// this record was parsed out of, when the agent hands one out — on text,
	// thinking, tool_call, tool_result and plan records. It is a fact the event
	// arrived with, not Pockode state, which is why it is recorded here rather
	// than tracked alongside the session.
	//
	// It exists so a fork can name the point it was cut at in the agent's own
	// terms: Pockode's history sequence means nothing to a CLI, and one piece of
	// the agent's conversation can produce several records here (an assistant
	// turn with text and a tool call), so position cannot be recovered from the
	// records either. Empty for events with nothing of the agent's behind them,
	// for agents that expose no ids, and for every record written before this
	// field existed.
	//
	// Also empty on a subagent's records (ParentToolUseID set): both CLIs keep a
	// subagent's conversation apart from the main one — Claude in a sidechain
	// transcript of its own, Codex in a thread of its own — so its ids name
	// nothing the main conversation can be reopened at. LastProviderMessageID
	// walks back past them, so a fork cut inside a subagent's run is anchored on
	// the last main-conversation record TruncateHistory keeps — what preceded
	// the spawning call, which is dropped with its result after the cut, or for
	// a backgrounded subagent whatever the main agent went on to do while it ran.
	//
	// What the id names is each agent's own business, since only that agent ever
	// reads it back: the anchor it accepts for reopening a conversation is what
	// belongs here. Claude names a transcript message (`--resume-session-at`),
	// Codex a turn (`thread/fork`'s `lastTurnId`), which is why the name says
	// message but the granularity does not have to be one.
	ProviderMessageID string `json:"provider_message_id,omitempty"`
}

// ToolCallRecord is a tool call the agent made; see ToolCallEvent.
type ToolCallRecord struct {
	ToolName  string          `json:"tool_name,omitempty"`
	ToolInput json.RawMessage `json:"tool_input,omitempty"`
	ToolUseID string          `json:"tool_use_id,omitempty"`
	// OriginToolUseID is the call this one is *about*: a fetch like Claude's
	// TaskOutput, or a stop like its TaskStop, names its target by task_id, and
	// the map from that to a tool_use_id lives only in the adapter, for as long
	// as the task does. Resolved where the answer is known and recorded here so
	// a replay still has it; absent whenever it could not be resolved, which is
	// ordinary (see ToolCallEvent.OriginToolUseID). What a client does with the
	// join — or nothing at all — is the client's decision.
	OriginToolUseID string `json:"origin_tool_use_id,omitempty"`
	// ParentToolUseID: see TextRecord.ParentToolUseID.
	ParentToolUseID string `json:"parent_tool_use_id,omitempty"`
	// ObservedAt: see ObserveAt.
	ObservedAt *time.Time `json:"observed_at,omitempty"`
	// Subtype marks a tool_call that is not a call starting; see
	// ToolCallResumed.
	Subtype ToolCallSubtype `json:"subtype,omitempty"`
	// ProviderMessageID: see TextRecord.ProviderMessageID.
	ProviderMessageID string `json:"provider_message_id,omitempty"`
}

// ToolResultRecord is what a tool call came back with; see ToolResultEvent.
type ToolResultRecord struct {
	ToolUseID string `json:"tool_use_id,omitempty"`
	// ParentToolUseID: see TextRecord.ParentToolUseID.
	ParentToolUseID string         `json:"parent_tool_use_id,omitempty"`
	ToolResult      string         `json:"tool_result,omitempty"`
	Contents        []ContentBlock `json:"contents,omitempty"`
	IsError         bool           `json:"is_error,omitempty"`
	// ObservedAt: see ObserveAt.
	ObservedAt *time.Time `json:"observed_at,omitempty"`
	// Subtype marks a result that is not simply what the call produced; see
	// the ToolResultBackground* constants.
	Subtype ToolResultSubtype `json:"subtype,omitempty"`
	// DurationMs and ExitCode are what an agent CLI reported about the finished
	// call, as figures; see ToolResultEvent. Codex reports both as such.
	// Claude reports no exit status as a figure, so its ExitCode is parsed from
	// the one place it is: a failed Bash result's first line, `Exit code N`
	// (measured on claude 2.1.330), matched strictly and left empty otherwise —
	// see reportedExitCode in the claude package.
	DurationMs int64 `json:"duration_ms,omitempty"`
	ExitCode   *int  `json:"exit_code,omitempty"`
	// Subagent is set on the result of a subagent's call; see
	// ToolResultEvent.Subagent. Absent on every record written before it
	// existed.
	Subagent *SubagentReport `json:"subagent,omitempty"`
	// HTMLPage is the page a successful page tool call stored (package
	// htmlpage). It is how a client knows which stored page a card is, and how
	// a fork knows which pages its copied history drew. The CLI does not report
	// it: the server stamps it when it records the result (process.pageCalls).
	HTMLPage string `json:"html_page,omitempty"`
	// WorkRef is the work item a successful call to one of Pockode's work
	// tools acted on. Like HTMLPage the CLI does not report it: the server
	// stamps it (process.workCalls).
	WorkRef *WorkRef `json:"work_ref,omitempty"`
	// ProviderMessageID: see TextRecord.ProviderMessageID.
	ProviderMessageID string `json:"provider_message_id,omitempty"`
}

// ThinkingRecord is a finished stretch of the agent's thinking; see
// ThinkingEvent.
type ThinkingRecord struct {
	Content string `json:"content,omitempty"`
	// ParentToolUseID: see TextRecord.ParentToolUseID.
	ParentToolUseID string `json:"parent_tool_use_id,omitempty"`
	// DurationMs is measured by the server, unlike a tool result's; see
	// ThinkingEvent.DurationMs.
	DurationMs    int64  `json:"duration_ms,omitempty"`
	FullReasoning string `json:"full_reasoning,omitempty"`
	Redacted      bool   `json:"redacted,omitempty"`
	// ProviderMessageID: see TextRecord.ProviderMessageID.
	ProviderMessageID string `json:"provider_message_id,omitempty"`
}

// WarningRecord is a non-fatal problem; see WarningEvent.
type WarningRecord struct {
	Message string `json:"message,omitempty"`
	Code    string `json:"code,omitempty"`
	// AuthFailure marks the warning as a credentials refusal; see the type.
	AuthFailure *AuthFailure `json:"auth_failure,omitempty"`
	// UsageLimit marks the warning as the account's usage limit being hit; see
	// the type.
	UsageLimit *UsageLimit `json:"usage_limit,omitempty"`
}

// ErrorRecord is a turn that failed; see ErrorEvent.
type ErrorRecord struct {
	Error       string       `json:"error,omitempty"`
	AuthFailure *AuthFailure `json:"auth_failure,omitempty"`
	UsageLimit  *UsageLimit  `json:"usage_limit,omitempty"`
	// ObservedAt: see ObserveAt.
	ObservedAt *time.Time `json:"observed_at,omitempty"`
}

// DoneRecord is a turn that ended normally.
type DoneRecord struct {
	// ObservedAt: see ObserveAt.
	ObservedAt *time.Time `json:"observed_at,omitempty"`
}

// InterruptedRecord is a turn a Stop ended.
type InterruptedRecord struct {
	// ObservedAt: see ObserveAt.
	ObservedAt *time.Time `json:"observed_at,omitempty"`
}

// ProcessEndedRecord is the agent's process going away.
type ProcessEndedRecord struct {
	// ObservedAt: see ObserveAt. Absent on the one a restarted server writes
	// for a run nobody saw end (session.FileStore).
	ObservedAt *time.Time `json:"observed_at,omitempty"`
}

// PermissionRequestRecord is a call waiting on a decision; see
// PermissionRequestEvent.
type PermissionRequestRecord struct {
	ToolName              string             `json:"tool_name,omitempty"`
	ToolInput             json.RawMessage    `json:"tool_input,omitempty"`
	ToolUseID             string             `json:"tool_use_id,omitempty"`
	RequestID             string             `json:"request_id,omitempty"`
	PermissionSuggestions []PermissionUpdate `json:"permission_suggestions,omitempty"`
	DecisionReason        string             `json:"decision_reason,omitempty"`
	BlockedPath           string             `json:"blocked_path,omitempty"`
}

// RequestCancelledRecord is a request that stopped waiting for its answer;
// see RequestCancelledEvent.
type RequestCancelledRecord struct {
	RequestID string `json:"request_id,omitempty"`
	// Reason says why; see CancelReason.
	Reason CancelReason `json:"reason,omitempty"`
	// ResolvedAt is when a posted question was withdrawn; see
	// RequestCancelledEvent.At. A pointer, for the reason given on ObserveAt.
	ResolvedAt *time.Time `json:"resolved_at,omitempty"`
}

// QuestionPostedRecord is a question an agent asked through question_post;
// see QuestionPostedEvent.
type QuestionPostedRecord struct {
	RequestID string `json:"request_id,omitempty"`
	// Questions is the one question, in a one-element list so that it and the
	// legacy ask_user_question records — which could carry several — share one
	// renderer.
	Questions []AskUserQuestion `json:"questions,omitempty"`
	// AskedAt is when the question was asked. A pointer, for the reason given
	// on ObserveAt.
	AskedAt *time.Time `json:"asked_at,omitempty"`
}

// SystemRecord is a system frame from the CLI.
type SystemRecord struct {
	Content string `json:"content,omitempty"`
}

// BackgroundWaitRecord says the turn has been parked on background work; see
// BackgroundWaitEvent.
type BackgroundWaitRecord struct{}

// MessageRecord is a message sent to the agent; see MessageEvent.
type MessageRecord struct {
	Content string `json:"content,omitempty"`
	// ObservedAt: see ObserveAt.
	ObservedAt *time.Time `json:"observed_at,omitempty"`
	// Answering are the posted questions this message answers; see
	// QuestionAnswer.
	Answering []QuestionAnswer `json:"answering,omitempty"`
	// Command is the Pockode command this message was expanded from; see
	// CommandInvocation.
	Command *CommandInvocation `json:"command,omitempty"`
	// HTMLAction is the page action this message was written from; see
	// MessageEvent.HTMLAction.
	HTMLAction *htmlpage.Action `json:"html_action,omitempty"`
	// Attachments are the files the user sent with this message; see
	// MessageEvent.Attachments.
	Attachments []FileBlock   `json:"attachments,omitempty"`
	Origin      MessageOrigin `json:"origin,omitempty"`
	// MessageID is Pockode's own id for a message, carried by the message
	// record itself, by the message_ingested record that says the agent read
	// it, and by the message_discarded record that says a Stop threw it away
	// unread. It is what joins them, and it exists because position cannot do
	// that job: several messages can be queued into one turn, and they are read
	// — or discarded — one at a time.
	//
	// Pockode's own id rather than the agent's: the agent that echoes one back
	// (Codex) echoes back the id it was given, and the agent that echoes nothing
	// has no id of its own to use. Empty on every record written before this
	// field existed, and on a message whose id was never established.
	MessageID string `json:"message_id,omitempty"`
	// Subtype is a system-origin message's kind; see MessageEvent.
	Subtype MessageSubtype `json:"subtype,omitempty"`
	Meta    *MessageMeta   `json:"meta,omitempty"`
}

// MessageIngestedRecord is the point the agent read a mid-turn message; see
// MessageIngestedEvent.
type MessageIngestedRecord struct {
	// ObservedAt: see ObserveAt.
	ObservedAt *time.Time `json:"observed_at,omitempty"`
	// MessageID: see MessageRecord.MessageID.
	MessageID string `json:"message_id,omitempty"`
}

// TurnOrigin is what opened a turn.
type TurnOrigin string

const (
	// TurnOriginPrompt is a message handed to an idle agent — typed, or sent
	// by Pockode itself.
	TurnOriginPrompt TurnOrigin = "prompt"
	// TurnOriginOutput is the agent producing content with no turn open and
	// nothing asking it to: output after a done with no message in between.
	TurnOriginOutput TurnOrigin = "output"
	// TurnOriginAnswer is an answer to a permission request that outlived the
	// turn it was raised in.
	TurnOriginAnswer TurnOrigin = "answer"
)

// TurnStartedRecord is a turn opening: the moment a session went from idle to
// open (session.TurnTransition.Started). Every record written while the turn
// is open carries its id in the history envelope (session.HistoryTurn), its
// ending included.
//
// The message that opened it is named here rather than tagged, because the
// message record is written before anyone knows whether it opens a turn or
// joins one. This says which turn a message started; which message the
// agent's output answers is a different relation, kept by
// message_ingested — Claude answers a message queued into one turn in the
// next.
type TurnStartedRecord struct {
	TurnID string     `json:"turn_id"`
	Origin TurnOrigin `json:"origin"`
	// MessageID is the opening message's (MessageRecord.MessageID), for
	// TurnOriginPrompt; empty for the other origins, and for a prompt whose
	// message record could not be written.
	MessageID string `json:"message_id,omitempty"`
	// ObservedAt: see ObserveAt. The instant the turn opened at
	// (session.TurnState.OpenedAt) — for a prompt, its message's own.
	ObservedAt *time.Time `json:"observed_at,omitempty"`
}

// MessageDiscardedRecord is a message a Stop threw away unread; see
// MessageDiscardedEvent.
type MessageDiscardedRecord struct {
	// MessageID: see MessageRecord.MessageID.
	MessageID string `json:"message_id,omitempty"`
}

// PermissionResponseRecord is the answer a permission request got; see
// PermissionResponseEvent.
type PermissionResponseRecord struct {
	RequestID string               `json:"request_id,omitempty"`
	Choice    PermissionChoiceName `json:"choice,omitempty"`
	// By and Review are who answered, and what became of the review (a
	// reviewer's verdict, or Pockode's own deny). Both absent on a person's
	// answer.
	By     PermissionResponder `json:"by,omitempty"`
	Review *PermissionReview   `json:"review,omitempty"`
	// ObservedAt: see ObserveAt.
	ObservedAt *time.Time `json:"observed_at,omitempty"`
}

// RawRecord is CLI output that could not be parsed.
type RawRecord struct {
	Content string `json:"content,omitempty"`
}

// CommandOutputRecord is a local command's output (e.g. /context).
type CommandOutputRecord struct {
	Content string `json:"content,omitempty"`
}

// PlanRecord is the agent's plan as it stood at one moment; see PlanEvent. A
// plan record with no steps field is a plan with nothing in it.
type PlanRecord struct {
	// ToolUseID is the call whose row the plan is filed on, which is what
	// tool_use_id names on every record that has one: the call the record is
	// about. For a Claude subagent's Task call that row is the main-thread
	// spawn's, not the call that changed the plan; see PlanEvent.ToolUseID.
	ToolUseID string `json:"tool_use_id,omitempty"`
	// ParentToolUseID: see TextRecord.ParentToolUseID.
	ParentToolUseID string     `json:"parent_tool_use_id,omitempty"`
	Steps           []PlanStep `json:"steps,omitempty"`
	Explanation     string     `json:"explanation,omitempty"`
	PlanID          string     `json:"plan_id,omitempty"`
	// ProviderMessageID: see TextRecord.ProviderMessageID.
	ProviderMessageID string `json:"provider_message_id,omitempty"`
}

// AskUserQuestionRecord is read, never written: the CLI's own blocking
// question, from transcripts written before Pockode stopped letting a CLI ask
// one (see EventTypeAskUserQuestion). It can carry several questions under one
// request id.
type AskUserQuestionRecord struct {
	ToolUseID string            `json:"tool_use_id,omitempty"`
	RequestID string            `json:"request_id,omitempty"`
	Questions []AskUserQuestion `json:"questions,omitempty"`
}

// QuestionResponseRecord is read, never written: the answer to an
// AskUserQuestionRecord (see EventTypeQuestionResponse). Answers is keyed by
// question text; how its values are laid out is in docs/agent-event.md. Nil —
// an absent key, never `null` — when the CLI cancelled the question instead.
type QuestionResponseRecord struct {
	RequestID string            `json:"request_id,omitempty"`
	Answers   map[string]string `json:"answers,omitempty"`
}

// ToolActivityLiveEvent is what a tool call that has not returned is doing
// right now; see ToolActivityEvent.
type ToolActivityLiveEvent struct {
	ToolUseID   string `json:"tool_use_id,omitempty"`
	Activity    string `json:"activity,omitempty"`
	OutputDelta string `json:"output_delta,omitempty"`
	// SubagentProgress: see ToolActivityEvent.Subagent.
	SubagentProgress *SubagentProgress `json:"subagent_progress,omitempty"`
}

// ThinkingDeltaLiveEvent says the main agent is thinking right now; see
// ThinkingDeltaEvent.
type ThinkingDeltaLiveEvent struct {
	ContentDelta       string `json:"content_delta,omitempty"`
	FullReasoningDelta string `json:"full_reasoning_delta,omitempty"`
}

func (TextRecord) Type() EventType               { return EventTypeText }
func (ToolCallRecord) Type() EventType           { return EventTypeToolCall }
func (ToolResultRecord) Type() EventType         { return EventTypeToolResult }
func (ThinkingRecord) Type() EventType           { return EventTypeThinking }
func (WarningRecord) Type() EventType            { return EventTypeWarning }
func (ErrorRecord) Type() EventType              { return EventTypeError }
func (DoneRecord) Type() EventType               { return EventTypeDone }
func (InterruptedRecord) Type() EventType        { return EventTypeInterrupted }
func (ProcessEndedRecord) Type() EventType       { return EventTypeProcessEnded }
func (PermissionRequestRecord) Type() EventType  { return EventTypePermissionRequest }
func (RequestCancelledRecord) Type() EventType   { return EventTypeRequestCancelled }
func (QuestionPostedRecord) Type() EventType     { return EventTypeQuestionPosted }
func (SystemRecord) Type() EventType             { return EventTypeSystem }
func (BackgroundWaitRecord) Type() EventType     { return EventTypeBackgroundWait }
func (MessageRecord) Type() EventType            { return EventTypeMessage }
func (MessageIngestedRecord) Type() EventType    { return EventTypeMessageIngested }
func (MessageDiscardedRecord) Type() EventType   { return EventTypeMessageDiscarded }
func (PermissionResponseRecord) Type() EventType { return EventTypePermissionResponse }
func (RawRecord) Type() EventType                { return EventTypeRaw }
func (CommandOutputRecord) Type() EventType      { return EventTypeCommandOutput }
func (PlanRecord) Type() EventType               { return EventTypePlan }
func (AskUserQuestionRecord) Type() EventType    { return EventTypeAskUserQuestion }
func (QuestionResponseRecord) Type() EventType   { return EventTypeQuestionResponse }
func (TurnStartedRecord) Type() EventType        { return EventTypeTurnStarted }
func (ToolActivityLiveEvent) Type() EventType    { return EventTypeToolActivity }
func (ThinkingDeltaLiveEvent) Type() EventType   { return EventTypeThinkingDelta }

// Each MarshalJSON converts to a local type with the same fields and no
// methods, so json.Marshal inside marshalWire encodes the fields rather than
// calling back here.

func (r TextRecord) MarshalJSON() ([]byte, error) {
	type fields TextRecord
	return marshalWire(r.Type(), fields(r))
}

func (r ToolCallRecord) MarshalJSON() ([]byte, error) {
	type fields ToolCallRecord
	return marshalWire(r.Type(), fields(r))
}

func (r ToolResultRecord) MarshalJSON() ([]byte, error) {
	type fields ToolResultRecord
	return marshalWire(r.Type(), fields(r))
}

func (r ThinkingRecord) MarshalJSON() ([]byte, error) {
	type fields ThinkingRecord
	return marshalWire(r.Type(), fields(r))
}

func (r WarningRecord) MarshalJSON() ([]byte, error) {
	type fields WarningRecord
	return marshalWire(r.Type(), fields(r))
}

func (r ErrorRecord) MarshalJSON() ([]byte, error) {
	type fields ErrorRecord
	return marshalWire(r.Type(), fields(r))
}

func (r DoneRecord) MarshalJSON() ([]byte, error) {
	type fields DoneRecord
	return marshalWire(r.Type(), fields(r))
}

func (r InterruptedRecord) MarshalJSON() ([]byte, error) {
	type fields InterruptedRecord
	return marshalWire(r.Type(), fields(r))
}

func (r ProcessEndedRecord) MarshalJSON() ([]byte, error) {
	type fields ProcessEndedRecord
	return marshalWire(r.Type(), fields(r))
}

func (r PermissionRequestRecord) MarshalJSON() ([]byte, error) {
	type fields PermissionRequestRecord
	return marshalWire(r.Type(), fields(r))
}

func (r RequestCancelledRecord) MarshalJSON() ([]byte, error) {
	type fields RequestCancelledRecord
	return marshalWire(r.Type(), fields(r))
}

func (r QuestionPostedRecord) MarshalJSON() ([]byte, error) {
	type fields QuestionPostedRecord
	return marshalWire(r.Type(), fields(r))
}

func (r SystemRecord) MarshalJSON() ([]byte, error) {
	type fields SystemRecord
	return marshalWire(r.Type(), fields(r))
}

func (r BackgroundWaitRecord) MarshalJSON() ([]byte, error) {
	type fields BackgroundWaitRecord
	return marshalWire(r.Type(), fields(r))
}

func (r MessageRecord) MarshalJSON() ([]byte, error) {
	type fields MessageRecord
	return marshalWire(r.Type(), fields(r))
}

func (r MessageIngestedRecord) MarshalJSON() ([]byte, error) {
	type fields MessageIngestedRecord
	return marshalWire(r.Type(), fields(r))
}

func (r MessageDiscardedRecord) MarshalJSON() ([]byte, error) {
	type fields MessageDiscardedRecord
	return marshalWire(r.Type(), fields(r))
}

func (r PermissionResponseRecord) MarshalJSON() ([]byte, error) {
	type fields PermissionResponseRecord
	return marshalWire(r.Type(), fields(r))
}

func (r RawRecord) MarshalJSON() ([]byte, error) {
	type fields RawRecord
	return marshalWire(r.Type(), fields(r))
}

func (r CommandOutputRecord) MarshalJSON() ([]byte, error) {
	type fields CommandOutputRecord
	return marshalWire(r.Type(), fields(r))
}

func (r PlanRecord) MarshalJSON() ([]byte, error) {
	type fields PlanRecord
	return marshalWire(r.Type(), fields(r))
}

func (r AskUserQuestionRecord) MarshalJSON() ([]byte, error) {
	type fields AskUserQuestionRecord
	return marshalWire(r.Type(), fields(r))
}

func (r QuestionResponseRecord) MarshalJSON() ([]byte, error) {
	type fields QuestionResponseRecord
	return marshalWire(r.Type(), fields(r))
}

func (r TurnStartedRecord) MarshalJSON() ([]byte, error) {
	type fields TurnStartedRecord
	return marshalWire(r.Type(), fields(r))
}

func (r ToolActivityLiveEvent) MarshalJSON() ([]byte, error) {
	type fields ToolActivityLiveEvent
	return marshalWire(r.Type(), fields(r))
}

func (r ThinkingDeltaLiveEvent) MarshalJSON() ([]byte, error) {
	type fields ThinkingDeltaLiveEvent
	return marshalWire(r.Type(), fields(r))
}

func (TextRecord) isWire()               {}
func (ToolCallRecord) isWire()           {}
func (ToolResultRecord) isWire()         {}
func (ThinkingRecord) isWire()           {}
func (WarningRecord) isWire()            {}
func (ErrorRecord) isWire()              {}
func (DoneRecord) isWire()               {}
func (InterruptedRecord) isWire()        {}
func (ProcessEndedRecord) isWire()       {}
func (PermissionRequestRecord) isWire()  {}
func (RequestCancelledRecord) isWire()   {}
func (QuestionPostedRecord) isWire()     {}
func (SystemRecord) isWire()             {}
func (BackgroundWaitRecord) isWire()     {}
func (MessageRecord) isWire()            {}
func (MessageIngestedRecord) isWire()    {}
func (MessageDiscardedRecord) isWire()   {}
func (PermissionResponseRecord) isWire() {}
func (RawRecord) isWire()                {}
func (CommandOutputRecord) isWire()      {}
func (PlanRecord) isWire()               {}
func (AskUserQuestionRecord) isWire()    {}
func (QuestionResponseRecord) isWire()   {}
func (TurnStartedRecord) isWire()        {}
func (ToolActivityLiveEvent) isWire()    {}
func (ThinkingDeltaLiveEvent) isWire()   {}

func (TextRecord) HistoryRecord()               {}
func (ToolCallRecord) HistoryRecord()           {}
func (ToolResultRecord) HistoryRecord()         {}
func (ThinkingRecord) HistoryRecord()           {}
func (WarningRecord) HistoryRecord()            {}
func (ErrorRecord) HistoryRecord()              {}
func (DoneRecord) HistoryRecord()               {}
func (InterruptedRecord) HistoryRecord()        {}
func (ProcessEndedRecord) HistoryRecord()       {}
func (PermissionRequestRecord) HistoryRecord()  {}
func (RequestCancelledRecord) HistoryRecord()   {}
func (QuestionPostedRecord) HistoryRecord()     {}
func (SystemRecord) HistoryRecord()             {}
func (BackgroundWaitRecord) HistoryRecord()     {}
func (MessageRecord) HistoryRecord()            {}
func (MessageIngestedRecord) HistoryRecord()    {}
func (MessageDiscardedRecord) HistoryRecord()   {}
func (PermissionResponseRecord) HistoryRecord() {}
func (RawRecord) HistoryRecord()                {}
func (CommandOutputRecord) HistoryRecord()      {}
func (PlanRecord) HistoryRecord()               {}
func (AskUserQuestionRecord) HistoryRecord()    {}
func (QuestionResponseRecord) HistoryRecord()   {}
func (TurnStartedRecord) HistoryRecord()        {}

func (ToolActivityLiveEvent) isLiveEvent()  {}
func (ThinkingDeltaLiveEvent) isLiveEvent() {}

// WorkRef names a work item as it was when a call acted on it: its id, its
// type (story, task, job) and its title at that moment. It is an event's, so
// it carries no status — whatever is true of the work now is the work store's,
// read by id (docs/tool-call-model.md, "A call on Pockode's own work").
type WorkRef struct {
	ID    string `json:"id"`
	Type  string `json:"type"`
	Title string `json:"title"`
}
