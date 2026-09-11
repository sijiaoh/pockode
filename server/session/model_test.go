package session

import "testing"

func TestIsValidModel(t *testing.T) {
	// Model ids are read off the lists rather than written out: the lists are
	// maintained by hand and a test that names a model would fail the day an
	// agent retires it, for no reason of its own.
	claudeModel := ModelsForAgent(AgentTypeClaude)[0].ID
	codexModel := ModelsForAgent(AgentTypeCodex)[0].ID

	tests := []struct {
		name      string
		agentType AgentType
		model     string
		want      bool
	}{
		{"empty means CLI default", AgentTypeClaude, "", true},
		{"empty means CLI default for codex too", AgentTypeCodex, "", true},
		{"listed claude model", AgentTypeClaude, claudeModel, true},
		{"listed codex model", AgentTypeCodex, codexModel, true},
		{"other agent's model", AgentTypeClaude, codexModel, false},
		{"unknown model", AgentTypeClaude, "no-such-model", false},
		{"unknown agent type", AgentType("gemini"), claudeModel, false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := IsValidModel(tt.agentType, tt.model); got != tt.want {
				t.Errorf("IsValidModel(%q, %q) = %v, want %v", tt.agentType, tt.model, got, tt.want)
			}
		})
	}
}

// Every listed model must pass validation: the list is both what the UI offers
// and what the RPC handler accepts, so a typo in one id would offer the user a
// choice the server then rejects.
func TestAllModels_AreValid(t *testing.T) {
	for agentType, models := range AllModels() {
		if !agentType.IsValid() {
			t.Errorf("models listed for unknown agent type %q", agentType)
		}
		if len(models) == 0 {
			t.Errorf("no models listed for %q", agentType)
		}
		for _, m := range models {
			if m.ID == "" || m.Label == "" {
				t.Errorf("%q: model with empty id or label: %+v", agentType, m)
			}
			if !IsValidModel(agentType, m.ID) {
				t.Errorf("%q: listed model %q fails validation", agentType, m.ID)
			}
		}
	}
}
