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
	WorkDir      string
	SessionID    string
	Resume       bool
	Mode         session.Mode
	SystemPrompt string // Custom system prompt (overrides default)
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
