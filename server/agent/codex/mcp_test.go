package codex

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/session"
)

// newTestSession creates an mcpSession with a buffered events channel for unit tests.
func newTestSession() *mcpSession {
	ctx, cancel := context.WithCancel(context.Background())
	return &mcpSession{
		log:               slog.Default(),
		events:            make(chan agent.AgentEvent, 100),
		procCtx:           ctx,
		cancel:            cancel,
		pendingRPCResults: &sync.Map{},
		pendingElicit:     &sync.Map{},
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

// --- Fix 1: cleanupPendingRequests ---

func TestCleanupPendingRequests_EmitsRequestCancelled(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()

	// Simulate a pending elicitation.
	ch := make(chan elicitAnswer, 1)
	sess.pendingElicit.Store("req-1", ch)

	sess.cleanupPendingRequests()

	// The elicitation channel should receive a denial.
	select {
	case ans := <-ch:
		if ans.decision != "denied" {
			t.Errorf("expected denied, got %q", ans.decision)
		}
	default:
		t.Fatal("elicitation channel did not receive denial")
	}

	// A RequestCancelledEvent should be emitted.
	events := drainEvents(sess.events)
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	cancelled, ok := events[0].(agent.RequestCancelledEvent)
	if !ok {
		t.Fatalf("expected RequestCancelledEvent, got %T", events[0])
	}
	if cancelled.RequestID != "req-1" {
		t.Errorf("RequestID = %q, want %q", cancelled.RequestID, "req-1")
	}
}

func TestCleanupPendingRequests_MultipleElicitations(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()

	ch1 := make(chan elicitAnswer, 1)
	ch2 := make(chan elicitAnswer, 1)
	sess.pendingElicit.Store("req-a", ch1)
	sess.pendingElicit.Store("req-b", ch2)

	sess.cleanupPendingRequests()

	events := drainEvents(sess.events)
	if len(events) != 2 {
		t.Fatalf("expected 2 events, got %d", len(events))
	}

	ids := map[string]bool{}
	for _, ev := range events {
		cancelled, ok := ev.(agent.RequestCancelledEvent)
		if !ok {
			t.Fatalf("expected RequestCancelledEvent, got %T", ev)
		}
		ids[cancelled.RequestID] = true
	}
	if !ids["req-a"] || !ids["req-b"] {
		t.Errorf("expected both req-a and req-b, got %v", ids)
	}
}

func TestCleanupPendingRequests_NoPendingIsNoop(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()

	sess.cleanupPendingRequests()

	events := drainEvents(sess.events)
	if len(events) != 0 {
		t.Fatalf("expected 0 events, got %d", len(events))
	}
}

// --- Fix 2: interrupted flag race ---

func TestCallToolAsync_ClearsStaleInterruptedFlag(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()
	sess.stdin = &discardWriteCloser{}

	// Simulate a stale interrupted flag from a previous turn.
	sess.interrupted.Store(true)

	// callToolAsync should clear the flag.
	err := sess.callToolAsync("codex", map[string]interface{}{"prompt": "hello"})
	if err != nil {
		t.Fatalf("callToolAsync error: %v", err)
	}

	if sess.interrupted.Load() {
		t.Error("interrupted flag should be cleared at the start of callToolAsync")
	}
}

// discardWriteCloser is a no-op writer for tests that don't send data to a real process.
type discardWriteCloser struct{}

func (d *discardWriteCloser) Write(p []byte) (int, error) { return len(p), nil }
func (d *discardWriteCloser) Close() error                { return nil }

// --- Fix 3: resume state ---

func TestResumeState_SaveAndLoad(t *testing.T) {
	dir := t.TempDir()
	sessionID := "test-session-123"

	// Create a session with IDs set.
	sess := &mcpSession{
		log: slog.Default(),
		opts: agent.StartOptions{
			DataDir:   dir,
			SessionID: sessionID,
		},
		sessionID:      "codex-sid-abc",
		conversationID: "codex-cid-def",
	}

	sess.saveResumeState()

	// Verify the file was created.
	path := filepath.Join(dir, "sessions", sessionID, "codex_resume.json")
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("resume state file not created: %v", err)
	}

	// Create a new session and load the state.
	sess2 := &mcpSession{
		log: slog.Default(),
		opts: agent.StartOptions{
			DataDir:   dir,
			SessionID: sessionID,
		},
	}
	sess2.loadResumeState()

	if sess2.sessionID != "codex-sid-abc" {
		t.Errorf("sessionID = %q, want %q", sess2.sessionID, "codex-sid-abc")
	}
	if sess2.conversationID != "codex-cid-def" {
		t.Errorf("conversationID = %q, want %q", sess2.conversationID, "codex-cid-def")
	}
}

func TestResumeState_SkipSaveWhenNoIDs(t *testing.T) {
	dir := t.TempDir()
	sessionID := "test-empty"

	sess := &mcpSession{
		log: slog.Default(),
		opts: agent.StartOptions{
			DataDir:   dir,
			SessionID: sessionID,
		},
	}

	sess.saveResumeState()

	// File should not be created.
	path := filepath.Join(dir, "sessions", sessionID, "codex_resume.json")
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Error("resume state file should not be created when no IDs set")
	}
}

func TestResumeState_LoadMissingFileIsNoop(t *testing.T) {
	dir := t.TempDir()

	sess := &mcpSession{
		log: slog.Default(),
		opts: agent.StartOptions{
			DataDir:   dir,
			SessionID: "nonexistent",
		},
	}

	sess.loadResumeState()

	if sess.sessionID != "" {
		t.Errorf("sessionID should be empty, got %q", sess.sessionID)
	}
}
