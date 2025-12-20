package agent

import "context"

// Agent defines the interface for an AI agent.
type Agent interface {
	// Run executes the agent with the given prompt.
	// It returns a channel of events that will be closed when the agent finishes.
	// The context can be used to cancel the execution.
	Run(ctx context.Context, prompt string, workDir string) (<-chan AgentEvent, error)
}
