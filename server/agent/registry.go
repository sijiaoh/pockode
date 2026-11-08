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

// ForkSupports returns what every registered agent says about being forked.
//
// Clients get this table rather than a yes/no per session: fork support belongs
// to the agent, not to any one session that happens to use it, and a copy made
// per session would be a second place for the same fact to be told from.
func (r *Registry) ForkSupports() map[session.AgentType]ForkSupport {
	supports := make(map[session.AgentType]ForkSupport, len(r.agents))
	for agentType, a := range r.agents {
		supports[agentType] = ForkSupportOf(a)
	}
	return supports
}

func (r *Registry) Get(agentType session.AgentType) (Agent, error) {
	a, ok := r.agents[agentType]
	if !ok {
		return nil, fmt.Errorf("unknown agent type: %q", agentType)
	}
	return a, nil
}

// OneShot returns the agent of agentType as a OneShotRunner, for an agent that
// is registered and can answer one.
func (r *Registry) OneShot(agentType session.AgentType) (OneShotRunner, error) {
	a, err := r.Get(agentType)
	if err != nil {
		return nil, err
	}
	runner, ok := a.(OneShotRunner)
	if !ok {
		return nil, fmt.Errorf("agent %q cannot answer one-shot requests", agentType)
	}
	return runner, nil
}
