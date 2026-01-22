package process

import "github.com/pockode/server/agent"

// ChatMessage represents a chat message with its session context.
type ChatMessage struct {
	SessionID string
	Event     agent.AgentEvent
}

// ChatMessageListener receives chat messages from ProcessManager.
type ChatMessageListener interface {
	OnChatMessage(msg ChatMessage)
}
