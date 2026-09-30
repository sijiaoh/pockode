package agent

import "testing"

func TestParseVersion(t *testing.T) {
	tests := []struct{ out, want string }{
		{"2.1.283 (Claude Code)\n", "2.1.283"},
		{"codex-cli 0.153.0\n", "0.153.0"},
		{"codex-cli 0.154.0-alpha.2\n", "0.154.0-alpha.2"},
		{"no version here\n", ""},
	}
	for _, tt := range tests {
		if got := parseVersion(tt.out); got != tt.want {
			t.Errorf("parseVersion(%q) = %q, want %q", tt.out, got, tt.want)
		}
	}
}
