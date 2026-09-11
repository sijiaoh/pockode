package session

import "errors"

// ErrEffortNotAvailable is returned when an effort level does not belong to the
// agent type it was selected for.
var ErrEffortNotAvailable = errors.New("effort not available for this agent type")

// agentEfforts is the single authoritative list of selectable effort levels,
// used both to validate a choice and to answer `session.efforts` for the UI. An
// id from it reaches the CLI as `claude --effort <id>`, or as Codex's
// `model_reasoning_effort` config key.
//
// An empty effort is always valid and means "pass nothing, let the CLI keep its
// own default" — it is the default for new and pre-existing sessions, so the
// lists hold only explicit choices.
//
// An agent with no notion of effort simply has no entry here: EffortsForAgent
// answers it with an empty list and the `session.efforts` payload leaves the
// agent out of the map entirely. That absence is what tells the UI there is
// nothing to offer, as opposed to nothing having arrived yet.
//
// Effort is listed per agent, not per model: `claude --effort` is a session flag
// whose accepted levels do not vary with the model, and every model in model.go's
// Codex list reports the same accepted set (checked by sending each an invalid
// level and reading back the enum the API answers with). Should a future model
// narrow its set, it refuses the level itself — encoding a per-model matrix here
// would mean maintaining by hand a table neither CLI publishes.
//
// Values verified on the CLIs installed here:
//   - claude 2.1.263: `claude --help` documents `--effort <level>` as
//     "(low, medium, high, xhigh, max)", and an unknown level is answered with
//     "Valid values: low, medium, high, xhigh, max".
//   - codex-cli 0.153.0: the CLI passes `model_reasoning_effort` through to the
//     API unvalidated; the API answers an unknown level with "Supported values
//     are: 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', and 'max'".
//     'none' is left out: a coding agent that does not reason at all is not a
//     level worth offering.
var agentEfforts = map[AgentType][]AgentOption{
	AgentTypeClaude: {
		{ID: "low", Label: "Low"},
		{ID: "medium", Label: "Medium"},
		{ID: "high", Label: "High"},
		{ID: "xhigh", Label: "Extra High"},
		{ID: "max", Label: "Max"},
	},
	AgentTypeCodex: {
		{ID: "minimal", Label: "Minimal"},
		{ID: "low", Label: "Low"},
		{ID: "medium", Label: "Medium"},
		{ID: "high", Label: "High"},
		{ID: "xhigh", Label: "Extra High"},
		{ID: "max", Label: "Max"},
	},
}

// EffortsForAgent returns the effort levels selectable for an agent type,
// excluding the implicit "let the CLI decide" choice. An agent with no effort
// concept returns an empty list.
func EffortsForAgent(agentType AgentType) []AgentOption {
	return agentEfforts[agentType]
}

// AllEfforts returns the selectable effort levels of every agent type that has
// any. The UI needs all of them at once: switching a session's agent changes
// which list applies, and an agent missing from the result is how it learns that
// agent has no effort setting at all.
func AllEfforts() map[AgentType][]AgentOption {
	return agentEfforts
}

// IsValidEffort reports whether an effort level can be used with an agent type.
// The empty effort is valid for every agent — including one with no effort
// concept at all — and means "let the CLI decide".
func IsValidEffort(agentType AgentType, effort string) bool {
	return isOffered(agentEfforts, agentType, effort)
}
