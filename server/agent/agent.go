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

// QuestionRequestData contains the data needed to send a question response.
type QuestionRequestData struct {
	RequestID string
	ToolUseID string
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
	SessionID    string
	Resume       bool
	Mode         session.Mode
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
	// read as an ending (see BackgroundWaiter).
	Events() <-chan AgentEvent

	// SendMessage sends a new message to the agent. Callers may send before the
	// current turn has ended; what happens then is up to the CLI. Claude queues
	// the message; Codex steers the running turn with it, so the two messages
	// share one turn and therefore one ending (verified on codex-cli 0.153.0 —
	// the second turn/start returns the id of the turn already running).
	SendMessage(prompt string) error

	// SendPermissionResponse sends a permission response to the agent.
	SendPermissionResponse(data PermissionRequestData, choice PermissionChoice) error

	// SendQuestionResponse sends answers to user questions.
	// If answers is nil, the question is cancelled (deny response sent).
	SendQuestionResponse(data QuestionRequestData, answers map[string]string) error

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

// BackgroundWaiter is implemented by sessions whose turn can be held open while
// no events flow at all.
//
// A Claude turn that started a background task ends with a result frame the CLI
// later continues from on its own; Pockode swallows that ending so the turn
// reads as one long thought. Nothing is emitted for the length of the wait, so
// anything that measures liveness by events alone — the idle reaper — would
// conclude the process is abandoned and kill it, taking the background tasks
// with it.
//
// Optional: agents without the concept simply do not implement it.
type BackgroundWaiter interface {
	// WaitingForBackgroundWork reports whether the session is currently holding
	// a turn open for background work. It is always eventually false: the wait
	// has a budget, after which the turn ends the ordinary way.
	WaitingForBackgroundWork() bool
}
