package session

import (
	"errors"
	"time"
)

var ErrSessionNotFound = errors.New("session not found")

// AgentType identifies which AI agent backend a session uses.
type AgentType string

const (
	AgentTypeClaude AgentType = "claude"
	AgentTypeCodex  AgentType = "codex"
)

// IsValid returns true if the agent type is a known valid type.
func (a AgentType) IsValid() bool {
	switch a {
	case AgentTypeClaude, AgentTypeCodex:
		return true
	default:
		return false
	}
}

// Mode represents the agent mode for a session.
type Mode string

const (
	ModeDefault Mode = "default" // Normal mode with permission prompts
	// Each agent gives up its own gate: Claude runs with
	// --permission-mode bypassPermissions, Codex with approval-policy "never"
	// and its sandbox at danger-full-access. See agent/claude/claude.go and
	// agent/codex/codex.go buildStartConfig.
	ModeYolo Mode = "yolo"
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
// These fields represent the conversation's state, not the process's state.
// A process may be created, reaped, and recreated many times within a single
// session, but NeedsInput and Unread persist across those process lifecycles.
type SessionMeta struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
	Activated bool      `json:"activated"`  // true once the agent has produced output
	AgentType AgentType `json:"agent_type"` // which AI backend (claude, codex)
	Mode      Mode      `json:"mode"`       // agent mode (default, yolo, plan)
	// Model is agent-specific (see model.go). Empty — the value every session
	// created before this field existed carries — means no model flag is passed
	// and the CLI picks for itself.
	Model string `json:"model"`
	// Effort is agent-specific (see effort.go). Empty — the value every session
	// created before this field existed carries — means the CLI is passed no
	// effort level and keeps its own default.
	Effort     string `json:"effort"`
	NeedsInput bool   `json:"needs_input"` // true when waiting for user input (permission/question)
	Unread     bool   `json:"unread"`      // true when session has unread changes
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
