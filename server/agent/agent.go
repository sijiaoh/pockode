package agent

import "context"

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
	// allow indicates whether the user approved the action.
	SendPermissionResponse(requestID string, allow bool) error

	// SendInterrupt sends an interrupt signal to stop the current task.
	// This is a soft stop that preserves the session for future messages.
	SendInterrupt() error

	// Close terminates the agent process and releases resources.
	Close()
}
