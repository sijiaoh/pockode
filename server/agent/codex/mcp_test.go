package codex

import (
	"encoding/json"
	"testing"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/session"
)

func TestBuildStartConfig_MCPServers(t *testing.T) {
	sess := &mcpSession{
		opts: agent.StartOptions{
			WorkDir: "/tmp/work",
			DataDir: "/tmp/data",
			Mode:    session.ModeDefault,
		},
		exe: "/usr/local/bin/pockode",
	}

	config := sess.buildStartConfig("hello")

	// Verify config.mcp_servers.pockode exists with correct values.
	cfgObj, ok := config["config"].(map[string]interface{})
	if !ok {
		t.Fatal("expected config key in start config")
	}
	mcpServers, ok := cfgObj["mcp_servers"].(map[string]interface{})
	if !ok {
		t.Fatal("expected mcp_servers in config")
	}
	pockode, ok := mcpServers["pockode"].(map[string]interface{})
	if !ok {
		t.Fatal("expected pockode server in mcp_servers")
	}

	if pockode["command"] != "/usr/local/bin/pockode" {
		t.Errorf("expected command to be exe path, got %v", pockode["command"])
	}

	args, ok := pockode["args"].([]string)
	if !ok {
		t.Fatal("expected args to be []string")
	}
	if len(args) != 3 || args[0] != "mcp" || args[1] != "--data-dir" || args[2] != "/tmp/data" {
		t.Errorf("unexpected args: %v", args)
	}
}

func TestNormalizeCommand(t *testing.T) {
	tests := []struct {
		name string
		raw  json.RawMessage
		want string
	}{
		{"string", json.RawMessage(`"ls -la"`), "ls -la"},
		{"array", json.RawMessage(`["git","status","-s"]`), "git status -s"},
		{"empty", json.RawMessage(``), ""},
		{"null", json.RawMessage(`null`), ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := normalizeCommand(tt.raw); got != tt.want {
				t.Errorf("normalizeCommand() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestClassifyExecCommand(t *testing.T) {
	tests := []struct {
		command      string
		wantTool     string
		wantFilePath string
	}{
		{"cat main.go", "Read", "main.go"},
		{"head -n 20 README.md", "Read", "README.md"},
		{"tail -f /var/log/syslog", "Read", "/var/log/syslog"},
		{"cat -n src/app.ts", "Read", "src/app.ts"},
		{"ls -la", "Bash", ""},
		{"git status", "Bash", ""},
		{"cat file.txt | grep error", "Bash", ""},
		{"echo hello > out.txt", "Bash", ""},
		{"cat file.txt && rm file.txt", "Bash", ""},
		{"", "Bash", ""},
		{"cat", "Bash", ""},
	}
	for _, tt := range tests {
		t.Run(tt.command, func(t *testing.T) {
			gotTool, gotPath := classifyExecCommand(tt.command)
			if gotTool != tt.wantTool || gotPath != tt.wantFilePath {
				t.Errorf("classifyExecCommand(%q) = (%q, %q), want (%q, %q)",
					tt.command, gotTool, gotPath, tt.wantTool, tt.wantFilePath)
			}
		})
	}
}

func TestExtractFilePath(t *testing.T) {
	tests := []struct {
		name    string
		changes json.RawMessage
		want    string
	}{
		{
			"single file",
			json.RawMessage(`{"src/main.go": "diff content"}`),
			"src/main.go",
		},
		{
			"multiple files",
			json.RawMessage(`{"a.go": "diff1", "b.go": "diff2"}`),
			"",
		},
		{
			"invalid JSON",
			json.RawMessage(`not json`),
			"",
		},
		{
			"empty object",
			json.RawMessage(`{}`),
			"",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := extractFilePath(tt.changes); got != tt.want {
				t.Errorf("extractFilePath() = %q, want %q", got, tt.want)
			}
		})
	}
}
