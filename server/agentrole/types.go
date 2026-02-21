package agentrole

import (
	"errors"
	"time"
)

var (
	ErrNotFound    = errors.New("agent role not found")
	ErrInvalidRole = errors.New("invalid agent role")
)

type AgentRole struct {
	ID         string    `json:"id"`
	Name       string    `json:"name"`
	RolePrompt string    `json:"role_prompt"`
	CreatedAt  time.Time `json:"created_at"`
	UpdatedAt  time.Time `json:"updated_at"`
}

type Operation string

const (
	OperationCreate Operation = "create"
	OperationUpdate Operation = "update"
	OperationDelete Operation = "delete"
)

type ChangeEvent struct {
	Op   Operation
	Role AgentRole
}

// OnChangeListener receives notifications when AgentRole items change.
//
// Contract: OnAgentRoleChange is called outside the store's mutex, but
// listeners that call back into the store MUST do so in a separate goroutine
// to avoid re-entrant deadlock.
type OnChangeListener interface {
	OnAgentRoleChange(event ChangeEvent)
}
