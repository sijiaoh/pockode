package agent

import "context"

// PermissionChoice represents the user's decision on a permission request.
type PermissionChoice int

const (
	PermissionDeny        PermissionChoice = iota // Deny the request
	PermissionAllow                               // Allow this one request
	PermissionAlwaysAllow                         // Allow and persist for future requests
)

// Agent defines the interface for an AI agent.
type Agent interface {
	// Start launches a persistent agent process and returns a Session.
	// The process stays alive until the context is cancelled or Close is called.
	Start(ctx context.Context, workDir string, sessionID string, resume bool) (Session, error)
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
	// requestID is the ID from EventTypePermissionRequest.
	// choice indicates the user's decision (deny, allow once, or always allow).
	SendPermissionResponse(requestID string, choice PermissionChoice) error

	// SendQuestionResponse sends answers to user questions.
	// requestID is the ID from EventTypeAskUserQuestion.
	// answers maps question text to selected option label(s).
	// If answers is nil, the question is cancelled (deny response sent).
	SendQuestionResponse(requestID string, answers map[string]string) error

	// SendInterrupt sends an interrupt signal to stop the current task.
	// This is a soft stop that preserves the session for future messages.
	SendInterrupt() error

	// Close terminates the agent process and releases resources.
	Close()
}
