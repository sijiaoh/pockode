package settings

import (
	"testing"

	"github.com/pockode/server/session"
)

func TestValidateWorktreeBaseDir(t *testing.T) {
	tests := []struct {
		name    string
		path    string
		wantErr bool
	}{
		{"empty uses default", "", false},
		{"absolute clean path", "/var/pockode/worktrees", false},
		{"repo-relative dot path", "./worktrees", false},
		{"repo-relative parent path", "../worktrees", false},
		{"repo-relative parent alone", "..", false},
		{"repo-relative deep parent", "../../shared/worktrees", false},
		{"home-relative path", "~/worktrees", false},
		{"home alone", "~", false},
		{"bare relative path rejected", "worktrees", true},
		{"repo-relative interior traversal rejected", "./a/../b", true},
		{"home-relative escape rejected", "~/../escape", true},
		{"traversal segment rejected", "/var/pockode/../worktrees", true},
		{"trailing separator rejected", "/var/worktrees/", true},
		{"redundant separator rejected", "/var//worktrees", true},
		{"home redundant separator rejected", "~//worktrees", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateWorktreeBaseDir(tt.path)
			if (err != nil) != tt.wantErr {
				t.Errorf("ValidateWorktreeBaseDir(%q) error = %v, wantErr = %v", tt.path, err, tt.wantErr)
			}
		})
	}
}

// TestSettings_ResolveEngine states the whole precedence rule in one table: the
// role decides, the global defaults fill in what it left open, and the global
// model and effort only travel as far as the agent they were chosen for.
func TestSettings_ResolveEngine(t *testing.T) {
	global := Settings{
		DefaultAgentType: session.AgentTypeClaude,
		DefaultModel:     "opus",
		DefaultEffort:    "high",
	}

	tests := []struct {
		name     string
		settings Settings
		role     session.Engine
		want     session.Engine
	}{
		{
			name:     "no role preference takes the global engine whole",
			settings: global,
			role:     session.Engine{},
			want:     session.Engine{AgentType: session.AgentTypeClaude, Model: "opus", Effort: "high"},
		},
		{
			name:     "role naming the global agent still gets its model and effort",
			settings: global,
			role:     session.Engine{AgentType: session.AgentTypeClaude},
			want:     session.Engine{AgentType: session.AgentTypeClaude, Model: "opus", Effort: "high"},
		},
		{
			name:     "role naming another agent leaves the global model behind",
			settings: global,
			role:     session.Engine{AgentType: session.AgentTypeCodex},
			want:     session.Engine{AgentType: session.AgentTypeCodex},
		},
		{
			name:     "role keeps its own model and effort",
			settings: global,
			role:     session.Engine{AgentType: session.AgentTypeClaude, Model: "haiku", Effort: "low"},
			want:     session.Engine{AgentType: session.AgentTypeClaude, Model: "haiku", Effort: "low"},
		},
		{
			name:     "the global default fills only the half the role left open",
			settings: global,
			role:     session.Engine{AgentType: session.AgentTypeClaude, Model: "haiku"},
			want:     session.Engine{AgentType: session.AgentTypeClaude, Model: "haiku", Effort: "high"},
		},
		{
			name:     "nothing set anywhere falls back to the built-in agent",
			settings: Settings{},
			role:     session.Engine{},
			want:     session.Engine{AgentType: session.DefaultAgentType},
		},
		{
			// The agent setting is one a user may never touch, and sessions run on
			// the built-in default meanwhile — so a model picked for that default
			// has to apply rather than wait for the agent to be set explicitly.
			name:     "a global model applies under an agent the user never set",
			settings: Settings{DefaultModel: "opus"},
			role:     session.Engine{},
			want:     session.Engine{AgentType: session.DefaultAgentType, Model: "opus"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := tt.settings.ResolveEngine(tt.role)
			if got != tt.want {
				t.Errorf("ResolveEngine(%+v) = %+v, want %+v", tt.role, got, tt.want)
			}
			if err := session.ValidateEngine(got); err != nil {
				t.Errorf("resolved engine is not runnable: %v", err)
			}
		})
	}
}
