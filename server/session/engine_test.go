package session

import "testing"

// ValidateEngine is the one check behind every engine submitted whole — an agent
// role, the global defaults — so its rules are pinned here rather than in each
// caller. A session is judged value by value instead and does not come through
// here.
func TestValidateEngine(t *testing.T) {
	tests := []struct {
		name    string
		engine  Engine
		wantErr bool
	}{
		{name: "empty defers everything", engine: Engine{}},
		{name: "agent alone", engine: Engine{AgentType: AgentTypeClaude}},
		{name: "whole trio", engine: Engine{AgentType: AgentTypeCodex, Model: "gpt-5.6-sol", Effort: "high"}},
		{name: "unknown agent", engine: Engine{AgentType: "gemini"}, wantErr: true},
		{name: "model from another agent", engine: Engine{AgentType: AgentTypeClaude, Model: "gpt-5.6-sol"}, wantErr: true},
		{name: "effort from another agent", engine: Engine{AgentType: AgentTypeClaude, Model: "opus", Effort: "minimal"}, wantErr: true},
		{name: "model with no agent to belong to", engine: Engine{Model: "opus"}, wantErr: true},
		{name: "effort with no agent to belong to", engine: Engine{Effort: "high"}, wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateEngine(tt.engine)
			if (err != nil) != tt.wantErr {
				t.Errorf("ValidateEngine(%+v) error = %v, wantErr %v", tt.engine, err, tt.wantErr)
			}
		})
	}
}
