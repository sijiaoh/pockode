package codex

import "testing"

func TestParseMCPSubcommand(t *testing.T) {
	tests := []struct {
		version string
		want    string
	}{
		{"codex-cli 0.42.0", "mcp"},
		{"codex-cli 0.43.0-alpha.4", "mcp"},
		{"codex-cli 0.43.0-alpha.5", "mcp-server"},
		{"codex-cli 0.43.0-alpha.10", "mcp-server"},
		{"codex-cli 0.43.0", "mcp-server"},
		{"codex-cli 0.43.1", "mcp-server"},
		{"codex-cli 0.44.0", "mcp-server"},
		{"codex-cli 1.0.0", "mcp-server"},
		{"unknown", "mcp"},
		{"", "mcp"},
	}

	for _, tt := range tests {
		t.Run(tt.version, func(t *testing.T) {
			got := parseMCPSubcommand(tt.version)
			if got != tt.want {
				t.Errorf("parseMCPSubcommand(%q) = %q, want %q", tt.version, got, tt.want)
			}
		})
	}
}
