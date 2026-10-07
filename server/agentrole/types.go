package agentrole

import (
	"errors"
	"fmt"
	"time"

	"github.com/pockode/server/session"
	"github.com/pockode/server/work"
)

var (
	ErrNotFound    = errors.New("agent role not found")
	ErrInvalidRole = errors.New("invalid agent role")
)

type AgentRole struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	RolePrompt string   `json:"role_prompt"`
	Steps      []string `json:"steps,omitempty"`
	// AgentType is the agent a session started for this role runs on. Empty —
	// the value every role created before this field existed carries — means the
	// role expresses no preference and the global default agent type applies.
	AgentType session.AgentType `json:"agent_type,omitempty"`
	// Model is agent-specific (see session/model.go) and only meaningful
	// alongside an AgentType: without one, there is no list to judge it against.
	// Empty means no model flag is passed and the CLI picks for itself.
	Model string `json:"model,omitempty"`
	// Effort is agent-specific (see session/effort.go), with the same dependency
	// on AgentType as Model. Empty means the CLI keeps its own default.
	Effort string `json:"effort,omitempty"`
	// WorkType is the kind of work item this role may be assigned to. Empty —
	// what every role created before this field existed carries — means the role
	// takes either kind. Judge it with AcceptsWorkType, never by comparing it.
	WorkType  work.WorkType `json:"work_type,omitempty"`
	CreatedAt time.Time     `json:"created_at"`
	UpdatedAt time.Time     `json:"updated_at"`
}

// Engine is the role's preference for the sessions started under it. An empty
// AgentType means the role expresses no preference and the global default
// applies; see settings.Settings.ResolveEngine for how the two combine.
func (r AgentRole) Engine() session.Engine {
	return session.Engine{
		AgentType: r.AgentType,
		Model:     r.Model,
		Effort:    r.Effort,
	}
}

// AcceptsWorkType reports whether this role may be assigned to a work item of
// type t. It is the single answer to that question: anything that filters roles
// or refuses an assignment asks here, so "empty means any" is decided once.
func (r AgentRole) AcceptsWorkType(t work.WorkType) bool {
	return r.WorkType == "" || r.WorkType == t
}

// ValidateWorkType checks a role's WorkType: a known work type, or empty for no
// restriction.
func ValidateWorkType(t work.WorkType) error {
	if t == "" || t.Valid() {
		return nil
	}
	return fmt.Errorf("%w: work_type must be %q, %q or empty, got %q", ErrInvalidRole, work.WorkTypeStory, work.WorkTypeTask, t)
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

// Steps adapts a Store to the "how many steps does this role define" question,
// which is the only thing the work layer ever asks of a role. It satisfies
// work.StepProvider and work.StepCounter structurally, so the work package does
// not have to import this one.
type Steps struct {
	Store Store
}

// GetSteps returns the role's steps. A role that does not exist is an error and
// not an empty list: a work whose role has been deleted must not quietly become
// a stepless one, whose very first step_done would close it.
func (s Steps) GetSteps(agentRoleID string) ([]string, error) {
	role, found, err := s.Store.Get(agentRoleID)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, fmt.Errorf("%w: %s", ErrNotFound, agentRoleID)
	}
	return role.Steps, nil
}
