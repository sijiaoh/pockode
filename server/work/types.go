package work

import (
	"errors"
	"time"
)

type Comment struct {
	ID        string    `json:"id"`
	WorkID    string    `json:"work_id"`
	Body      string    `json:"body"`
	CreatedAt time.Time `json:"created_at"`
}

var (
	ErrWorkNotFound    = errors.New("work not found")
	ErrCommentNotFound = errors.New("comment not found")
	ErrInvalidWork     = errors.New("invalid work")
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
	StatusNeedsInput WorkStatus = "needs_input" // agent waiting for user confirmation
	StatusWaiting    WorkStatus = "waiting"     // agent waiting for child work to complete
	StatusStopped    WorkStatus = "stopped"     // agent session ended abnormally (retry limit, interrupt, orphan)
	StatusDone       WorkStatus = "done"        // direct work complete, children may be pending
	StatusClosed     WorkStatus = "closed"      // fully complete (auto-derived, never set directly)
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
	CurrentStep int        `json:"current_step,omitempty"` // 0-indexed; used only when agent role has Steps
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

type CommentEvent struct {
	Comment Comment
}

// OnCommentChangeListener receives notifications when comments are added.
// Same mutex contract as OnChangeListener applies.
type OnCommentChangeListener interface {
	OnCommentChange(event CommentEvent)
}
