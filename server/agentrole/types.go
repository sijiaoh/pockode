package agentrole

import (
	"errors"
	"fmt"
	"time"

	"github.com/pockode/server/session"
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
	Effort    string    `json:"effort,omitempty"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
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
