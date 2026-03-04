package codex

import (
	"context"
	"encoding/json"
	"log/slog"
	"testing"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/session"
)

// newTestSession creates an mcpSession with a buffered events channel for unit tests.
func newTestSession() *mcpSession {
	ctx, cancel := context.WithCancel(context.Background())
	return &mcpSession{
		log:     slog.Default(),
		events:  make(chan agent.AgentEvent, 100),
		procCtx: ctx,
		cancel:  cancel,
	}
}

// drainEvents reads all currently buffered events from the channel.
func drainEvents(ch <-chan agent.AgentEvent) []agent.AgentEvent {
	var events []agent.AgentEvent
	for {
		select {
		case ev := <-ch:
			events = append(events, ev)
		default:
			return events
		}
	}
}

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

func TestProcessCodexMsg_MCPToolCallBegin(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()

	raw := json.RawMessage(`{
		"type": "mcp_tool_call_begin",
		"call_id": "call_abc123",
		"invocation": {
			"server": "pockode",
			"tool": "work_list",
			"arguments": {"parent_id": "story-1"}
		}
	}`)

	sess.processCodexMsg(raw)

	events := drainEvents(sess.events)
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	ev, ok := events[0].(agent.ToolCallEvent)
	if !ok {
		t.Fatalf("expected ToolCallEvent, got %T", events[0])
	}
	if ev.ToolUseID != "call_abc123" {
		t.Errorf("ToolUseID = %q, want %q", ev.ToolUseID, "call_abc123")
	}
	if ev.ToolName != "pockode:work_list" {
		t.Errorf("ToolName = %q, want %q", ev.ToolName, "pockode:work_list")
	}
	// Input should be the arguments directly.
	var input map[string]interface{}
	if err := json.Unmarshal(ev.ToolInput, &input); err != nil {
		t.Fatalf("failed to unmarshal ToolInput: %v", err)
	}
	if input["parent_id"] != "story-1" {
		t.Errorf("input parent_id = %v, want %q", input["parent_id"], "story-1")
	}
}

func TestProcessCodexMsg_MCPToolCallBegin_EmptyArgs(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()

	raw := json.RawMessage(`{
		"type": "mcp_tool_call_begin",
		"call_id": "call_empty",
		"invocation": {
			"server": "codex",
			"tool": "list_mcp_resources",
			"arguments": {}
		}
	}`)

	sess.processCodexMsg(raw)

	events := drainEvents(sess.events)
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	ev := events[0].(agent.ToolCallEvent)
	if ev.ToolName != "codex:list_mcp_resources" {
		t.Errorf("ToolName = %q, want %q", ev.ToolName, "codex:list_mcp_resources")
	}
}

func TestProcessCodexMsg_MCPToolCallEnd_Ok(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()

	raw := json.RawMessage(`{
		"type": "mcp_tool_call_end",
		"call_id": "call_abc123",
		"invocation": {"server": "pockode", "tool": "work_list", "arguments": {}},
		"duration": {"secs": 0, "nanos": 225542},
		"result": {
			"Ok": {
				"content": [{"type": "text", "text": "[{\"id\":\"1\",\"title\":\"Story\"}]"}],
				"isError": false
			}
		}
	}`)

	sess.processCodexMsg(raw)

	events := drainEvents(sess.events)
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	ev, ok := events[0].(agent.ToolResultEvent)
	if !ok {
		t.Fatalf("expected ToolResultEvent, got %T", events[0])
	}
	if ev.ToolUseID != "call_abc123" {
		t.Errorf("ToolUseID = %q, want %q", ev.ToolUseID, "call_abc123")
	}
	if ev.ToolResult != `[{"id":"1","title":"Story"}]` {
		t.Errorf("ToolResult = %q", ev.ToolResult)
	}
}

func TestProcessCodexMsg_MCPToolCallEnd_Err(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()

	raw := json.RawMessage(`{
		"type": "mcp_tool_call_end",
		"call_id": "call_fail",
		"invocation": {"server": "pockode", "tool": "work_list", "arguments": {}},
		"result": {
			"Err": "MCP startup failed: timed out"
		}
	}`)

	sess.processCodexMsg(raw)

	events := drainEvents(sess.events)
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	ev := events[0].(agent.ToolResultEvent)
	if ev.ToolResult != "MCP startup failed: timed out" {
		t.Errorf("ToolResult = %q", ev.ToolResult)
	}
}

func TestProcessCodexMsg_MCPToolCallEnd_MultipleContent(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()

	raw := json.RawMessage(`{
		"type": "mcp_tool_call_end",
		"call_id": "call_multi",
		"invocation": {"server": "pockode", "tool": "work_list", "arguments": {}},
		"result": {
			"Ok": {
				"content": [
					{"type": "text", "text": "part1"},
					{"type": "text", "text": "part2"}
				],
				"isError": false
			}
		}
	}`)

	sess.processCodexMsg(raw)

	events := drainEvents(sess.events)
	ev := events[0].(agent.ToolResultEvent)
	if ev.ToolResult != "part1\npart2" {
		t.Errorf("ToolResult = %q, want %q", ev.ToolResult, "part1\npart2")
	}
}
