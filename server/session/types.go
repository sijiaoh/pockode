package session

import (
	"errors"
	"time"
)

var ErrSessionNotFound = errors.New("session not found")

// Mode represents the agent mode for a session.
type Mode string

const (
	ModeDefault Mode = "default" // Normal mode with permission prompts
	ModeYolo    Mode = "yolo"    // Skip all permission prompts (--dangerously-skip-permissions)
	// ModePlan Mode = "plan"    // Planning mode (future)
)

// IsValid returns true if the mode is a known valid mode.
func (m Mode) IsValid() bool {
	switch m {
	case ModeDefault, ModeYolo:
		return true
	default:
		return false
	}
}

// SessionMeta holds metadata for a chat session.
type SessionMeta struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
	Activated bool      `json:"activated"` // true after first message sent
	Mode      Mode      `json:"mode"`      // agent mode (default, yolo, plan)
}

// Operation represents the type of change to the session list.
type Operation string

const (
	OperationCreate Operation = "create"
	OperationUpdate Operation = "update"
	OperationDelete Operation = "delete"
)

// SessionChangeEvent represents a change to the session list.
// For create/update: Session is fully populated.
// For delete: only Session.ID is valid.
type SessionChangeEvent struct {
	Op      Operation
	Session SessionMeta
}

// OnChangeListener receives notifications when the session list changes.
type OnChangeListener interface {
	OnSessionChange(event SessionChangeEvent)
}
