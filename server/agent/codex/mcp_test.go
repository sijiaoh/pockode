package codex

import (
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

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
	// A named worktree splits DataDir (session state) from MCPServerDir (where
	// server.json lives). The MCP proxy must point at the server dir; otherwise it
	// would look for server.json in the worktree dir, which has none.
	sess := &mcpSession{
		opts: agent.StartOptions{
			WorkDir:      "/tmp/work",
			DataDir:      "/tmp/data/worktrees/feature-x",
			MCPServerDir: "/tmp/data",
			Mode:         session.ModeDefault,
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

func TestBuildStartConfig_MCPDirFallsBackToDataDir(t *testing.T) {
	// Without a split (single-dir setups), the MCP proxy uses DataDir.
	sess := &mcpSession{
		opts: agent.StartOptions{
			WorkDir: "/tmp/work",
			DataDir: "/tmp/data",
			Mode:    session.ModeDefault,
		},
		exe: "/usr/local/bin/pockode",
	}

	args := sess.buildStartConfig("hello")["config"].(map[string]interface{})["mcp_servers"].(map[string]interface{})["pockode"].(map[string]interface{})["args"].([]string)
	if len(args) != 3 || args[2] != "/tmp/data" {
		t.Errorf("expected --data-dir to fall back to DataDir, got %v", args)
	}
}

func TestBuildStartConfig_DisableMCP(t *testing.T) {
	// Tests run against the test binary, which is not an MCP server; pointing
	// Codex at it only produces startup failures.
	sess := &mcpSession{
		opts: agent.StartOptions{WorkDir: "/tmp/work", DataDir: "/tmp/data", DisableMCP: true},
		exe:  "/usr/local/bin/pockode",
	}

	cfgObj := sess.buildStartConfig("hello")["config"].(map[string]interface{})
	if _, ok := cfgObj["mcp_servers"]; ok {
		t.Error("expected no mcp_servers when MCP is disabled")
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

	sess.processCodexMsg(raw, nil)

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

	sess.processCodexMsg(raw, nil)

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

	sess.processCodexMsg(raw, nil)

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

	sess.processCodexMsg(raw, nil)

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

	sess.processCodexMsg(raw, nil)

	events := drainEvents(sess.events)
	ev := events[0].(agent.ToolResultEvent)
	if ev.ToolResult != "part1\npart2" {
		t.Errorf("ToolResult = %q, want %q", ev.ToolResult, "part1\npart2")
	}
}

// --- Shell command events ---

// Field names taken from a real exec_command_end: the output lives in
// formatted_output/aggregated_output/stdout, never in an "output" field.
func TestProcessCodexMsg_ExecCommandEnd(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want string
	}{
		{
			name: "formatted output preferred",
			raw:  `{"type":"exec_command_end","call_id":"c1","stdout":"hi\n","stderr":"","aggregated_output":"hi\n","exit_code":0,"formatted_output":"hi\n","status":"completed"}`,
			want: "hi\n",
		},
		{
			name: "falls back to the aggregated stream",
			raw:  `{"type":"exec_command_end","call_id":"c1","stdout":"hi\n","aggregated_output":"hi\n","exit_code":0}`,
			want: "hi\n",
		},
		{
			name: "falls back to the separate streams",
			raw:  `{"type":"exec_command_end","call_id":"c1","stdout":"out","stderr":"err","exit_code":1}`,
			want: "out\nerr",
		},
		{
			name: "failure without output still says so",
			raw:  `{"type":"exec_command_end","call_id":"c1","stdout":"","stderr":"","aggregated_output":"","exit_code":127,"formatted_output":"","status":"failed"}`,
			want: "(no output, exit code 127)",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			sess := newTestSession()
			defer sess.cancel()

			sess.processCodexMsg(json.RawMessage(tt.raw), nil)

			events := drainEvents(sess.events)
			if len(events) != 1 {
				t.Fatalf("expected 1 event, got %d", len(events))
			}
			ev, ok := events[0].(agent.ToolResultEvent)
			if !ok {
				t.Fatalf("expected ToolResultEvent, got %T", events[0])
			}
			if ev.ToolResult != tt.want {
				t.Errorf("ToolResult = %q, want %q", ev.ToolResult, tt.want)
			}
		})
	}
}

// An approval request and the command it approves share call_id, so emitting a
// tool call for both renders the command twice and only the first copy is ever
// filled in by the result.
func TestProcessCodexMsg_ExecApprovalRequestIsNotAToolCall(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()

	raw := json.RawMessage(`{"type":"exec_approval_request","call_id":"c1","turn_id":"2","command":["cat","/etc/shells"],"cwd":"/tmp"}`)
	sess.processCodexMsg(raw, nil)

	if events := drainEvents(sess.events); len(events) != 0 {
		t.Errorf("expected no events, got %v", events)
	}
}

func TestProcessCodexMsg_ExecCommandBegin(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()

	raw := json.RawMessage(`{"type":"exec_command_begin","call_id":"c1","turn_id":"2","command":["cat","/etc/shells"],"cwd":"/tmp","parsed_cmd":[]}`)
	sess.processCodexMsg(raw, nil)

	events := drainEvents(sess.events)
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	ev := events[0].(agent.ToolCallEvent)
	if ev.ToolName != "Bash" || ev.ToolUseID != "c1" {
		t.Errorf("unexpected tool call: %+v", ev)
	}
	var input map[string]interface{}
	if err := json.Unmarshal(ev.ToolInput, &input); err != nil {
		t.Fatalf("failed to unmarshal ToolInput: %v", err)
	}
	if input["command"] != "cat /etc/shells" {
		t.Errorf("command = %v", input["command"])
	}
}

// --- Failure reporting ---

// A server that fails to start silently removes its tools from the session; for
// the pockode server that means no work_* tools at all.
func TestProcessCodexMsg_MCPStartupFailureWarns(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()

	raw := json.RawMessage(`{"type":"mcp_startup_complete","ready":[],"failed":[{"server":"pockode","error":"handshaking with MCP server failed"}]}`)
	sess.processCodexMsg(raw, nil)

	events := drainEvents(sess.events)
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	warning, ok := events[0].(agent.WarningEvent)
	if !ok {
		t.Fatalf("expected WarningEvent, got %T", events[0])
	}
	if warning.Code != "mcp_startup_failed" {
		t.Errorf("Code = %q", warning.Code)
	}
	if !strings.Contains(warning.Message, "pockode") {
		t.Errorf("Message = %q, want it to name the server", warning.Message)
	}
}

func TestProcessCodexMsg_NonFatalErrorsBecomeWarnings(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()

	raw := json.RawMessage(`{"type":"stream_error","message":"stream disconnected, retrying","codex_error_info":"response_stream_disconnected"}`)
	sess.processCodexMsg(raw, nil)

	events := drainEvents(sess.events)
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	warning := events[0].(agent.WarningEvent)
	if warning.Message != "stream disconnected, retrying" || warning.Code != "stream_error" {
		t.Errorf("unexpected warning: %+v", warning)
	}
}

// The error event ends the turn through the tools/call result, which carries the
// same message; emitting here as well would report the failure twice.
func TestProcessCodexMsg_ErrorEventIsReportedByTheTurnResult(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()

	raw := json.RawMessage(`{"type":"error","message":"unauthorized","codex_error_info":"unauthorized"}`)
	sess.processCodexMsg(raw, nil)

	if events := drainEvents(sess.events); len(events) != 0 {
		t.Errorf("expected no events, got %v", events)
	}
}

// Bookkeeping events must not reach the transcript: Codex emits dozens of them
// per turn, and the ones below all duplicate content rendered elsewhere.
func TestProcessCodexMsg_BookkeepingEventsAreDropped(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()

	raws := []string{
		`{"type":"task_started","turn_id":"2","started_at":1787262425}`,
		`{"type":"task_complete","turn_id":"2","last_agent_message":"done"}`,
		`{"type":"token_count","info":null,"rate_limits":{"limit_id":"codex"}}`,
		`{"type":"user_message","message":"Hi","images":[]}`,
		`{"type":"item_started","thread_id":"t","turn_id":"2","item":{"type":"UserMessage"}}`,
		`{"type":"item_completed","thread_id":"t","turn_id":"2","item":{"type":"UserMessage"}}`,
		`{"type":"raw_response_item","item":{"type":"message","role":"user"}}`,
		`{"type":"agent_message_content_delta","delta":"par"}`,
		`{"type":"exec_command_output_delta","call_id":"c1","stream":"stdout","chunk":"aGk="}`,
		`{"type":"mcp_startup_update","server":"pockode","status":{"state":"starting"}}`,
		`{"type":"agent_reasoning","text":"thinking"}`,
	}
	for _, raw := range raws {
		sess.processCodexMsg(json.RawMessage(raw), nil)
	}

	if events := drainEvents(sess.events); len(events) != 0 {
		t.Errorf("expected no events, got %v", events)
	}
}

// --- Fix 1: cleanupPendingElicitations ---

func TestCleanupPendingElicitations_EmitsRequestCancelled(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()

	// Simulate a pending elicitation.
	ch := make(chan elicitAnswer, 1)
	sess.pendingElicit.Store("req-1", ch)

	sess.cleanupPendingElicitations()

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

func TestCleanupPendingElicitations_Multiple(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()

	ch1 := make(chan elicitAnswer, 1)
	ch2 := make(chan elicitAnswer, 1)
	sess.pendingElicit.Store("req-a", ch1)
	sess.pendingElicit.Store("req-b", ch2)

	sess.cleanupPendingElicitations()

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

func TestCleanupPendingElicitations_NoPendingIsNoop(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()

	sess.cleanupPendingElicitations()

	events := drainEvents(sess.events)
	if len(events) != 0 {
		t.Fatalf("expected 0 events, got %d", len(events))
	}
}

// --- Turn termination ---

// discardWriteCloser is a no-op writer for tests that don't send data to a real process.
type discardWriteCloser struct{}

func (d *discardWriteCloser) Write(p []byte) (int, error) { return len(p), nil }
func (d *discardWriteCloser) Close() error                { return nil }

// recordingWriteCloser captures what the session writes to the CLI's stdin.
type recordingWriteCloser struct {
	mu     sync.Mutex
	writes [][]byte
}

func (r *recordingWriteCloser) Write(p []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.writes = append(r.writes, append([]byte(nil), p...))
	return len(p), nil
}

func (r *recordingWriteCloser) Close() error { return nil }

func (r *recordingWriteCloser) lastRequest(t *testing.T) rpcRequest {
	t.Helper()
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.writes) == 0 {
		t.Fatal("nothing was written to stdin")
	}
	var req rpcRequest
	if err := json.Unmarshal(r.writes[len(r.writes)-1], &req); err != nil {
		t.Fatalf("failed to parse written request: %v", err)
	}
	return req
}

// pendingTurnID returns the id of the single in-flight tools/call.
func pendingTurnID(t *testing.T, sess *mcpSession) int64 {
	t.Helper()
	var id int64
	found := false
	sess.pendingRPCResults.Range(func(key, _ any) bool {
		id = key.(int64)
		found = true
		return false
	})
	if !found {
		t.Fatal("expected a pending tool call")
	}
	return id
}

// waitForEvent reads the next event, failing if the turn never ends.
func waitForEvent(t *testing.T, sess *mcpSession) agent.AgentEvent {
	t.Helper()
	select {
	case ev := <-sess.events:
		return ev
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for an event")
		return nil
	}
}

// A turn Codex aborts gets no tools/call response, so the abort event is the
// only thing that can end the turn.
func TestTurnAborted_EndsTheTurn(t *testing.T) {
	tests := []struct {
		name   string
		reason string
		want   agent.EventType
	}{
		{"user interrupt", "interrupted", agent.EventTypeInterrupted},
		{"replaced by another turn", "replaced", agent.EventTypeInterrupted},
		{"budget limit", "budget_limited", agent.EventTypeError},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			sess := newTestSession()
			defer sess.cancel()
			sess.stdin = &discardWriteCloser{}

			if err := sess.callToolAsync("codex", map[string]interface{}{"prompt": "hello"}); err != nil {
				t.Fatalf("callToolAsync error: %v", err)
			}
			id := pendingTurnID(t, sess)

			raw := json.RawMessage(`{"type":"turn_aborted","turn_id":"2","reason":"` + tt.reason + `"}`)
			sess.processCodexMsg(raw, &id)

			if got := waitForEvent(t, sess).EventType(); got != tt.want {
				t.Errorf("event = %s, want %s", got, tt.want)
			}
		})
	}
}

// A turn_aborted of an already finished turn must not end the turn running now.
func TestTurnAborted_OtherRequestLeavesTurnRunning(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()
	sess.stdin = &discardWriteCloser{}

	if err := sess.callToolAsync("codex-reply", map[string]interface{}{"prompt": "next"}); err != nil {
		t.Fatalf("callToolAsync error: %v", err)
	}
	staleID := pendingTurnID(t, sess) - 1

	sess.processCodexMsg(json.RawMessage(`{"type":"turn_aborted","reason":"interrupted"}`), &staleID)
	sess.processCodexMsg(json.RawMessage(`{"type":"turn_aborted","reason":"interrupted"}`), nil)

	if events := drainEvents(sess.events); len(events) != 0 {
		t.Errorf("expected the running turn to be untouched, got %v", events)
	}
}

// An interrupted turn produces both signals — our own synthetic response and
// Codex's turn_aborted — and each of them alone can end the turn.
func TestInterruptAndTurnAborted_EndTheTurnOnce(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()
	sess.stdin = &discardWriteCloser{}

	if err := sess.callToolAsync("codex", map[string]interface{}{"prompt": "hello"}); err != nil {
		t.Fatalf("callToolAsync error: %v", err)
	}
	id := pendingTurnID(t, sess)

	if err := sess.SendInterrupt(); err != nil {
		t.Fatalf("SendInterrupt error: %v", err)
	}
	if _, ok := waitForEvent(t, sess).(agent.InterruptedEvent); !ok {
		t.Fatal("expected an interrupted event")
	}

	// Codex reports the abort afterwards; the turn is already settled.
	sess.processCodexMsg(json.RawMessage(`{"type":"turn_aborted","reason":"interrupted"}`), &id)

	if events := drainEvents(sess.events); len(events) != 0 {
		t.Errorf("expected the turn to end once, got %d extra events: %v", len(events), events)
	}
}

func TestSendInterrupt_EndsTurnAsInterrupted(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()
	sess.stdin = &discardWriteCloser{}

	if err := sess.callToolAsync("codex", map[string]interface{}{"prompt": "hello"}); err != nil {
		t.Fatalf("callToolAsync error: %v", err)
	}
	if err := sess.SendInterrupt(); err != nil {
		t.Fatalf("SendInterrupt error: %v", err)
	}

	if _, ok := waitForEvent(t, sess).(agent.InterruptedEvent); !ok {
		t.Error("expected an interrupted event after SendInterrupt")
	}
}

// --- Turn result ---

// The MCP frame stays a JSON-RPC success even when the turn failed; isError is
// the only signal, so ignoring it would render a failure as a completion.
func TestParseTurnResult(t *testing.T) {
	tests := []struct {
		name     string
		result   string
		want     agent.EventType
		wantText string
	}{
		{
			name:   "completed turn",
			result: `{"content":[{"type":"text","text":"done"}],"structuredContent":{"threadId":"01a0-abc","content":"done"}}`,
			want:   agent.EventTypeDone,
		},
		{
			name:     "failed turn",
			result:   `{"content":[{"type":"text","text":"Your access token could not be refreshed."}],"structuredContent":{"threadId":"01a0-abc","content":"Your access token could not be refreshed."},"isError":true}`,
			want:     agent.EventTypeError,
			wantText: "Your access token could not be refreshed.",
		},
		{
			name:     "failed turn without structured content",
			result:   `{"content":[{"type":"text","text":"Failed to parse thread_id"}],"isError":true}`,
			want:     agent.EventTypeError,
			wantText: "Failed to parse thread_id",
		},
		{
			name:     "failed turn without any message",
			result:   `{"content":[],"isError":true}`,
			want:     agent.EventTypeError,
			wantText: "codex reported an error without a message",
		},
		{
			// The failure shape of CLIs older than the standardised MCP result.
			name:     "failed turn of a pre-isError CLI",
			result:   `{"error":"stream disconnected before completion"}`,
			want:     agent.EventTypeError,
			wantText: "stream disconnected before completion",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			sess := newTestSession()
			defer sess.cancel()

			ev := sess.parseTurnResult(json.RawMessage(tt.result))
			if ev.EventType() != tt.want {
				t.Fatalf("event = %s, want %s", ev.EventType(), tt.want)
			}
			if errEvent, ok := ev.(agent.ErrorEvent); ok && errEvent.Error != tt.wantText {
				t.Errorf("Error = %q, want %q", errEvent.Error, tt.wantText)
			}
		})
	}
}

// --- Thread identifier ---

// Without a thread id every message would start a new session, losing the
// conversation. Codex reports it in the tool result and in session_configured.
func TestRememberThreadID_Sources(t *testing.T) {
	tests := []struct {
		name  string
		apply func(*mcpSession)
		want  string
	}{
		{
			name: "tool call result",
			apply: func(s *mcpSession) {
				s.parseTurnResult(json.RawMessage(`{"structuredContent":{"threadId":"thread-1"}}`))
			},
			want: "thread-1",
		},
		{
			name: "session_configured event",
			apply: func(s *mcpSession) {
				s.processCodexMsg(json.RawMessage(`{"type":"session_configured","session_id":"sid-1","thread_id":"thread-2"}`), nil)
			},
			want: "thread-2",
		},
		{
			name: "session_configured of a CLI without thread_id",
			apply: func(s *mcpSession) {
				s.processCodexMsg(json.RawMessage(`{"type":"session_configured","session_id":"sid-2"}`), nil)
			},
			want: "sid-2",
		},
		{
			name:  "tool call result of a CLI without threadId",
			apply: func(s *mcpSession) { s.parseTurnResult(json.RawMessage(`{"conversationId":"conv-1"}`)) },
			want:  "conv-1",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			sess := newTestSession()
			defer sess.cancel()

			tt.apply(sess)

			if sess.threadID != tt.want {
				t.Errorf("threadID = %q, want %q", sess.threadID, tt.want)
			}
		})
	}
}

// Rejecting an unknown thread echoes the rejected id back in
// structuredContent (payload captured from codex-cli 0.153.0). Believing it
// would re-pin the dead id on every attempt, so the session could never
// recover on its own.
func TestParseTurnResult_RejectedThreadIDIsNotAdopted(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()

	sess.parseTurnResult(json.RawMessage(`{"isError":true,"content":[{"type":"text","text":"Session not found for thread_id: 01a06563-5a9d"}],"structuredContent":{"threadId":"01a06563-5a9d","content":"Session not found for thread_id: 01a06563-5a9d"}}`))

	if sess.threadID != "" {
		t.Fatalf("threadID = %q, want empty so the next message opens a new thread", sess.threadID)
	}
}

// A turn that dies on an expired login still ran inside a registered thread,
// and replying into it works (verified against codex-cli 0.153.0, whose 401
// result this payload is). Dropping the thread would discard the agent's
// context for a failure it survived.
func TestParseTurnResult_FailedTurnKeepsConfirmedThreadID(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()

	sess.processCodexMsg(json.RawMessage(`{"type":"session_configured","session_id":"01a06564-d116","thread_id":"01a06564-d116"}`), nil)
	sess.parseTurnResult(json.RawMessage(`{"isError":true,"content":[{"type":"text","text":"unexpected status 401 Unauthorized"}],"structuredContent":{"threadId":"01a06564-d116","content":"unexpected status 401 Unauthorized"}}`))

	if sess.threadID != "01a06564-d116" {
		t.Fatalf("threadID = %q, want the thread the failed turn ran in", sess.threadID)
	}
}

func TestSendMessage_ContinuesThreadAfterFirstTurn(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()
	stdin := &recordingWriteCloser{}
	sess.stdin = stdin
	sess.threadID = "thread-42"

	if err := sess.SendMessage("second turn"); err != nil {
		t.Fatalf("SendMessage error: %v", err)
	}

	req := stdin.lastRequest(t)
	if req.Method != "tools/call" {
		t.Fatalf("method = %q, want tools/call", req.Method)
	}
	var params struct {
		Name      string            `json:"name"`
		Arguments map[string]string `json:"arguments"`
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		t.Fatalf("failed to parse params: %v", err)
	}
	if params.Name != "codex-reply" {
		t.Errorf("tool = %q, want codex-reply", params.Name)
	}
	// threadId is what current CLIs read, conversationId what older ones read.
	if params.Arguments["threadId"] != "thread-42" {
		t.Errorf("threadId = %q, want %q", params.Arguments["threadId"], "thread-42")
	}
	if params.Arguments["conversationId"] != "thread-42" {
		t.Errorf("conversationId = %q, want %q", params.Arguments["conversationId"], "thread-42")
	}
	if params.Arguments["prompt"] != "second turn" {
		t.Errorf("prompt = %q, want %q", params.Arguments["prompt"], "second turn")
	}
}

// --- Restart ---

// A Codex thread dies with the process that created it (verified against the
// CLI: a fresh mcp-server answers "Session not found for thread_id"), so a
// restarted session has to start a new thread and say the earlier turns are
// gone from the agent's memory.
func TestWarnSessionNotResumable(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()

	sess.warnSessionNotResumable()

	events := drainEvents(sess.events)
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	warning, ok := events[0].(agent.WarningEvent)
	if !ok {
		t.Fatalf("expected WarningEvent, got %T", events[0])
	}
	if warning.Code != "session_not_resumable" {
		t.Errorf("Code = %q", warning.Code)
	}
}

// Without a thread id the message has to open a new thread; sending
// codex-reply with a stale id would fail for the rest of the session.
func TestSendMessage_StartsNewThreadWhenUnknown(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()
	stdin := &recordingWriteCloser{}
	sess.stdin = stdin
	sess.opts = agent.StartOptions{WorkDir: "/tmp/work", DataDir: "/tmp/data", DisableMCP: true}

	if err := sess.SendMessage("first turn"); err != nil {
		t.Fatalf("SendMessage error: %v", err)
	}

	var params struct {
		Name      string                 `json:"name"`
		Arguments map[string]interface{} `json:"arguments"`
	}
	if err := json.Unmarshal(stdin.lastRequest(t).Params, &params); err != nil {
		t.Fatalf("failed to parse params: %v", err)
	}
	if params.Name != "codex" {
		t.Errorf("tool = %q, want codex", params.Name)
	}
	if params.Arguments["prompt"] != "first turn" {
		t.Errorf("prompt = %v", params.Arguments["prompt"])
	}
}

// --- handleElicitation routing ---

// Params mirror what codex mcp-server sends: a patch approval describes its
// edits in codex_changes, and both elicitation kinds are spelled with a hyphen.
func TestHandleElicitation_PatchApproval(t *testing.T) {
	sess := newTestSession()
	sess.stdin = &discardWriteCloser{}
	defer sess.cancel()

	params := map[string]interface{}{
		"message":           "Allow Codex to apply proposed code changes?",
		"codex_elicitation": "patch-approval",
		"codex_call_id":     "call-edit-1",
		"codex_changes": map[string]interface{}{
			"src/main.go": map[string]interface{}{"type": "update", "unified_diff": "@@ -1 +1 @@"},
		},
		"codex_mcp_tool_call_id": "2",
	}
	paramsJSON, _ := json.Marshal(params)
	msgID := int64(1)
	msg := rpcMessage{
		ID:     &msgID,
		Method: "elicitation/create",
		Params: paramsJSON,
	}

	go sess.handleElicitation(sess.procCtx, msg)

	// Wait for the permission request event (goroutine unblocks via deferred cancel).
	ev := <-sess.events
	perm, ok := ev.(agent.PermissionRequestEvent)
	if !ok {
		t.Fatalf("expected PermissionRequestEvent, got %T", ev)
	}
	if perm.ToolName != "Edit" {
		t.Errorf("ToolName = %q, want %q", perm.ToolName, "Edit")
	}
	if perm.RequestID != "call-edit-1" {
		t.Errorf("RequestID = %q, want %q", perm.RequestID, "call-edit-1")
	}
	// The prompt points at the patch being approved, not at the whole tools/call.
	if perm.ToolUseID != "call-edit-1" {
		t.Errorf("ToolUseID = %q, want %q", perm.ToolUseID, "call-edit-1")
	}

	var input map[string]interface{}
	if err := json.Unmarshal(perm.ToolInput, &input); err != nil {
		t.Fatalf("failed to unmarshal ToolInput: %v", err)
	}
	if input["file_path"] != "src/main.go" {
		t.Errorf("file_path = %v, want %q", input["file_path"], "src/main.go")
	}
	if input["changes"] == nil {
		t.Error("expected changes in ToolInput")
	}
}

func TestHandleElicitation_ExecApproval(t *testing.T) {
	sess := newTestSession()
	sess.stdin = &discardWriteCloser{}
	defer sess.cancel()

	params := map[string]interface{}{
		"message":                "Allow Codex to run `ls -la` in `/home/user`?",
		"codex_elicitation":      "exec-approval",
		"codex_call_id":          "call-bash-1",
		"codex_command":          []string{"ls", "-la"},
		"codex_cwd":              "/home/user",
		"codex_mcp_tool_call_id": "2",
	}
	paramsJSON, _ := json.Marshal(params)
	msgID := int64(2)
	msg := rpcMessage{
		ID:     &msgID,
		Method: "elicitation/create",
		Params: paramsJSON,
	}

	go sess.handleElicitation(sess.procCtx, msg)

	ev := <-sess.events
	perm, ok := ev.(agent.PermissionRequestEvent)
	if !ok {
		t.Fatalf("expected PermissionRequestEvent, got %T", ev)
	}
	if perm.ToolName != "Bash" {
		t.Errorf("ToolName = %q, want %q", perm.ToolName, "Bash")
	}
	if perm.RequestID != "call-bash-1" {
		t.Errorf("RequestID = %q, want %q", perm.RequestID, "call-bash-1")
	}
	if perm.ToolUseID != "call-bash-1" {
		t.Errorf("ToolUseID = %q, want %q", perm.ToolUseID, "call-bash-1")
	}

	var input map[string]interface{}
	if err := json.Unmarshal(perm.ToolInput, &input); err != nil {
		t.Fatalf("failed to unmarshal ToolInput: %v", err)
	}
	if input["command"] != "ls -la" {
		t.Errorf("command = %v, want %q", input["command"], "ls -la")
	}
	if input["cwd"] != "/home/user" {
		t.Errorf("cwd = %v, want %q", input["cwd"], "/home/user")
	}
}
