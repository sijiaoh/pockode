package agent

import (
	"encoding/json"
	"time"
)

// EventRecord is the serialized form of an AgentEvent.
// Used for persistence (history storage) and notifications (WebSocket).
type EventRecord struct {
	Type      EventType       `json:"type"`
	Content   string          `json:"content,omitempty"`
	ToolName  string          `json:"tool_name,omitempty"`
	ToolInput json.RawMessage `json:"tool_input,omitempty"`
	ToolUseID string          `json:"tool_use_id,omitempty"`
	// OriginToolUseID is the call an ordinary tool_call record is *about*: a
	// fetch like Claude's TaskOutput names its target by task_id, and the map
	// from that to a tool_use_id lives only in the adapter, for as long as the
	// task does. Resolved where the answer is known and recorded here so a
	// replay still has it; absent whenever it could not be resolved, which is
	// ordinary (see ToolCallEvent.OriginToolUseID). What a client does with the
	// join — or nothing at all — is the client's decision.
	OriginToolUseID string `json:"origin_tool_use_id,omitempty"`
	// ParentToolUseID is the subagent call a text, tool_call or tool_result
	// record was produced inside: the subagent's own words and tool use, which
	// the agent streams interleaved with the main conversation's — a
	// backgrounded subagent writes between the main agent's own lines — so
	// position cannot say whose they are. Empty for everything the main
	// conversation produced, and on every record written before the field
	// existed. A subagent's subagent names the call that spawned *it*, so the
	// field nests rather than flattens.
	//
	// It points at a call that need not be loaded, or exist at all — the call
	// may sit on an earlier history page, or have been dropped by a fork cut
	// that kept its children but not its result (see TruncateHistory). A
	// client that cannot find it shows the record where it sits, as it would
	// without the field.
	ParentToolUseID string         `json:"parent_tool_use_id,omitempty"`
	ToolResult      string         `json:"tool_result,omitempty"`
	Contents        []ContentBlock `json:"contents,omitempty"`
	IsError         bool           `json:"is_error,omitempty"`
	Error           string         `json:"error,omitempty"`
	Message         string         `json:"message,omitempty"`
	Code            string         `json:"code,omitempty"`
	// AuthFailure marks an error or warning record as a credentials refusal;
	// see the type.
	AuthFailure           *AuthFailure       `json:"auth_failure,omitempty"`
	RequestID             string             `json:"request_id,omitempty"`
	PermissionSuggestions []PermissionUpdate `json:"permission_suggestions,omitempty"`
	// Questions is a question_posted record's one question, in a one-element
	// list so that it and the legacy ask_user_question records — which could
	// carry several — share one renderer.
	Questions []AskUserQuestion `json:"questions,omitempty"`
	Choice    string            `json:"choice,omitempty"`
	// Reason says why a request stopped waiting for an answer; see CancelReason.
	Reason CancelReason `json:"reason,omitempty"`
	// AskedAt is when a question_posted record's question was asked, and
	// ResolvedAt when a request_cancelled record's question was withdrawn. Both
	// are absent on records Pockode did not write itself; see
	// RequestCancelledEvent.At.
	//
	// Pointers, and that is not a style choice: `omitempty` does nothing for a
	// struct, so a plain time.Time would put `"asked_at":"0001-01-01T00:00:00Z"`
	// on every record in every transcript and on every notification — two junk
	// fields per event, for two fields that mean something on two event types.
	AskedAt    *time.Time `json:"asked_at,omitempty"`
	ResolvedAt *time.Time `json:"resolved_at,omitempty"`
	// Answering are the posted questions a message record answers; see
	// QuestionAnswer.
	Answering []QuestionAnswer `json:"answering,omitempty"`
	// Command is the Pockode command a message record was expanded from; see
	// CommandInvocation.
	Command *CommandInvocation `json:"command,omitempty"`
	Origin  MessageOrigin      `json:"origin,omitempty"`
	// MessageID is Pockode's own id for a message, carried by the message record
	// itself and by the message_ingested record that says the agent read it. It
	// is what joins the two, and it exists because position cannot do that job:
	// several messages can be queued into one turn, and they are read one at a
	// time.
	//
	// Pockode's own id rather than the agent's: the agent that echoes one back
	// (Codex) echoes back the id it was given, and the agent that echoes nothing
	// has no id of its own to use. Empty on every record written before this
	// field existed, and on a message whose id was never established.
	MessageID string `json:"message_id,omitempty"`
	// Subtype says what kind of record this is within its type, for the two
	// types that have kinds: a system-origin message (see MessageEvent), and a
	// tool result that is not the whole story (see ToolResultBackgroundStarted).
	Subtype string       `json:"subtype,omitempty"`
	Meta    *MessageMeta `json:"meta,omitempty"`
	// DurationMs and ExitCode are what an agent CLI reported about a finished
	// tool call as figures rather than as prose; see ToolResultEvent.
	DurationMs int64 `json:"duration_ms,omitempty"`
	ExitCode   *int  `json:"exit_code,omitempty"`
	// Activity and OutputDelta belong to tool_activity records, which are
	// broadcast and never stored — see EventType.Persisted. They are fields of
	// EventRecord anyway because EventRecord is the whole of how an event is
	// serialized, for the wire as much as for history.
	Activity    string `json:"activity,omitempty"`
	OutputDelta string `json:"output_delta,omitempty"`
	// ProviderMessageID is the agent's own id for the piece of its conversation
	// this event was parsed out of, when the agent hands one out. It is a fact
	// the event arrived with, not Pockode state, which is why it is recorded
	// here rather than tracked alongside the session.
	//
	// It exists so a fork can name the point it was cut at in the agent's own
	// terms: Pockode's history sequence means nothing to a CLI, and one piece of
	// the agent's conversation can produce several records here (an assistant
	// turn with text and a tool call), so position cannot be recovered from the
	// records either. Empty for events with nothing of the agent's behind them
	// (a warning Pockode raised itself), for agents that expose no ids, and for
	// every record written before this field existed.
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

// NewEventRecord creates an EventRecord from an AgentEvent.
func NewEventRecord(event AgentEvent) EventRecord {
	return event.ToRecord()
}
