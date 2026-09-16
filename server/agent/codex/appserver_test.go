package codex

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/session"
)

// newTestSession creates an appSession with a buffered events channel for unit
// tests. Every session Start builds has a usage observer and a resume store, and
// notifications are dispatched straight to them — a test session without them
// turns the first usage notification into a nil dereference instead of a failed
// assertion.
func newTestSession() *appSession {
	ctx, cancel := context.WithCancel(context.Background())
	opts := agent.StartOptions{}
	return &appSession{
		log:               testLogger(),
		events:            make(chan agent.AgentEvent, 100),
		procCtx:           ctx,
		cancel:            cancel,
		stdin:             &discardWriteCloser{},
		pendingRPCResults: &sync.Map{},
		pendingApprovals:  &sync.Map{},
		toolInputs:        map[string]json.RawMessage{},
		resume:            newResumeStateStore(opts, testLogger()),
		usage:             newUsageObserver(testLogger(), opts),
	}
}

// notify feeds the session one server notification, as the read loop would.
func (s *appSession) notify(method, params string) {
	s.handleNotification(rpcMessage{Method: method, Params: json.RawMessage(params)})
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

// waitForEvent reads the next event, failing if it never arrives.
func waitForEvent(t *testing.T, sess *appSession) agent.AgentEvent {
	t.Helper()
	select {
	case ev := <-sess.events:
		return ev
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for an event")
		return nil
	}
}

// testLogger keeps unit tests from writing the CLI's chatter to the test output.
func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

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

// requests returns the requests written so far. Replies, which carry no method,
// are skipped. It takes no *testing.T because the scripted responder polls it
// from a goroutine, where failing a test is not allowed.
func (r *recordingWriteCloser) requests() []rpcRequest {
	r.mu.Lock()
	defer r.mu.Unlock()
	reqs := make([]rpcRequest, 0, len(r.writes))
	for _, w := range r.writes {
		var req rpcRequest
		if err := json.Unmarshal(w, &req); err != nil || req.Method == "" {
			continue
		}
		reqs = append(reqs, req)
	}
	return reqs
}

// waitForRequest returns the first request written with the given method.
// Requests are written from goroutines, so they can trail the call that caused
// them.
func (r *recordingWriteCloser) waitForRequest(t *testing.T, method string) rpcRequest {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		for _, req := range r.requests() {
			if req.Method == method {
				return req
			}
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("timed out waiting for a %s request", method)
	return rpcRequest{}
}

// --- Thread parameters ---

func TestBuildThreadParams_MCPServers(t *testing.T) {
	// A named worktree splits DataDir (session state) from MCPServerDir (where
	// server.json lives). The MCP proxy must point at the server dir; otherwise it
	// would look for server.json in the worktree dir, which has none.
	sess := &appSession{
		opts: agent.StartOptions{
			WorkDir:      "/tmp/work",
			DataDir:      "/tmp/data/worktrees/feature-x",
			MCPServerDir: "/tmp/data",
			Mode:         session.ModeDefault,
		},
		exe: "/usr/local/bin/pockode",
	}

	params := sess.buildThreadParams()

	if params["cwd"] != "/tmp/work" {
		t.Errorf("cwd = %v, want the work dir", params["cwd"])
	}

	cfgObj, ok := params["config"].(map[string]interface{})
	if !ok {
		t.Fatal("expected config key in thread params")
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

func TestBuildThreadParams_MCPDirFallsBackToDataDir(t *testing.T) {
	// Without a split (single-dir setups), the MCP proxy uses DataDir.
	sess := &appSession{
		opts: agent.StartOptions{WorkDir: "/tmp/work", DataDir: "/tmp/data", Mode: session.ModeDefault},
		exe:  "/usr/local/bin/pockode",
	}

	args := sess.buildThreadParams()["config"].(map[string]interface{})["mcp_servers"].(map[string]interface{})["pockode"].(map[string]interface{})["args"].([]string)
	if len(args) != 3 || args[2] != "/tmp/data" {
		t.Errorf("expected --data-dir to fall back to DataDir, got %v", args)
	}
}

func TestBuildThreadParams_DisableMCP(t *testing.T) {
	// Tests run against the test binary, which is not an MCP server; pointing
	// Codex at it only produces startup failures.
	sess := &appSession{
		opts: agent.StartOptions{WorkDir: "/tmp/work", DataDir: "/tmp/data", DisableMCP: true},
		exe:  "/usr/local/bin/pockode",
	}

	cfgObj := sess.buildThreadParams()["config"].(map[string]interface{})
	if _, ok := cfgObj["mcp_servers"]; ok {
		t.Error("expected no mcp_servers when MCP is disabled")
	}
}

func TestBuildThreadParams_ApprovalPolicy(t *testing.T) {
	tests := []struct {
		mode        session.Mode
		wantPolicy  string
		wantSandbox string
	}{
		{session.ModeDefault, "on-request", "workspace-write"},
		{session.ModeYolo, "never", "danger-full-access"},
	}

	for _, tt := range tests {
		t.Run(string(tt.mode), func(t *testing.T) {
			sess := &appSession{
				opts: agent.StartOptions{WorkDir: "/tmp/work", DataDir: "/tmp/data", DisableMCP: true, Mode: tt.mode},
				exe:  "/usr/local/bin/pockode",
			}

			params := sess.buildThreadParams()
			if params["approvalPolicy"] != tt.wantPolicy {
				t.Errorf("approvalPolicy = %v, want %q", params["approvalPolicy"], tt.wantPolicy)
			}
			if params["sandbox"] != tt.wantSandbox {
				t.Errorf("sandbox = %v, want %q", params["sandbox"], tt.wantSandbox)
			}
		})
	}
}

func TestBuildThreadParams_Model(t *testing.T) {
	sess := &appSession{opts: agent.StartOptions{DisableMCP: true, Model: "gpt-5.1-codex"}}
	if got := sess.buildThreadParams()["model"]; got != "gpt-5.1-codex" {
		t.Errorf("model = %v, want the requested model", got)
	}

	sess = &appSession{opts: agent.StartOptions{DisableMCP: true}}
	if _, ok := sess.buildThreadParams()["model"]; ok {
		t.Error("expected no model key when none was requested")
	}
}

// Effort has no field of its own on thread/start, so it rides in as a config
// override under config.toml's key.
func TestBuildThreadParams_Effort(t *testing.T) {
	sess := &appSession{opts: agent.StartOptions{DisableMCP: true, Effort: "low"}}
	cfg := sess.buildThreadParams()["config"].(map[string]interface{})
	if cfg["model_reasoning_effort"] != "low" {
		t.Errorf("model_reasoning_effort = %v, want %q", cfg["model_reasoning_effort"], "low")
	}

	sess = &appSession{opts: agent.StartOptions{DisableMCP: true}}
	cfg = sess.buildThreadParams()["config"].(map[string]interface{})
	if _, ok := cfg["model_reasoning_effort"]; ok {
		t.Error("expected no effort override when none was requested")
	}
}

// --- Item translation ---

func TestItemStarted_CommandExecution(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()

	sess.notify("item/started", `{"threadId":"t","turnId":"u","startedAtMs":1,"item":{
		"type":"commandExecution","id":"exec-1",
		"command":"/bin/bash -lc 'echo hi'","cwd":"/tmp/work","status":"inProgress"}}`)

	events := drainEvents(sess.events)
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	call, ok := events[0].(agent.ToolCallEvent)
	if !ok {
		t.Fatalf("expected ToolCallEvent, got %T", events[0])
	}
	if call.ToolName != "Bash" || call.ToolUseID != "exec-1" {
		t.Errorf("unexpected call: %+v", call)
	}
	var input map[string]string
	if err := json.Unmarshal(call.ToolInput, &input); err != nil {
		t.Fatalf("tool input is not an object: %v", err)
	}
	if input["command"] != "/bin/bash -lc 'echo hi'" || input["cwd"] != "/tmp/work" {
		t.Errorf("unexpected tool input: %v", input)
	}
}

func TestItemCompleted_CommandExecution(t *testing.T) {
	tests := []struct {
		name        string
		item        string
		wantResult  string
		wantIsError bool
	}{
		{
			name:       "output",
			item:       `{"type":"commandExecution","id":"e","status":"completed","exitCode":0,"aggregatedOutput":"hello\n"}`,
			wantResult: "hello\n",
		},
		{
			// Measured on codex-cli 0.153.0: a command that writes nothing
			// reports aggregatedOutput as null, and it succeeded.
			name:       "silent success",
			item:       `{"type":"commandExecution","id":"e","status":"completed","exitCode":0,"aggregatedOutput":null}`,
			wantResult: "",
		},
		{
			// A silent failure would otherwise render as an empty result with
			// no hint that the command did not succeed.
			name:        "silent failure",
			item:        `{"type":"commandExecution","id":"e","status":"failed","exitCode":2,"aggregatedOutput":null}`,
			wantResult:  "(no output, exit code 2)",
			wantIsError: true,
		},
		{
			name:        "declined",
			item:        `{"type":"commandExecution","id":"e","status":"declined","exitCode":null,"aggregatedOutput":null}`,
			wantResult:  deniedByUser,
			wantIsError: true,
		},
		{
			name:        "failed with output",
			item:        `{"type":"commandExecution","id":"e","status":"failed","exitCode":1,"aggregatedOutput":"boom\n"}`,
			wantResult:  "boom\n",
			wantIsError: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			sess := newTestSession()
			defer sess.cancel()

			sess.notify("item/completed", `{"threadId":"t","turnId":"u","completedAtMs":1,"item":`+tt.item+`}`)

			events := drainEvents(sess.events)
			if len(events) != 1 {
				t.Fatalf("expected 1 event, got %d", len(events))
			}
			result := events[0].(agent.ToolResultEvent)
			if result.ToolResult != tt.wantResult {
				t.Errorf("ToolResult = %q, want %q", result.ToolResult, tt.wantResult)
			}
			if result.IsError != tt.wantIsError {
				t.Errorf("IsError = %v, want %v", result.IsError, tt.wantIsError)
			}
		})
	}
}

// The patch comes across as Codex sent it, because web/src/lib/codexChanges.ts
// renders that shape; file_path is what the collapsed row shows.
func TestItemStarted_FileChange(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()

	sess.notify("item/started", `{"threadId":"t","turnId":"u","startedAtMs":1,"item":{
		"type":"fileChange","id":"patch-1","status":"inProgress","changes":[
		{"path":"/tmp/work/a.txt","kind":{"type":"update","move_path":null},"diff":"@@ -1 +1 @@\n-a\n+b\n"}]}}`)

	call := drainEvents(sess.events)[0].(agent.ToolCallEvent)
	if call.ToolName != "Edit" || call.ToolUseID != "patch-1" {
		t.Errorf("unexpected call: %+v", call)
	}
	var input struct {
		FilePath string            `json:"file_path"`
		Changes  []json.RawMessage `json:"changes"`
	}
	if err := json.Unmarshal(call.ToolInput, &input); err != nil {
		t.Fatalf("tool input is not the expected object: %v", err)
	}
	if input.FilePath != "/tmp/work/a.txt" {
		t.Errorf("file_path = %q", input.FilePath)
	}
	if len(input.Changes) != 1 {
		t.Errorf("changes = %v, want the patch passed through", input.Changes)
	}
}

func TestItemCompleted_FileChange(t *testing.T) {
	tests := []struct {
		status      string
		wantResult  string
		wantIsError bool
	}{
		// A patch reports no output, so a successful one says nothing and the
		// call's own input is what the user reads.
		{"completed", "", false},
		{"declined", deniedByUser, true},
		{"failed", "The patch could not be applied.", true},
	}

	for _, tt := range tests {
		t.Run(tt.status, func(t *testing.T) {
			sess := newTestSession()
			defer sess.cancel()

			sess.notify("item/completed", `{"threadId":"t","turnId":"u","completedAtMs":1,"item":{
				"type":"fileChange","id":"patch-1","status":"`+tt.status+`","changes":[]}}`)

			result := drainEvents(sess.events)[0].(agent.ToolResultEvent)
			if result.ToolResult != tt.wantResult || result.IsError != tt.wantIsError {
				t.Errorf("got %+v, want %q / %v", result, tt.wantResult, tt.wantIsError)
			}
		})
	}
}

func TestItemStarted_MCPToolCall(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()

	sess.notify("item/started", `{"threadId":"t","turnId":"u","startedAtMs":1,"item":{
		"type":"mcpToolCall","id":"call-1","server":"pockode","tool":"work_get",
		"status":"inProgress","arguments":{"id":"w1"}}}`)

	call := drainEvents(sess.events)[0].(agent.ToolCallEvent)
	if call.ToolName != "pockode:work_get" {
		t.Errorf("ToolName = %q, want server:tool", call.ToolName)
	}
	if string(call.ToolInput) != `{"id":"w1"}` {
		t.Errorf("ToolInput = %s, want the arguments verbatim", call.ToolInput)
	}
}

// An argument-less tool must still produce valid JSON input, not an empty
// string the frontend cannot parse. `arguments` is typed as any JSON, so both
// ways of saying "none" have to land on the same object.
func TestItemStarted_MCPToolCallWithoutArguments(t *testing.T) {
	tests := []struct {
		name string
		item string
	}{
		{"omitted", `{"type":"mcpToolCall","id":"call-1","server":"pockode","tool":"work_list","status":"inProgress"}`},
		{"null", `{"type":"mcpToolCall","id":"call-1","server":"pockode","tool":"work_list","status":"inProgress","arguments":null}`},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			sess := newTestSession()
			defer sess.cancel()

			sess.notify("item/started", `{"threadId":"t","turnId":"u","startedAtMs":1,"item":`+tt.item+`}`)

			call := drainEvents(sess.events)[0].(agent.ToolCallEvent)
			if string(call.ToolInput) != `{}` {
				t.Errorf("ToolInput = %s, want an empty object", call.ToolInput)
			}
		})
	}
}

func TestItemCompleted_MCPToolCall(t *testing.T) {
	tests := []struct {
		name        string
		item        string
		wantResult  string
		wantIsError bool
	}{
		{
			name:       "ok",
			item:       `{"type":"mcpToolCall","id":"c","server":"s","tool":"t","status":"completed","result":{"content":[{"type":"text","text":"done"}]}}`,
			wantResult: "done",
		},
		{
			name:       "several content parts",
			item:       `{"type":"mcpToolCall","id":"c","server":"s","tool":"t","status":"completed","result":{"content":[{"type":"text","text":"one"},{"type":"text","text":"two"}]}}`,
			wantResult: "one\ntwo",
		},
		{
			name:        "failed",
			item:        `{"type":"mcpToolCall","id":"c","server":"s","tool":"t","status":"failed","error":{"message":"tool not found"}}`,
			wantResult:  "tool not found",
			wantIsError: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			sess := newTestSession()
			defer sess.cancel()

			sess.notify("item/completed", `{"threadId":"t","turnId":"u","completedAtMs":1,"item":`+tt.item+`}`)

			result := drainEvents(sess.events)[0].(agent.ToolResultEvent)
			if result.ToolResult != tt.wantResult || result.IsError != tt.wantIsError {
				t.Errorf("got %+v, want %q / %v", result, tt.wantResult, tt.wantIsError)
			}
		})
	}
}

func TestItemCompleted_AgentMessage(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()

	sess.notify("item/completed", `{"threadId":"t","turnId":"u","completedAtMs":1,"item":{
		"type":"agentMessage","id":"msg_1","text":"hello there","phase":"final_answer"}}`)

	text, ok := drainEvents(sess.events)[0].(agent.TextEvent)
	if !ok || text.Content != "hello there" {
		t.Errorf("expected the message text, got %v", text)
	}
}

// The turn every event came out of is stamped on it, which is the whole
// prerequisite for forking: a fork can only name the point it was taken at in
// Codex's own terms, and a turn id is the anchor `thread/fork` accepts. Without
// this a Codex fork carries nothing (see carriableThread).
func TestEventsCarryTheirTurnID(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()

	// No turn/started: the id must come from the notification each item arrived
	// in, so that a record still names its turn after the session has moved on.
	sess.notify("item/started", `{"threadId":"t","turnId":"turn-7","startedAtMs":1,"item":{
		"type":"commandExecution","id":"exec-1","command":"echo hi","cwd":"/tmp","status":"inProgress"}}`)
	sess.notify("item/completed", `{"threadId":"t","turnId":"turn-7","completedAtMs":2,"item":{
		"type":"commandExecution","id":"exec-1","status":"completed","exitCode":0,"aggregatedOutput":"hi\n"}}`)
	sess.notify("item/completed", `{"threadId":"t","turnId":"turn-7","completedAtMs":3,"item":{
		"type":"fileChange","id":"patch-1","status":"completed","changes":[]}}`)
	sess.notify("item/completed", `{"threadId":"t","turnId":"turn-7","completedAtMs":4,"item":{
		"type":"mcpToolCall","id":"mcp-1","server":"pockode","tool":"work_get","status":"completed",
		"result":{"content":[{"type":"text","text":"ok"}]}}}`)
	sess.notify("item/completed", `{"threadId":"t","turnId":"turn-7","completedAtMs":5,"item":{
		"type":"agentMessage","id":"msg-1","text":"done","phase":"final_answer"}}`)

	// Read as records, because that is the form a fork's anchor is searched in.
	events := drainEvents(sess.events)
	if len(events) != 5 {
		t.Fatalf("expected the call and the four results, got %v", events)
	}
	for _, event := range events {
		if got := event.ToRecord().ProviderMessageID; got != "turn-7" {
			t.Errorf("%T carries provider message id %q, want the turn id", event, got)
		}
	}
}

// Nothing Pockode raises by itself belongs to a turn, and saying one anyway
// would anchor a fork on a turn the record did not come out of.
func TestEventsOutsideATurnCarryNoTurnID(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()

	sess.notify("warning", `{"message":"heads up"}`)

	if got := drainEvents(sess.events)[0].ToRecord().ProviderMessageID; got != "" {
		t.Errorf("provider message id = %q, want none", got)
	}
}

// Notifications that duplicate content rendered elsewhere, or that describe
// bookkeeping, must not reach the transcript: Codex sends dozens per turn.
func TestBookkeepingNotificationsAreDropped(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()

	drops := []struct{ method, params string }{
		{"thread/started", `{"thread":{"id":"t"}}`},
		{"thread/status/changed", `{"threadId":"t","status":{"type":"idle"}}`},
		{"item/agentMessage/delta", `{"threadId":"t","turnId":"u","itemId":"m","delta":"par"}`},
		{"item/reasoning/textDelta", `{"threadId":"t","turnId":"u","itemId":"r","delta":"thinking"}`},
		{"turn/diff/updated", `{"threadId":"t","turnId":"u","diff":""}`},
		{"account/rateLimits/updated", `{"rateLimits":{"limitId":"codex"}}`},
		{"serverRequest/resolved", `{"threadId":"t","requestId":0}`},
		{"deprecationNotice", `{"message":"upgrade"}`},
		// The prompt Pockode just sent, echoed back as an item.
		{"item/started", `{"threadId":"t","turnId":"u","startedAtMs":1,"item":{"type":"userMessage","id":"m","content":[{"type":"text","text":"hi"}]}}`},
		{"item/completed", `{"threadId":"t","turnId":"u","completedAtMs":1,"item":{"type":"userMessage","id":"m","content":[{"type":"text","text":"hi"}]}}`},
		// Real information with no surface in Pockode yet.
		{"item/completed", `{"threadId":"t","turnId":"u","completedAtMs":1,"item":{"type":"reasoning","id":"r","summary":[],"content":[]}}`},
		{"item/completed", `{"threadId":"t","turnId":"u","completedAtMs":1,"item":{"type":"webSearch","id":"w","query":"go"}}`},
	}
	for _, d := range drops {
		sess.notify(d.method, d.params)
	}

	if events := drainEvents(sess.events); len(events) != 0 {
		t.Errorf("expected no events, got %v", events)
	}
}

// --- Turn lifecycle ---

func TestTurnCompleted_EndsTheTurn(t *testing.T) {
	tests := []struct {
		name     string
		turn     string
		want     agent.EventType
		wantText string
	}{
		{
			name: "completed",
			turn: `{"id":"u","items":[],"status":"completed"}`,
			want: agent.EventTypeDone,
		},
		{
			name: "interrupted",
			turn: `{"id":"u","items":[],"status":"interrupted"}`,
			want: agent.EventTypeInterrupted,
		},
		{
			name:     "failed",
			turn:     `{"id":"u","items":[],"status":"failed","error":{"message":"unauthorized"}}`,
			want:     agent.EventTypeError,
			wantText: "unauthorized",
		},
		{
			// A failure with nothing to say still has to be reported as one.
			name:     "failed without a message",
			turn:     `{"id":"u","items":[],"status":"failed","error":null}`,
			want:     agent.EventTypeError,
			wantText: "codex reported an error without a message",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			sess := newTestSession()
			defer sess.cancel()
			sess.adoptTurn("u")

			sess.notify("turn/completed", `{"threadId":"t","turn":`+tt.turn+`}`)

			events := drainEvents(sess.events)
			if len(events) != 1 {
				t.Fatalf("expected exactly one event to end the turn, got %v", events)
			}
			if got := events[0].EventType(); got != tt.want {
				t.Fatalf("event = %s, want %s", got, tt.want)
			}
			if tt.wantText != "" {
				if got := events[0].(agent.ErrorEvent).Error; got != tt.wantText {
					t.Errorf("Error = %q, want %q", got, tt.wantText)
				}
			}
			if _, turnID := sess.currentTurn(); turnID != "" {
				t.Errorf("turn id = %q, want it cleared", turnID)
			}
		})
	}
}

// A turn ending in a frame we cannot read is still a turn that ended; leaving it
// pending would hang the session on an event that is never coming.
func TestTurnCompleted_UnreadableFrameStillEndsTheTurn(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()
	sess.adoptTurn("u")

	sess.notify("turn/completed", `not json`)

	events := drainEvents(sess.events)
	if len(events) != 1 || events[0].EventType() != agent.EventTypeDone {
		t.Fatalf("expected the turn to end, got %v", events)
	}
}

func TestTurnStarted_RecordsTheTurn(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()
	sess.stateMu.Lock()
	sess.threadID = "t"
	sess.stateMu.Unlock()

	sess.notify("turn/started", `{"threadId":"t","turn":{"id":"turn-7","items":[],"status":"inProgress"}}`)

	threadID, turnID := sess.currentTurn()
	if threadID != "t" || turnID != "turn-7" {
		t.Errorf("currentTurn() = %q/%q, want t/turn-7", threadID, turnID)
	}
}

// An item the turn never completed — because the turn was interrupted while it
// ran — would otherwise sit in the map for the life of the process.
func TestTurnCompleted_ForgetsUnfinishedItems(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()

	sess.notify("item/started", `{"threadId":"t","turnId":"u","startedAtMs":1,"item":{
		"type":"commandExecution","id":"exec-1","command":"sleep 100","cwd":"/tmp","status":"inProgress"}}`)
	if _, ok := sess.toolInput("exec-1"); !ok {
		t.Fatal("expected the started item to be remembered")
	}

	sess.notify("turn/completed", `{"threadId":"t","turn":{"id":"u","items":[],"status":"interrupted"}}`)

	if _, ok := sess.toolInput("exec-1"); ok {
		t.Error("expected the unfinished item to be forgotten")
	}
}

// --- Errors and warnings ---

// A fatal failure is reported by turn/completed, which also covers the failures
// that produce no error notification at all; emitting here as well would show
// the user the same failure twice.
func TestErrorNotification_FatalIsLeftToTheTurn(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()

	sess.notify("error", `{"threadId":"t","turnId":"u","willRetry":false,"error":{"message":"unauthorized"}}`)

	if events := drainEvents(sess.events); len(events) != 0 {
		t.Errorf("expected no events, got %v", events)
	}
}

// A retry is the one case turn/completed will not report, because the turn goes
// on — and it is what explains a turn that has stalled.
func TestErrorNotification_RetryBecomesAWarning(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()

	sess.notify("error", `{"threadId":"t","turnId":"u","willRetry":true,"error":{"message":"stream disconnected, retrying"}}`)

	warning := drainEvents(sess.events)[0].(agent.WarningEvent)
	if warning.Message != "stream disconnected, retrying" || warning.Code != "stream_error" {
		t.Errorf("unexpected warning: %+v", warning)
	}
}

func TestWarningNotifications(t *testing.T) {
	tests := []struct {
		method   string
		params   string
		wantCode string
		wantText string
	}{
		{"warning", `{"message":"a warning"}`, "warning", "a warning"},
		{"guardianWarning", `{"threadId":"t","message":"guardrail tripped"}`, "guardian_warning", "guardrail tripped"},
		// configWarning words the same thing differently.
		{"configWarning", `{"summary":"bubblewrap is missing","details":null}`, "config_warning", "bubblewrap is missing"},
	}

	for _, tt := range tests {
		t.Run(tt.method, func(t *testing.T) {
			sess := newTestSession()
			defer sess.cancel()

			sess.notify(tt.method, tt.params)

			warning := drainEvents(sess.events)[0].(agent.WarningEvent)
			if warning.Code != tt.wantCode || warning.Message != tt.wantText {
				t.Errorf("got %+v, want %q / %q", warning, tt.wantCode, tt.wantText)
			}
		})
	}
}

// A server that fails to start silently removes its tools from the session —
// for the pockode server that means no work_* tools at all.
func TestMCPServerStartupFailureWarns(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()

	sess.notify("mcpServer/startupStatus/updated", `{"threadId":"t","name":"pockode","status":"starting"}`)
	sess.notify("mcpServer/startupStatus/updated", `{"threadId":"t","name":"pockode","status":"ready"}`)
	if events := drainEvents(sess.events); len(events) != 0 {
		t.Fatalf("expected progress to be silent, got %v", events)
	}

	sess.notify("mcpServer/startupStatus/updated",
		`{"threadId":"t","name":"pockode","status":"failed","error":"handshaking with MCP server failed"}`)

	warning := drainEvents(sess.events)[0].(agent.WarningEvent)
	if warning.Code != "mcp_startup_failed" {
		t.Errorf("Code = %q", warning.Code)
	}
	if !strings.Contains(warning.Message, "pockode") {
		t.Errorf("Message = %q, want it to name the server", warning.Message)
	}
}

// --- Approvals ---

// A file change approval names only the item, so its patch has to come from the
// item/started that preceded it — the same rendering already on screen.
func TestApproval_FileChangeUsesTheStartedItem(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()
	writer := &recordingWriteCloser{}
	sess.stdin = writer

	sess.notify("item/started", `{"threadId":"t","turnId":"u","startedAtMs":1,"item":{
		"type":"fileChange","id":"patch-1","status":"inProgress","changes":[
		{"path":"/tmp/work/a.txt","kind":{"type":"add"},"diff":"hello\n"}]}}`)
	if _, ok := drainEvents(sess.events)[0].(agent.ToolCallEvent); !ok {
		t.Fatal("expected the patch to be rendered as a tool call")
	}

	id := int64(9)
	go sess.handleApproval(rpcMessage{
		ID:     &id,
		Method: "item/fileChange/requestApproval",
		Params: json.RawMessage(`{"threadId":"t","turnId":"u","itemId":"patch-1","startedAtMs":1}`),
	})

	request := waitForEvent(t, sess).(agent.PermissionRequestEvent)
	if request.RequestID != "patch-1" || request.ToolUseID != "patch-1" {
		t.Errorf("unexpected request ids: %+v", request)
	}
	if request.ToolName != "Edit" {
		t.Errorf("ToolName = %q, want Edit", request.ToolName)
	}
	if !strings.Contains(string(request.ToolInput), "/tmp/work/a.txt") {
		t.Errorf("ToolInput = %s, want the patch from the started item", request.ToolInput)
	}

	if err := sess.SendPermissionResponse(agent.PermissionRequestData{RequestID: "patch-1"}, agent.PermissionAllow); err != nil {
		t.Fatalf("SendPermissionResponse error: %v", err)
	}
	assertDecision(t, writer, decisionAccept)
}

// A command approval carries the command itself, so it does not depend on
// having seen the item start.
func TestApproval_CommandWithoutAStartedItem(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()
	writer := &recordingWriteCloser{}
	sess.stdin = writer

	id := int64(3)
	go sess.handleApproval(rpcMessage{
		ID:     &id,
		Method: "item/commandExecution/requestApproval",
		Params: json.RawMessage(`{"threadId":"t","turnId":"u","itemId":"exec-1","startedAtMs":1,
			"command":"/bin/bash -lc 'rm -rf x'","cwd":"/tmp/work","kind":"command"}`),
	})

	request := waitForEvent(t, sess).(agent.PermissionRequestEvent)
	if request.ToolName != "Bash" {
		t.Errorf("ToolName = %q, want Bash", request.ToolName)
	}
	if !strings.Contains(string(request.ToolInput), "rm -rf x") {
		t.Errorf("ToolInput = %s, want the command from the request", request.ToolInput)
	}

	if err := sess.SendPermissionResponse(agent.PermissionRequestData{RequestID: "exec-1"}, agent.PermissionDeny); err != nil {
		t.Fatalf("SendPermissionResponse error: %v", err)
	}
	assertDecision(t, writer, decisionDecline)
}

// One item can carry several approval callbacks (subcommand and stdin
// approvals), and approvalId is what keeps two of them from answering each
// other.
func TestApproval_ApprovalIDDistinguishesCallbacks(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()

	id := int64(4)
	go sess.handleApproval(rpcMessage{
		ID:     &id,
		Method: "item/commandExecution/requestApproval",
		Params: json.RawMessage(`{"threadId":"t","turnId":"u","itemId":"exec-1","approvalId":"cb-2",
			"startedAtMs":1,"command":"ls","cwd":"/tmp"}`),
	})

	request := waitForEvent(t, sess).(agent.PermissionRequestEvent)
	if request.RequestID != "cb-2" {
		t.Errorf("RequestID = %q, want the callback id", request.RequestID)
	}
	if request.ToolUseID != "exec-1" {
		t.Errorf("ToolUseID = %q, want the item id", request.ToolUseID)
	}
}

func TestSendPermissionResponse_Decisions(t *testing.T) {
	tests := []struct {
		choice agent.PermissionChoice
		want   string
	}{
		{agent.PermissionAllow, decisionAccept},
		{agent.PermissionAlwaysAllow, decisionAcceptForSession},
		{agent.PermissionDeny, decisionDecline},
	}

	for _, tt := range tests {
		t.Run(tt.want, func(t *testing.T) {
			sess := newTestSession()
			defer sess.cancel()

			ch := make(chan string, 1)
			sess.pendingApprovals.Store("req-1", ch)

			if err := sess.SendPermissionResponse(agent.PermissionRequestData{RequestID: "req-1"}, tt.choice); err != nil {
				t.Fatalf("SendPermissionResponse error: %v", err)
			}
			select {
			case got := <-ch:
				if got != tt.want {
					t.Errorf("decision = %q, want %q", got, tt.want)
				}
			default:
				t.Fatal("no decision reached the waiting approval")
			}
		})
	}
}

// A decision Pockode does not recognise must fail closed.
func TestApprovalResult_FailsClosed(t *testing.T) {
	if got := approvalResult("something else")["decision"]; got != decisionDecline {
		t.Errorf("decision = %v, want %q", got, decisionDecline)
	}
	if got := approvalResult(decisionAcceptForSession)["decision"]; got != decisionAcceptForSession {
		t.Errorf("decision = %v, want it passed through", got)
	}
}

// assertDecision reads the reply the approval goroutine wrote.
func assertDecision(t *testing.T, writer *recordingWriteCloser, want string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		writer.mu.Lock()
		writes := append([][]byte(nil), writer.writes...)
		writer.mu.Unlock()
		for _, w := range writes {
			var resp struct {
				Result struct {
					Decision string `json:"decision"`
				} `json:"result"`
			}
			if json.Unmarshal(w, &resp) == nil && resp.Result.Decision != "" {
				if resp.Result.Decision != want {
					t.Fatalf("decision = %q, want %q", resp.Result.Decision, want)
				}
				return
			}
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("timed out waiting for a %q decision to be written", want)
}

// --- Interrupt ---

// A turn blocked on an approval is not looking at its interrupt request, so
// answering is what unblocks it — and the prompt has to be withdrawn from the
// UI before the turn's own interrupted event lands.
func TestSendInterrupt_CancelsPendingApprovalsFirst(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()
	writer := &recordingWriteCloser{}
	sess.stdin = writer
	sess.stateMu.Lock()
	sess.threadID, sess.turnID = "t", "u"
	sess.stateMu.Unlock()

	ch := make(chan string, 1)
	sess.pendingApprovals.Store("req-1", ch)

	if err := sess.SendInterrupt(); err != nil {
		t.Fatalf("SendInterrupt error: %v", err)
	}

	select {
	case got := <-ch:
		// cancel, not decline: both refuse, but only cancel ends the turn.
		if got != decisionCancel {
			t.Errorf("decision = %q, want %q", got, decisionCancel)
		}
	default:
		t.Fatal("the pending approval was not answered")
	}

	cancelled, ok := drainEvents(sess.events)[0].(agent.RequestCancelledEvent)
	if !ok || cancelled.RequestID != "req-1" {
		t.Errorf("expected the prompt to be withdrawn, got %v", cancelled)
	}

	req := writer.waitForRequest(t, "turn/interrupt")
	var params map[string]string
	if err := json.Unmarshal(req.Params, &params); err != nil {
		t.Fatalf("interrupt params: %v", err)
	}
	if params["threadId"] != "t" || params["turnId"] != "u" {
		t.Errorf("interrupt params = %v, want the running turn", params)
	}
}

// Interrupting with no turn named must not send an interrupt Codex would refuse
// with "no active turn to interrupt". The stop is remembered rather than sent —
// see TestSendInterrupt_BeforeTheTurnStartsStopsItWhenItDoes for where it goes.
func TestSendInterrupt_NoTurnSendsNothing(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()
	writer := &recordingWriteCloser{}
	sess.stdin = writer

	if err := sess.SendInterrupt(); err != nil {
		t.Fatalf("SendInterrupt error: %v", err)
	}

	if reqs := writer.requests(); len(reqs) != 0 {
		t.Errorf("expected nothing to be sent, got %v", reqs)
	}
}

func TestCancelPendingApprovals_NoPendingIsNoop(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()

	sess.cancelPendingApprovals()

	if events := drainEvents(sess.events); len(events) != 0 {
		t.Errorf("expected 0 events, got %v", events)
	}
}

func TestCancelPendingApprovals_WithdrawsEveryPrompt(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()

	sess.pendingApprovals.Store("req-a", make(chan string, 1))
	sess.pendingApprovals.Store("req-b", make(chan string, 1))

	sess.cancelPendingApprovals()

	ids := map[string]bool{}
	for _, ev := range drainEvents(sess.events) {
		cancelled, ok := ev.(agent.RequestCancelledEvent)
		if !ok {
			t.Fatalf("expected RequestCancelledEvent, got %T", ev)
		}
		ids[cancelled.RequestID] = true
	}
	if !ids["req-a"] || !ids["req-b"] {
		t.Errorf("expected both prompts to be withdrawn, got %v", ids)
	}
}

// --- Messages ---

func TestSendMessage_StartsATurnOnTheThread(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()
	writer := &recordingWriteCloser{}
	sess.stdin = writer
	sess.stateMu.Lock()
	sess.threadID = "thread-1"
	sess.stateMu.Unlock()

	if err := sess.SendMessage("hello"); err != nil {
		t.Fatalf("SendMessage error: %v", err)
	}

	req := writer.waitForRequest(t, "turn/start")
	var params struct {
		ThreadID string `json:"threadId"`
		Input    []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"input"`
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		t.Fatalf("turn/start params: %v", err)
	}
	if params.ThreadID != "thread-1" {
		t.Errorf("threadId = %q", params.ThreadID)
	}
	if len(params.Input) != 1 || params.Input[0].Type != "text" || params.Input[0].Text != "hello" {
		t.Errorf("input = %+v, want one text item", params.Input)
	}
}

// Nothing else ends a turn that never started, so the refusal has to.
func TestSendMessage_RefusedTurnEndsAsAnError(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()
	writer := &recordingWriteCloser{}
	sess.stdin = writer
	sess.stateMu.Lock()
	sess.threadID = "thread-1"
	sess.stateMu.Unlock()

	if err := sess.SendMessage("hello"); err != nil {
		t.Fatalf("SendMessage error: %v", err)
	}
	req := writer.waitForRequest(t, "turn/start")
	sess.handleResponse(rpcMessage{ID: req.ID, Error: &rpcError{Code: -32600, Message: "thread is busy"}})

	ev := waitForEvent(t, sess)
	errEvent, ok := ev.(agent.ErrorEvent)
	if !ok {
		t.Fatalf("expected an error event, got %T", ev)
	}
	if !strings.Contains(errEvent.Error, "thread is busy") {
		t.Errorf("Error = %q, want it to carry Codex's reason", errEvent.Error)
	}
}

func TestSendMessage_WithoutAThreadFails(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()

	if err := sess.SendMessage("hello"); err == nil {
		t.Error("expected an error when the session has no thread")
	}
}

// --- Startup ---

// process.Manager calls Agent.Start under its worktree-wide process lock, so a
// CLI that never answers must fail on a deadline of its own — one that does not
// take the running process down with it.
func TestInitialize_DeadlineFailsWithoutCancellingProcess(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()

	ctx, cancel := context.WithTimeout(sess.procCtx, 50*time.Millisecond)
	defer cancel()

	err := sess.initialize(ctx)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected a deadline error, got %v", err)
	}
	if sess.procCtx.Err() != nil {
		t.Fatalf("handshake deadline cancelled procCtx: %v", sess.procCtx.Err())
	}
}

// The handshake has to declare experimentalApi at the one moment it is
// negotiated; without it the CLI refuses the fields that carry a fork point.
func TestInitialize_DeclaresTheExperimentalAPI(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()
	writer := &recordingWriteCloser{}
	sess.stdin = writer

	ctx, cancel := context.WithCancel(sess.procCtx)
	defer cancel()
	go func() {
		req := writer.waitForRequest(t, "initialize")
		sess.handleResponse(rpcMessage{ID: req.ID, Result: json.RawMessage(`{}`)})
	}()
	if err := sess.initialize(ctx); err != nil {
		t.Fatalf("initialize error: %v", err)
	}

	req := writer.waitForRequest(t, "initialize")
	var params struct {
		ClientInfo struct {
			Name string `json:"name"`
		} `json:"clientInfo"`
		Capabilities struct {
			ExperimentalAPI bool `json:"experimentalApi"`
		} `json:"capabilities"`
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		t.Fatalf("initialize params: %v", err)
	}
	if !params.Capabilities.ExperimentalAPI {
		t.Error("expected experimentalApi to be declared")
	}
	if params.ClientInfo.Name != "pockode" {
		t.Errorf("clientInfo.name = %q", params.ClientInfo.Name)
	}
}

// --- Server requests Pockode does not act on ---

// Every request the CLI makes has to be answered: an unanswered one leaves the
// turn waiting for a reply that is never coming. These are the ones Pockode has
// no surface for, so what matters is that each gets a definite answer.
func TestServerRequests_AreAlwaysAnswered(t *testing.T) {
	tests := []struct {
		name   string
		method string
		params string
		// want is a fragment of the reply that identifies the right answer.
		want string
	}{
		{
			// An MCP server asking the user to fill in a form. Declining lets the
			// server's call fail instead of hanging the turn forever.
			name:   "mcp elicitation",
			method: "mcpServer/elicitation/request",
			params: `{"serverName":"other","message":"Pick one"}`,
			want:   `"action":"decline"`,
		},
		{
			// Codex's AskUserQuestion counterpart. `answers` is required, and an
			// empty one is "asked, and nothing came back".
			name:   "requestUserInput",
			method: "item/tool/requestUserInput",
			params: `{"threadId":"t","turnId":"u","itemId":"i","isBlocking":true,"questions":[]}`,
			want:   `"answers":{}`,
		},
		{
			// Only reachable under the granular approval policy, which Pockode
			// does not set. The reply's shape is the permissions handed over, so
			// granting nothing is the refusal.
			name:   "permissions grant",
			method: "item/permissions/requestApproval",
			params: `{"threadId":"t","turnId":"u","itemId":"i","cwd":"/tmp","startedAtMs":1,"permissions":{}}`,
			want:   `"permissions":{}`,
		},
		{
			// Anything else is refused rather than ignored.
			name:   "unknown method",
			method: "some/futureRequest",
			params: `{}`,
			want:   `"code":-32601`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			sess := newTestSession()
			defer sess.cancel()
			writer := &recordingWriteCloser{}
			sess.stdin = writer

			id := int64(7)
			sess.handleServerRequest(rpcMessage{ID: &id, Method: tt.method, Params: json.RawMessage(tt.params)})

			writer.mu.Lock()
			defer writer.mu.Unlock()
			if len(writer.writes) != 1 {
				t.Fatalf("expected exactly one reply, got %d", len(writer.writes))
			}
			reply := string(writer.writes[0])
			if !strings.Contains(reply, tt.want) {
				t.Errorf("reply = %s, want it to contain %s", reply, tt.want)
			}
		})
	}
}

// Two live approvals under one id would let the user's single answer settle one
// of them while the other waits for an answer that can never arrive — a turn
// stuck for the life of the process.
func TestApproval_DuplicateRequestIDIsRefused(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()
	writer := &recordingWriteCloser{}
	sess.stdin = writer

	params := json.RawMessage(`{"threadId":"t","turnId":"u","itemId":"exec-1","startedAtMs":1,"command":"ls","cwd":"/tmp"}`)
	first := int64(1)
	go sess.handleApproval(rpcMessage{ID: &first, Method: "item/commandExecution/requestApproval", Params: params})
	waitForEvent(t, sess) // the first prompt reaches the user

	second := int64(2)
	sess.handleApproval(rpcMessage{ID: &second, Method: "item/commandExecution/requestApproval", Params: params})

	assertDecision(t, writer, decisionDecline)
	if events := drainEvents(sess.events); len(events) != 0 {
		t.Errorf("the refused duplicate should raise no second prompt, got %v", events)
	}
}

// An approval prompt that says nothing is worse than one that says why it was
// raised: the user is being asked to approve something either way.
func TestApproval_WithoutACommandFallsBackToTheReason(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()

	id := int64(5)
	go sess.handleApproval(rpcMessage{
		ID:     &id,
		Method: "item/commandExecution/requestApproval",
		Params: json.RawMessage(`{"threadId":"t","turnId":"u","itemId":"exec-1","startedAtMs":1,
			"kind":"writeStdin","reason":"May I send input to the running command?"}`),
	})

	request := waitForEvent(t, sess).(agent.PermissionRequestEvent)
	if !strings.Contains(string(request.ToolInput), "May I send input") {
		t.Errorf("ToolInput = %s, want the request's own explanation", request.ToolInput)
	}
}

// A patch is not in its approval request, so an approval for an item we never
// saw start has nothing to render. The user is still being asked to approve it,
// so the request's own explanation has to stand in.
func TestApproval_FileChangeWithoutItemFallsBackToTheReason(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()

	id := int64(6)
	go sess.handleApproval(rpcMessage{
		ID:     &id,
		Method: "item/fileChange/requestApproval",
		Params: json.RawMessage(`{"threadId":"t","turnId":"u","itemId":"patch-1","startedAtMs":1,
			"reason":"command failed; retry without sandbox?"}`),
	})

	request := waitForEvent(t, sess).(agent.PermissionRequestEvent)
	if request.ToolName != "Edit" {
		t.Errorf("ToolName = %q, want Edit", request.ToolName)
	}
	if !strings.Contains(string(request.ToolInput), "retry without sandbox") {
		t.Errorf("ToolInput = %s, want the request's own explanation", request.ToolInput)
	}
}

// --- Ending the event stream ---

// TestEmitEvent_AfterTheStreamEndsIsDropped covers the goroutines that are not
// the reader: an approval waiting on the user, or the callback of an async
// request. Either can reach emitEvent for the first time after the reader has
// already ended the stream, and a send on a closed channel would panic on a
// goroutine with no recover — taking the server down, not the session.
func TestEmitEvent_AfterTheStreamEndsIsDropped(t *testing.T) {
	sess := newTestSession()
	sess.closeEvents()

	done := make(chan struct{})
	go func() {
		defer close(done)
		sess.emitEvent(agent.WarningEvent{Message: "late", Code: "late"})
	}()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("emitEvent blocked after the stream ended")
	}

	if _, ok := <-sess.events; ok {
		t.Error("the stream is still open after closeEvents")
	}
}

// TestCloseEvents_WaitsForSendersInFlight is the other half: a sender already
// parked in emitEvent must be let out before the channel closes, and closing
// must not deadlock waiting for it. Cancelling procCtx first is what frees it.
func TestCloseEvents_WaitsForSendersInFlight(t *testing.T) {
	sess := newTestSession()
	// Fill the channel so the next send has to park.
	for i := 0; i < cap(sess.events); i++ {
		sess.events <- agent.DoneEvent{}
	}

	parked := make(chan struct{})
	go func() {
		defer close(parked)
		sess.emitEvent(agent.WarningEvent{Message: "parked", Code: "parked"})
	}()

	// Give the sender time to reach the select before the stream ends.
	time.Sleep(50 * time.Millisecond)

	closed := make(chan struct{})
	go func() {
		defer close(closed)
		sess.closeEvents()
	}()

	select {
	case <-closed:
	case <-time.After(2 * time.Second):
		t.Fatal("closeEvents deadlocked behind a sender parked in emitEvent")
	}
	select {
	case <-parked:
	case <-time.After(2 * time.Second):
		t.Fatal("the parked sender was never released")
	}
}

// `reason` is nullable, so the fallback can itself have nothing to fall back
// on. The prompt still has to ask the user something: it blocks the turn either
// way, and the frontend renders an all-empty input as no body at all.
func TestApproval_WithoutAnythingToShowStillAsksSomething(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()

	id := int64(7)
	go sess.handleApproval(rpcMessage{
		ID:     &id,
		Method: "item/fileChange/requestApproval",
		Params: json.RawMessage(`{"threadId":"t","turnId":"u","itemId":"patch-1","startedAtMs":1}`),
	})

	request := waitForEvent(t, sess).(agent.PermissionRequestEvent)

	var input map[string]string
	if err := json.Unmarshal(request.ToolInput, &input); err != nil {
		t.Fatalf("ToolInput is not an object: %s", request.ToolInput)
	}
	if len(input) == 0 {
		t.Fatalf("ToolInput = %s, want a prompt the user can act on", request.ToolInput)
	}
	for field, value := range input {
		if value == "" {
			t.Errorf("ToolInput.%s is empty; an empty field renders as no prompt at all", field)
		}
	}
}

// A stop pressed before turn/started has arrived used to find no turn to name
// and send nothing at all — silently, so the turn the user wanted stopped ran to
// completion. The id only arrives with turn/started, which trails the prompt by
// however long the CLI takes to get going, so this window is the user's to lose.
func TestSendInterrupt_BeforeTheTurnStartsStopsItWhenItDoes(t *testing.T) {
	writer := &recordingWriteCloser{}
	sess := newTestSession()
	sess.stdin = writer
	defer sess.cancel()

	sess.stateMu.Lock()
	sess.threadID = "thread-1"
	sess.stateMu.Unlock()

	if err := sess.SendInterrupt(); err != nil {
		t.Fatalf("SendInterrupt: %v", err)
	}
	if reqs := writer.requests(); len(reqs) != 0 {
		t.Fatalf("nothing can be interrupted before a turn is named, got %v", reqs)
	}

	sess.notify("turn/started", `{"threadId":"thread-1","turn":{"id":"turn-7","items":[],"status":"inProgress"}}`)

	req := writer.waitForRequest(t, "turn/interrupt")
	var params map[string]string
	if err := json.Unmarshal(req.Params, &params); err != nil {
		t.Fatalf("parse turn/interrupt params: %v", err)
	}
	if params["turnId"] != "turn-7" || params["threadId"] != "thread-1" {
		t.Errorf("turn/interrupt params = %v, want the turn that just started", params)
	}
}

// The waiting stop belongs to the turn it was meant for, not to whatever the
// user sends afterwards. A turn that ended on its own leaves nothing to stop.
func TestSendInterrupt_WaitingStopDoesNotOutliveTheTurn(t *testing.T) {
	writer := &recordingWriteCloser{}
	sess := newTestSession()
	sess.stdin = writer
	defer sess.cancel()

	sess.stateMu.Lock()
	sess.threadID = "thread-1"
	sess.stateMu.Unlock()

	if err := sess.SendInterrupt(); err != nil {
		t.Fatalf("SendInterrupt: %v", err)
	}
	// The turn it was waiting for finished before it could be named.
	sess.notify("turn/completed", `{"threadId":"thread-1","turn":{"id":"turn-7","items":[],"status":"completed"}}`)

	// Whatever the user sends next must not be stopped by that stale stop.
	sess.notify("turn/started", `{"threadId":"thread-1","turn":{"id":"turn-8","items":[],"status":"inProgress"}}`)

	time.Sleep(50 * time.Millisecond)
	for _, req := range writer.requests() {
		if req.Method == "turn/interrupt" {
			t.Fatalf("a stop that outlived its turn interrupted the next one: %s", req.Params)
		}
	}
}

// A stop with no turn to name waits for one — but a prompt sent afterwards is
// the user asking for work, not the turn they wanted stopped. Without this, a
// stop pressed while the session was idle would kill the next thing they send.
func TestSendInterrupt_WaitingStopIsRetiredByANewPrompt(t *testing.T) {
	writer := &recordingWriteCloser{}
	sess := newTestSession()
	sess.stdin = writer
	defer sess.cancel()

	sess.stateMu.Lock()
	sess.threadID = "thread-1"
	sess.stateMu.Unlock()

	// Stopped while idle: nothing is running, so nothing is sent.
	if err := sess.SendInterrupt(); err != nil {
		t.Fatalf("SendInterrupt: %v", err)
	}
	if err := sess.SendMessage("have another go"); err != nil {
		t.Fatalf("SendMessage: %v", err)
	}

	sess.notify("turn/started", `{"threadId":"thread-1","turn":{"id":"turn-9","items":[],"status":"inProgress"}}`)

	time.Sleep(50 * time.Millisecond)
	for _, req := range writer.requests() {
		if req.Method == "turn/interrupt" {
			t.Fatalf("the new prompt's turn was killed by an earlier idle stop: %s", req.Params)
		}
	}
}

// --- Live progress on a call that has not returned ---

// The delta is genuine stdout, not a copy of something rendered elsewhere: it is
// the only account of a long command while it runs.
func TestCommandOutputDelta_BecomesActivityOnTheCall(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()

	sess.notify("item/commandExecution/outputDelta", `{"threadId":"t","turnId":"u","itemId":"exec-1","delta":"building...\n"}`)

	events := drainEvents(sess.events)
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	activity, ok := events[0].(agent.ToolActivityEvent)
	if !ok {
		t.Fatalf("expected a ToolActivityEvent, got %T", events[0])
	}
	if activity.ToolUseID != "exec-1" || activity.OutputDelta != "building...\n" {
		t.Errorf("unexpected activity: %+v", activity)
	}
	if activity.Activity != "" {
		t.Errorf("a stdout chunk is not a status line, got %q", activity.Activity)
	}
}

func TestMCPToolProgress_BecomesActivityOnTheCall(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()

	sess.notify("item/mcpToolCall/progress", `{"threadId":"t","turnId":"u","itemId":"mcp-1","message":"fetching page 2 of 9"}`)

	events := drainEvents(sess.events)
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	activity := events[0].(agent.ToolActivityEvent)
	if activity.ToolUseID != "mcp-1" || activity.Activity != "fetching page 2 of 9" {
		t.Errorf("unexpected activity: %+v", activity)
	}
}

// Nothing to report is not something to report: an empty chunk or a progress
// frame for no item would put a blank line under a running call.
func TestLiveProgress_EmptyFramesProduceNothing(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()

	sess.notify("item/commandExecution/outputDelta", `{"threadId":"t","turnId":"u","itemId":"exec-1","delta":""}`)
	sess.notify("item/commandExecution/outputDelta", `{"threadId":"t","turnId":"u","itemId":"","delta":"orphan"}`)
	sess.notify("item/mcpToolCall/progress", `{"threadId":"t","turnId":"u","itemId":"mcp-1","message":""}`)
	sess.notify("item/mcpToolCall/progress", `not json`)

	if events := drainEvents(sess.events); len(events) != 0 {
		t.Errorf("expected no events, got %v", events)
	}
}

// Codex's own parse of the command travels as data, because it is a better
// source for a row's title than re-guessing from the command string — and where
// a title is drawn is not the server's decision.
func TestItemStarted_CommandExecutionCarriesCommandActions(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()

	sess.notify("item/started", `{"threadId":"t","turnId":"u","startedAtMs":1,"item":{
		"type":"commandExecution","id":"exec-1","command":"rg -n foo src","cwd":"/tmp/work","status":"inProgress",
		"commandActions":[{"type":"search","command":"rg -n foo src","query":"foo","path":"src"}]}}`)

	events := drainEvents(sess.events)
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	var input struct {
		CommandActions []struct {
			Type  string `json:"type"`
			Query string `json:"query"`
		} `json:"command_actions"`
	}
	if err := json.Unmarshal(events[0].(agent.ToolCallEvent).ToolInput, &input); err != nil {
		t.Fatalf("tool input is not an object: %v", err)
	}
	if len(input.CommandActions) != 1 || input.CommandActions[0].Type != "search" || input.CommandActions[0].Query != "foo" {
		t.Errorf("command actions did not survive: %+v", input.CommandActions)
	}
}

// The exit code and the duration are figures Codex reports; folded into prose
// they can only ever be printed, never rendered.
func TestItemCompleted_CommandExecutionCarriesExitCodeAndDuration(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()

	sess.notify("item/completed", `{"threadId":"t","turnId":"u","completedAtMs":1,"item":{
		"type":"commandExecution","id":"e","status":"failed","exitCode":2,"durationMs":1234,"aggregatedOutput":"boom\n"}}`)

	result := drainEvents(sess.events)[0].(agent.ToolResultEvent)
	if result.ExitCode == nil || *result.ExitCode != 2 {
		t.Errorf("ExitCode = %v, want 2", result.ExitCode)
	}
	if result.DurationMs != 1234 {
		t.Errorf("DurationMs = %d, want 1234", result.DurationMs)
	}
}

func TestItemCompleted_MCPToolCallCarriesDuration(t *testing.T) {
	sess := newTestSession()
	defer sess.cancel()

	sess.notify("item/completed", `{"threadId":"t","turnId":"u","completedAtMs":1,"item":{
		"type":"mcpToolCall","id":"m","server":"srv","tool":"go","status":"completed","durationMs":42,
		"arguments":{},"result":{"content":[{"type":"text","text":"ok"}]}}}`)

	result := drainEvents(sess.events)[0].(agent.ToolResultEvent)
	if result.DurationMs != 42 {
		t.Errorf("DurationMs = %d, want 42", result.DurationMs)
	}
}
