package codex

import (
	"strings"
	"testing"
)

func TestBuildMCPArgs(t *testing.T) {
	t.Run("non-empty dataDir returns config flags", func(t *testing.T) {
		args, err := buildMCPArgs("/tmp/test-data")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(args) != 4 {
			t.Fatalf("expected 4 args (-c val -c val), got %d: %v", len(args), args)
		}

		// Verify structure: alternating -c and value
		if args[0] != "-c" || args[2] != "-c" {
			t.Errorf("expected -c flags at positions 0 and 2, got %v", args)
		}

		// Verify command config references pockode MCP server
		if !strings.HasPrefix(args[1], "mcp_servers.pockode.command=") {
			t.Errorf("expected command config, got %q", args[1])
		}

		// Verify args config contains the data dir
		if !strings.Contains(args[3], "/tmp/test-data") {
			t.Errorf("expected data dir in args config, got %q", args[3])
		}
		if !strings.Contains(args[3], "mcp_servers.pockode.args=") {
			t.Errorf("expected args config key, got %q", args[3])
		}
	})
}
