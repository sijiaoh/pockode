package work

import (
	"errors"
	"time"
)

var (
	ErrWorkNotFound = errors.New("work not found")
	ErrInvalidWork  = errors.New("invalid work")
)

type WorkType string

const (
	WorkTypeStory WorkType = "story"
	WorkTypeTask  WorkType = "task"
)

type WorkStatus string

const (
	StatusOpen       WorkStatus = "open"
	StatusInProgress WorkStatus = "in_progress"
	StatusDone       WorkStatus = "done"   // direct work complete, children may be pending
	StatusClosed     WorkStatus = "closed" // fully complete (auto-derived, never set directly)
)

type Work struct {
	ID          string     `json:"id"`
	Type        WorkType   `json:"type"`
	ParentID    string     `json:"parent_id,omitempty"`
	AgentRoleID string     `json:"agent_role_id,omitempty"`
	Title       string     `json:"title"`
	Body        string     `json:"body,omitempty"`
	Status      WorkStatus `json:"status"`
	SessionID   string     `json:"session_id,omitempty"`
	CreatedAt   time.Time  `json:"created_at"`
	UpdatedAt   time.Time  `json:"updated_at"`
}

type Operation string

const (
	OperationCreate Operation = "create"
	OperationUpdate Operation = "update"
	OperationDelete Operation = "delete"
)

type ChangeEvent struct {
	Op       Operation
	Work     Work
	External bool // true when the change originated from another process (fsnotify)
}

// OnChangeListener receives notifications when Work items change.
//
// Contract: OnWorkChange is called outside the store's mutex, but listeners
// that call back into the store (e.g. AutoResumer.handleParentReactivation)
// MUST do so in a separate goroutine to avoid re-entrant deadlock:
// notify → listener → store.Update → notify would deadlock if synchronous.
type OnChangeListener interface {
	OnWorkChange(event ChangeEvent)
}
