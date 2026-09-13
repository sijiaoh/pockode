package settings

import (
	"path/filepath"
	"runtime"
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
		{"repo-relative dot path", "./worktrees", false},
		{"repo-relative parent path", "../worktrees", false},
		{"repo-relative parent alone", "..", false},
		{"repo-relative deep parent", "../../shared/worktrees", false},
		{"home-relative path", "~/worktrees", false},
		{"home alone", "~", false},
		{"bare relative path rejected", "worktrees", true},
		{"repo-relative interior traversal rejected", "./a/../b", true},
		{"home-relative escape rejected", "~/../escape", true},
		{"home-relative deep escape rejected", "~/a/../../escape", true},
		{"home-relative rooted remainder rejected", "~//worktrees", true},
		{"trailing separator rejected", "./worktrees/", true},
		{"redundant separator rejected", "./var//worktrees", true},
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

// Absolute paths are spelled differently per platform, so they are checked
// against the running platform's forms rather than in the shared table above.
func TestValidateWorktreeBaseDir_Absolute(t *testing.T) {
	type testCase struct {
		name    string
		path    string
		wantErr bool
	}

	tests := []testCase{
		{"clean path", "/var/pockode/worktrees", false},
		{"traversal segment rejected", "/var/pockode/../worktrees", true},
		{"trailing separator rejected", "/var/worktrees/", true},
		{"redundant separator rejected", "/var//worktrees", true},
	}
	if runtime.GOOS == "windows" {
		tests = []testCase{
			{"clean drive path", `C:\pockode\worktrees`, false},
			{"clean drive path with forward slashes", "C:/pockode/worktrees", false},
			{"clean UNC path", `\\host\share\worktrees`, false},
			{"traversal segment rejected", `C:\pockode\..\worktrees`, true},
			{"trailing separator rejected", `C:\worktrees\`, true},
			{"redundant separator rejected", `C:\\worktrees`, true},
			{"drive-relative path rejected", `C:worktrees`, true},
			{"root-relative path rejected", `\worktrees`, true},
		}
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

// Windows users write `\` and cross-platform configs write `/`, so the two
// spellings must reach the same verdict: otherwise the most common setting
// (`../worktrees`) is unusable on Windows, or a traversal spelled the other way
// slips through. Which verdict is correct is the table above's job.
func TestValidateWorktreeBaseDir_SeparatorSpellingsAgree(t *testing.T) {
	paths := []string{
		"./worktrees",
		"../worktrees",
		"../../shared/worktrees",
		"~/worktrees",
		"./a/../b",
		"~/../escape",
		"~//worktrees",
		"worktrees/nested",
	}

	for _, path := range paths {
		t.Run(path, func(t *testing.T) {
			native := filepath.FromSlash(path)

			slashedErr := ValidateWorktreeBaseDir(path)
			nativeErr := ValidateWorktreeBaseDir(native)
			if (slashedErr != nil) != (nativeErr != nil) {
				t.Errorf("verdicts disagree: %q -> %v, %q -> %v", path, slashedErr, native, nativeErr)
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
