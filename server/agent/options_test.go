package agent

import "testing"

func TestStartOptions_MCPDir(t *testing.T) {
	tests := []struct {
		name    string
		dataDir string
		mcpDir  string
		want    string
	}{
		{"split points at server dir", "/data/worktrees/wt", "/data", "/data"},
		{"empty falls back to data dir", "/data", "", "/data"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			opts := StartOptions{DataDir: tt.dataDir, MCPServerDir: tt.mcpDir}
			if got := opts.MCPDir(); got != tt.want {
				t.Errorf("MCPDir() = %q, want %q", got, tt.want)
			}
		})
	}
}
