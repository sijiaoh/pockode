package session

import "fmt"

// Engine is the trio that decides which CLI a session runs on and how it runs:
// the agent type, and the model and effort chosen for that agent. The three
// travel together because model and effort are only meaningful next to the
// agent type they were picked from (see model.go and effort.go).
//
// Every field may be empty. An empty AgentType means "no preference" — whoever
// resolves the engine supplies one. An empty Model or Effort means no flag is
// passed and the CLI decides for itself.
type Engine struct {
	AgentType AgentType
	Model     string
	Effort    string
}

// DefaultAgentType is the agent a session runs on when nothing names one. It is
// exported rather than left as a fallback inside the session store because two
// places have to agree on it: the store, which stamps it onto a session created
// without an agent, and the global settings, which validate their default model
// against the agent an unset default will actually start sessions on.
const DefaultAgentType = AgentTypeClaude

// ResolveAgentType fills in DefaultAgentType for an agent type nobody named.
func ResolveAgentType(agentType AgentType) AgentType {
	if agentType == "" {
		return DefaultAgentType
	}
	return agentType
}

// ValidateEngine reports whether the trio is one an agent could actually run
// with. It is the check behind every place a whole engine is submitted at once —
// an agent role, the global defaults — so the same combination is accepted or
// refused wherever it is entered. A session is judged value by value against the
// same lists instead (FileStore.Create, SetModel, SetEffort), each of which has
// its agent type already settled and its own error to return.
func ValidateEngine(e Engine) error {
	if e.AgentType != "" && !e.AgentType.IsValid() {
		return fmt.Errorf("unknown agent type %q", e.AgentType)
	}
	if e.AgentType == "" {
		// Reported on its own rather than as "not available for agent", which
		// reads like the agent is at fault when what is missing is the agent the
		// value was supposed to be picked from in the first place.
		if e.Model != "" {
			return fmt.Errorf("model %q needs an agent type to belong to", e.Model)
		}
		if e.Effort != "" {
			return fmt.Errorf("effort %q needs an agent type to belong to", e.Effort)
		}
	}
	if !IsValidModel(e.AgentType, e.Model) {
		return fmt.Errorf("model %q is not available for agent %q", e.Model, e.AgentType)
	}
	if !IsValidEffort(e.AgentType, e.Effort) {
		return fmt.Errorf("effort %q is not available for agent %q", e.Effort, e.AgentType)
	}
	return nil
}
