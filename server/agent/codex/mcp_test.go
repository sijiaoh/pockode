package codex

import (
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
