package agent

import (
	"context"
	"encoding/json"

	"github.com/pockode/server/session"
)

// PermissionChoice represents the user's decision on a permission request.
type PermissionChoice int

const (
	PermissionDeny        PermissionChoice = iota // Deny the request
	PermissionAllow                               // Allow this one request
	PermissionAlwaysAllow                         // Allow and persist for future requests
)

// PermissionRequestData contains the data needed to send a permission response.
type PermissionRequestData struct {
	RequestID             string
	ToolInput             json.RawMessage
	ToolUseID             string
	PermissionSuggestions []PermissionUpdate
}

// StartOptions contains options for starting an agent session.
type StartOptions struct {
	WorkDir string
	// DataDir is this session's own data directory (per-worktree). Agent
	// session-scoped state — resume mapping, history migration lookups — lives
	// under DataDir/sessions/<id>, co-located with the session store that owns
	// the session. For a named worktree this is the worktree's data dir, not the
	// main one.
	DataDir string
	// MCPServerDir is the directory holding the running server's server.json, which
	// the MCP stdio proxy reads to discover and forward to the local API. There is
	// a single server per process, so this is always the main data dir regardless
	// of worktree — a worktree's DataDir has no server.json. Empty falls back to
	// DataDir (single-dir setups and tests that don't split the two).
	MCPServerDir string
	// Worktree is the name of the worktree this session lives in, empty for the
	// main one. Not a path: it is the identity the MCP proxy reports alongside
	// SessionID, and the same name the work store and the registry use.
	Worktree  string
	SessionID string
	Resume    bool
	Mode      session.Mode
	// Model is the agent-specific model id (session.ModelsForAgent). Empty means
	// pass no model flag and let the CLI pick.
	Model string
	// Effort is the agent-specific reasoning effort level
	// (session.EffortsForAgent). Empty means pass nothing and let the CLI keep
	// its own default.
	Effort     string
	DisableMCP bool // skip MCP config (for testing)

	// OnUsage receives what the CLI reports about the session's consumption, as
	// increments ready to be added to the session's totals. Agents feed it through
	// UsageAccumulator rather than calling it directly.
	//
	// A callback rather than a second event channel: usage is state the session
	// store owns, not a record of what happened in the conversation, and
	// everything on the event channel is persisted into history and broadcast to
	// chat clients. See the "events are events, state is state" rule in AGENTS.md.
	//
	// Called synchronously from the goroutine reading the CLI's output, which is
	// also the goroutine that hands events on, so an implementation holds up the
	// stream for as long as it takes. process.Manager's implementation writes the
	// session index, which is the same order of cost as the history append already
	// on that path — but nothing slower belongs here. nil is allowed and means
	// nobody is counting.
	OnUsage func(session.UsageReport)
}

// MCPDir returns the directory to point the MCP proxy at (where server.json
// lives), falling back to DataDir when MCPServerDir is unset.
func (o StartOptions) MCPDir() string {
	if o.MCPServerDir != "" {
		return o.MCPServerDir
	}
	return o.DataDir
}

// Agent defines the interface for an AI agent. What an agent can do beyond
// starting a session is said by the optional interfaces it implements, not by
// declarations here — SessionForker is the one that exists today.
type Agent interface {
	// Start launches a persistent agent process and returns a Session.
	// The process stays alive until the context is cancelled or Close is called.
	Start(ctx context.Context, opts StartOptions) (Session, error)
}

// Session represents an active agent session with bidirectional communication.
// The process persists across multiple messages within the same session.
type Session interface {
	// Events returns the channel that streams all events from the agent process.
	// The channel remains open until the process terminates.
	// A turn ends with exactly one event whose type AwaitsUserInput: done when it
	// completed, error when it failed, interrupted when it was aborted, or a
	// permission/question request when it is blocked on the user.
	//
	// Nothing is promised about how long a turn takes or how often it produces
	// events. A turn can span a wait for background work, over which no event
	// arrives at all for as long as that work runs — so silence must never be
	// read as an ending. A session that parks a turn that way says so with a
	// BackgroundWaitEvent first, and resumes by producing content again.
	//
	// A consumer keeps receiving until the channel closes. That is what the
	// session's last event counts on (see EmitProcessEnded), and the goroutine
	// holding the channel open is the one a caller waits for when closing a
	// process.
	Events() <-chan AgentEvent

	// SendMessage sends a new message to the agent. Callers may send before the
	// current turn has ended, and both CLIs Pockode ships do the same thing with
	// one: they steer the running turn rather than starting a second one, so the
	// two messages share one turn and therefore one ending. Measured on
	// claude-code 2.1.263 and codex-cli 0.153.0 — Codex's second turn/start
	// returns the id of the turn already running, and Claude's turn acts on the
	// new message and then ends once. Nothing here counts endings per message.
	//
	// One ending per turn is not one *answer* per turn, and reading it as that
	// is what this signature's ID field exists to correct: the agent reads the
	// second message partway through the turn and answers it from there, so a
	// turn can hold the answers to several messages. Where the boundary between
	// them falls is MessageIngestedEvent's business.
	//
	// The exception is a turn blocked on a permission request: the CLI is inside
	// the tool call waiting for that decision and reads nothing else until it
	// arrives, so a message sent then is not delivered at all — neither CLI
	// produced a single further event in the four minutes after one. The send path
	// refuses those rather than letting them vanish; see
	// chat.ErrTurnAwaitingAnswer.
	SendMessage(prompt Prompt) error

	// SendPermissionResponse sends a permission response to the agent.
	SendPermissionResponse(data PermissionRequestData, choice PermissionChoice) error

	// SendInterrupt sends an interrupt signal to stop the current task.
	// This is a soft stop that preserves the session for future messages.
	//
	// Returning is not the stop landing: the InterruptedEvent on Events is what
	// says the turn ended.
	//
	// A stop may arrive before the CLI has said a turn is under way, and an
	// implementation must not drop it for that: the user pressed stop, and a
	// stop that goes nowhere leaves the work running with nothing to say so.
	// What this costs varies. Claude's interrupt names no turn, so there is
	// nothing to wait for; Codex's has to name one, and holds the stop until the
	// turn tells it its id (see codex.appSession.SendInterrupt).
	SendInterrupt() error

	// Close terminates the agent process and releases resources.
	Close()
}

// Prompt is one message on its way to the agent.
//
// A struct rather than the string it used to be because a message is not only
// its text: Pockode needs to be able to recognise the agent reading this
// particular one later, and an agent that can say so says it in terms of the id
// it was handed here.
type Prompt struct {
	// Text is what the agent reads.
	Text string
	// ID is Pockode's own id for the message record this text came from, for an
	// agent that can carry an id through and echo it back when it reads the
	// message (see MessageIngestReporter). An agent that cannot has nothing to do
	// with it. Empty when the message has no record to name — nothing downstream
	// may then claim it does.
	ID string
}

// MessageIngestReporter is implemented by agent sessions that say for
// themselves when the agent has taken a message in, by emitting a
// MessageIngestedEvent.
//
// It exists so that the difference between the CLIs stops inside the server. An
// agent that implements this is the only one that knows its own read point, so
// Pockode must not guess one for it; an agent that does not gets the
// conservative approximation written for it at the moment the message is handed
// over (chat.Client.sendEvent). Clients are told neither way: they see one kind
// of record and follow one rule.
//
// The marker method carries no information because there is none to carry:
// either the events arrive or they do not.
type MessageIngestReporter interface {
	ReportsMessageIngest()
}

// SessionNotifier is implemented by agent sessions that can carry a message from
// Pockode to the agent, delivered with the next prompt it is sent.
//
// It exists for the one thing Pockode does that the agent cannot see: ending a
// turn the agent did not end. When a background wait's lease runs out the user
// gets a warning in the transcript, and this is the agent's copy of the same
// news — without it the agent is auto-continued with no idea that Pockode
// stopped waiting for the background task it is still expecting a result from.
//
// Optional, because there is nowhere to put a note in a protocol that has no
// room for one. An agent that does not implement it loses nothing it had: the
// note is an explanation, never a correction, and the transcript carries the
// fact regardless.
type SessionNotifier interface {
	// QueueNote replaces any note not yet delivered. Notes are explanations of
	// something that has just happened, and the newer one is the one that is
	// still true.
	QueueNote(note string)
}
