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
	DisableMCP   bool // skip MCP config (for testing)
}

// MCPDir returns the directory to point the MCP proxy at (where server.json
// lives), falling back to DataDir when MCPServerDir is unset.
func (o StartOptions) MCPDir() string {
	if o.MCPServerDir != "" {
		return o.MCPServerDir
	}
	return o.DataDir
}

// Agent defines the interface for an AI agent.
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
	// EventTypeDone signals the current message response is complete.
	Events() <-chan AgentEvent

	// SendMessage sends a new message to the agent.
	// It should only be called after the previous message is complete (received EventTypeDone).
	SendMessage(prompt string) error

	// SendPermissionResponse sends a permission response to the agent.
	SendPermissionResponse(data PermissionRequestData, choice PermissionChoice) error

	// SendQuestionResponse sends answers to user questions.
	// If answers is nil, the question is cancelled (deny response sent).
	SendQuestionResponse(data QuestionRequestData, answers map[string]string) error

	// SendInterrupt sends an interrupt signal to stop the current task.
	// This is a soft stop that preserves the session for future messages.
	SendInterrupt() error

	// Close terminates the agent process and releases resources.
	Close()
}
