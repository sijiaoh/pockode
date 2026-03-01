package agent

import (
	"fmt"

	"github.com/pockode/server/session"
)

// Registry maps agent types to their implementations.
type Registry struct {
	agents map[session.AgentType]Agent
}

func NewRegistry() *Registry {
	return &Registry{agents: make(map[session.AgentType]Agent)}
}

func (r *Registry) Register(agentType session.AgentType, a Agent) {
	r.agents[agentType] = a
}

func (r *Registry) Get(agentType session.AgentType) (Agent, error) {
	a, ok := r.agents[agentType]
	if !ok {
		return nil, fmt.Errorf("unknown agent type: %q", agentType)
	}
	return a, nil
}
