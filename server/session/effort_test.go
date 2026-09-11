package session

import "testing"

func TestIsValidEffort(t *testing.T) {
	// Levels are read off the lists rather than written out: the lists are
	// maintained by hand against the CLIs' own accepted sets, and a test that
	// named a level would fail the day a CLI renames one, for no reason of its
	// own.
	claudeEffort := EffortsForAgent(AgentTypeClaude)[0].ID

	tests := []struct {
		name      string
		agentType AgentType
		effort    string
		want      bool
	}{
		{"empty means CLI default", AgentTypeClaude, "", true},
		{"listed claude effort", AgentTypeClaude, claudeEffort, true},
		{"listed codex effort", AgentTypeCodex, EffortsForAgent(AgentTypeCodex)[0].ID, true},
		{"unknown effort", AgentTypeClaude, "no-such-effort", false},
		// An agent with no effort concept at all takes no level but still takes
		// the empty one, so a session never gets stuck on an unsettable field.
		{"agent without efforts takes none", AgentType("gemini"), claudeEffort, false},
		{"agent without efforts still takes empty", AgentType("gemini"), "", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := IsValidEffort(tt.agentType, tt.effort); got != tt.want {
				t.Errorf("IsValidEffort(%q, %q) = %v, want %v", tt.agentType, tt.effort, got, tt.want)
			}
		})
	}
}

// Every listed level must pass validation: the list is both what the UI offers
// and what the RPC handler accepts, so a typo in one id would offer the user a
// choice the server then rejects.
func TestAllEfforts_AreValid(t *testing.T) {
	for agentType, efforts := range AllEfforts() {
		if !agentType.IsValid() {
			t.Errorf("efforts listed for unknown agent type %q", agentType)
		}
		for _, e := range efforts {
			if e.ID == "" || e.Label == "" {
				t.Errorf("%q: effort with empty id or label: %+v", agentType, e)
			}
			if !IsValidEffort(agentType, e.ID) {
				t.Errorf("%q: listed effort %q fails validation", agentType, e.ID)
			}
		}
	}
}
