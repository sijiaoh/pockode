package agent

import "encoding/json"

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
	OriginToolUseID       string             `json:"origin_tool_use_id,omitempty"`
	ToolResult            string             `json:"tool_result,omitempty"`
	Contents              []ContentBlock     `json:"contents,omitempty"`
	IsError               bool               `json:"is_error,omitempty"`
	Error                 string             `json:"error,omitempty"`
	Message               string             `json:"message,omitempty"`
	Code                  string             `json:"code,omitempty"`
	RequestID             string             `json:"request_id,omitempty"`
	PermissionSuggestions []PermissionUpdate `json:"permission_suggestions,omitempty"`
	Questions             []AskUserQuestion  `json:"questions,omitempty"`
	Choice                string             `json:"choice,omitempty"`
	// Reason says why a request stopped waiting for an answer; see CancelReason.
	Reason  CancelReason      `json:"reason,omitempty"`
	Answers map[string]string `json:"answers,omitempty"`
	Origin  MessageOrigin     `json:"origin,omitempty"`
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
