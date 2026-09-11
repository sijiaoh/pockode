package session

import "errors"

// ErrModelNotAvailable is returned when a model does not belong to the agent
// type it was selected for.
var ErrModelNotAvailable = errors.New("model not available for this agent type")

// ModelOption is one selectable model for an agent.
type ModelOption struct {
	// ID is the value handed to the CLI (`claude --model <id>`, and the `model`
	// field of Codex's `codex` tool call).
	ID    string `json:"id"`
	Label string `json:"label"`
}

// agentModels is the single authoritative list of selectable models, used both
// to validate a choice and to answer `session.models` for the UI. Neither CLI
// can list its models (no subcommand does it on claude 2.1.263 / codex-cli
// 0.153.0), so this is maintained by hand and needs an update whenever an agent
// retires a model.
//
// An empty model is always valid and means "pass no model flag, let the CLI
// pick" — it is the default for new and pre-existing sessions, so the lists hold
// only explicit choices.
//
// Claude is listed by alias rather than by full model name: an alias always
// resolves to the newest model of its family, so the list does not go stale
// every release. The aliases come from the CLI's own accepted set
// (`claude --help`, `--model`). Codex has no such aliases, so its models are
// listed by slug, as its own model catalog spells them.
var agentModels = map[AgentType][]ModelOption{
	AgentTypeClaude: {
		{ID: "opus", Label: "Opus"},
		{ID: "sonnet", Label: "Sonnet"},
		{ID: "haiku", Label: "Haiku"},
		{ID: "fable", Label: "Fable"},
	},
	AgentTypeCodex: {
		{ID: "gpt-5.6-sol", Label: "GPT-5.6 Sol"},
		{ID: "gpt-5.6-terra", Label: "GPT-5.6 Terra"},
		{ID: "gpt-5.6-luna", Label: "GPT-5.6 Luna"},
	},
}

// ModelsForAgent returns the models selectable for an agent type, excluding the
// implicit "let the CLI decide" choice.
func ModelsForAgent(agentType AgentType) []ModelOption {
	return agentModels[agentType]
}

// AllModels returns the selectable models of every agent type. The UI needs all
// of them at once: switching a session's agent changes which list applies.
func AllModels() map[AgentType][]ModelOption {
	return agentModels
}

// IsValidModel reports whether a model can be used with an agent type. The
// empty model is valid for every agent and means "let the CLI decide".
func IsValidModel(agentType AgentType, model string) bool {
	if model == "" {
		return true
	}
	for _, m := range agentModels[agentType] {
		if m.ID == model {
			return true
		}
	}
	return false
}
