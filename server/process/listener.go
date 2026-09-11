package process

import (
	"github.com/pockode/server/agent"
	"github.com/pockode/server/session"
)

// ChatMessage represents a chat message with its session context.
type ChatMessage struct {
	SessionID string
	Event     agent.AgentEvent
	// Seq is where the event landed in the session's history, so a client can
	// name the record later — see session.HistorySeq. NoHistorySeq when the event
	// was not persisted, which is the one case a client has nothing to quote.
	Seq session.HistorySeq
}

// ChatMessageListener receives chat messages from ProcessManager.
type ChatMessageListener interface {
	OnChatMessage(msg ChatMessage)
}
