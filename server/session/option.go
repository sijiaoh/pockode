package session

// AgentOption is one selectable value for a per-session setting the agent
// decides — a model or an effort level. One shape for both because they are one
// kind of thing: a list the server compiles in, answers the UI with, and
// validates a choice against, so the UI can only offer what the server would
// accept. The frontend's `AgentOption` is the same type by the same name.
type AgentOption struct {
	// ID is the value handed to the CLI; see model.go and effort.go for how
	// each CLI is told about it.
	ID    string `json:"id"`
	Label string `json:"label"`
}

// isOffered reports whether an agent type offers an option id. The empty id is
// offered by every agent — including one with no list at all — and means "pass
// nothing, let the CLI decide".
func isOffered(lists map[AgentType][]AgentOption, agentType AgentType, id string) bool {
	if id == "" {
		return true
	}
	for _, o := range lists[agentType] {
		if o.ID == id {
			return true
		}
	}
	return false
}
