package ws

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/pockode/server/agent"
	"github.com/pockode/server/agentrole"
	"github.com/pockode/server/command"
	"github.com/pockode/server/contents"
	"github.com/pockode/server/rpc"
	"github.com/pockode/server/session"
	"github.com/pockode/server/settings"
	"github.com/pockode/server/work"
	"github.com/pockode/server/worktree"
	"github.com/sourcegraph/jsonrpc2"
)

var bgCtx = context.Background()

// dialTestClient dials with compression negotiated, so the suite runs over the
// connection production actually builds rather than one it never uses. It is
// not browser-shaped — this dialer offers a bare permessage-deflate — so the
// tests that turn on the browser's own offer hand-roll a client instead, in
// rpc_compression_test.go.
func dialTestClient(ctx context.Context, serverURL string) (*websocket.Conn, error) {
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(serverURL, "http"),
		&websocket.DialOptions{CompressionMode: clientCompression})
	return conn, err
}

func mockRegistry(ag agent.Agent) *agent.Registry {
	r := agent.NewRegistry()
	r.Register(session.AgentTypeClaude, ag)
	return r
}

type testEnv struct {
	t               *testing.T
	dataDir         string
	mock            *mockAgent
	worktreeManager *worktree.Manager
	workStore       work.Store
	testRoleID      string // pre-created agent role ID for tests
	handler         *RPCHandler
	server          *httptest.Server
	conn            *websocket.Conn
	ctx             context.Context
	cancel          context.CancelFunc
	reqID           int
	authResult      rpc.AuthResult
	// buffered holds frames read while waiting for a reply that had not arrived
	// yet. A notification can overtake the reply to the request that caused it,
	// so call() has to read past it — and dropping it would leave every later
	// readNotification one frame short, waiting for a frame already delivered.
	buffered [][]byte
}

func newTestEnv(t *testing.T, mock *mockAgent) *testEnv {
	return newTestEnvWithWorkDir(t, mock, t.TempDir())
}

func newTestEnvWithWorkDir(t *testing.T, mock *mockAgent, workDir string) *testEnv {
	return newTestEnvWithAgent(t, mock, mock, workDir)
}

// newForkableTestEnv registers an agent whose sessions can be forked. Forking is
// declared by implementing agent.SessionForker, so it takes a different type
// rather than a field on the plain mock; env.mock still reaches the same
// recording mock underneath.
func newForkableTestEnv(t *testing.T) *testEnv {
	mock := &mockAgent{}
	return newTestEnvWithAgent(t, mock, forkableMockAgent{mock}, t.TempDir())
}

// newTestEnvWithAgent registers ag for claude sessions. mock is the same agent in
// every case but the forkable one, where it is the mock ag records into.
func newTestEnvWithAgent(t *testing.T, mock *mockAgent, ag agent.Agent, workDir string) *testEnv {
	dataDir := t.TempDir()
	cmdStore, err := command.NewStore(dataDir)
	if err != nil {
		t.Fatalf("failed to create command store: %v", err)
	}
	settingsStore, err := settings.NewStore(dataDir)
	if err != nil {
		t.Fatalf("failed to create settings store: %v", err)
	}

	workStore, err := work.NewFileStore(dataDir)
	if err != nil {
		t.Fatalf("failed to create work store: %v", err)
	}

	agentRoleStore, err := agentrole.NewFileStore(dataDir)
	if err != nil {
		t.Fatalf("failed to create agent role store: %v", err)
	}

	// Create a default role for tests
	testRole, err := agentRoleStore.Create(context.Background(), agentrole.AgentRole{
		Name:       "Test Engineer",
		RolePrompt: "You are a test engineer.",
	})
	if err != nil {
		t.Fatalf("failed to create test agent role: %v", err)
	}

	registry := worktree.NewRegistry(workDir, dataDir)
	worktreeManager := worktree.NewManager(registry, mockRegistry(ag), dataDir, 10*time.Minute)
	workStarter := worktree.NewWorkStarter(worktreeManager, agentRoleStore, settingsStore)
	workStopper := worktree.NewWorkStopper(worktreeManager, workStore)
	workOps := work.NewOperations(workStore, workStarter, nil)

	h := NewRPCHandler("test-token", "test", true, cmdStore, worktreeManager, settingsStore, workStore, workOps, workStopper, agentRoleStore)
	server := httptest.NewServer(h)

	// One deadline covers every read and write the test makes, so it has to
	// outlast the whole test rather than any single exchange. It is here only so
	// a message that never arrives fails with a message instead of hanging until
	// the package timeout; sized to what a test does, it turned the suite flaky
	// whenever another package's git or process work loaded the machine.
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)

	conn, err := dialTestClient(ctx, server.URL)
	if err != nil {
		cancel()
		server.Close()
		t.Fatalf("failed to connect: %v", err)
	}

	env := &testEnv{
		t:               t,
		dataDir:         dataDir,
		mock:            mock,
		worktreeManager: worktreeManager,
		workStore:       workStore,
		testRoleID:      testRole.ID,
		handler:         h,
		server:          server,
		conn:            conn,
		ctx:             ctx,
		cancel:          cancel,
		reqID:           0,
	}

	// Authenticate
	resp := env.call("auth", rpc.AuthParams{Token: "test-token"})
	if resp.Error != nil {
		t.Fatalf("auth failed: %s", resp.Error.Message)
	}
	if err := json.Unmarshal(resp.Result, &env.authResult); err != nil {
		t.Fatalf("unmarshal auth result: %v", err)
	}

	t.Cleanup(func() {
		conn.Close(websocket.StatusNormalClosure, "")
		cancel()
		server.Close()
		worktreeManager.Shutdown()
	})

	return env
}

// getMainWorktree returns the main worktree for tests that need direct access to store/manager.
func (e *testEnv) getMainWorktree() *worktree.Worktree {
	wt, err := e.worktreeManager.Get("")
	if err != nil {
		e.t.Fatalf("failed to get main worktree: %v", err)
	}
	return wt
}

type rpcRequest struct {
	JSONRPC string      `json:"jsonrpc"`
	ID      int         `json:"id"`
	Method  string      `json:"method"`
	Params  interface{} `json:"params"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      int             `json:"id"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *jsonrpc2.Error `json:"error,omitempty"`
}

type rpcNotification struct {
	JSONRPC string          `json:"jsonrpc"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

func (e *testEnv) nextID() int {
	e.reqID++
	return e.reqID
}

func (e *testEnv) call(method string, params interface{}) rpcResponse {
	reqID := e.nextID()
	req := rpcRequest{
		JSONRPC: "2.0",
		ID:      reqID,
		Method:  method,
		Params:  params,
	}
	data, _ := json.Marshal(req)
	if err := e.conn.Write(e.ctx, websocket.MessageText, data); err != nil {
		e.t.Fatalf("failed to send: %v", err)
	}

	// Read frames until the reply with the matching ID. Anything read on the way
	// is a notification that overtook it, and is put back for the test to read.
	// Straight off the socket, never through readFrame: a frame already buffered
	// arrived before this request was even sent, so it can never be the reply, and
	// taking it here would only put it back and spin.
	for {
		_, respData, err := e.conn.Read(e.ctx)
		if err != nil {
			e.t.Fatalf("failed to read: %v", err)
		}

		var resp rpcResponse
		if err := json.Unmarshal(respData, &resp); err != nil {
			e.t.Fatalf("failed to unmarshal response: %v", err)
		}

		if resp.ID == reqID {
			return resp
		}
		e.buffered = append(e.buffered, respData)
	}
}

// readFrame returns the next frame the test has not seen yet, taking the ones
// call() read past before going back to the socket. Frames stay in arrival
// order: call() appends in the order it read them, and this drains from the front.
func (e *testEnv) readFrame() []byte {
	if len(e.buffered) > 0 {
		data := e.buffered[0]
		e.buffered = e.buffered[1:]
		return data
	}

	_, data, err := e.conn.Read(e.ctx)
	if err != nil {
		e.t.Fatalf("failed to read: %v", err)
	}
	return data
}

func (e *testEnv) readNotification() rpcNotification {
	data := e.readFrame()

	var notif rpcNotification
	if err := json.Unmarshal(data, &notif); err != nil {
		e.t.Fatalf("failed to unmarshal notification: %v", err)
	}
	return notif
}

func (e *testEnv) subscribeChatMessages(sessionID string) rpc.ChatMessagesSubscribeResult {
	return e.subscribeChatMessagesWithLimit(sessionID, 0)
}

func (e *testEnv) sendMessage(sessionID, content string) {
	resp := e.call("chat.message", rpc.MessageParams{SessionID: sessionID, Content: content})
	if resp.Error != nil {
		e.t.Fatalf("message failed: %s", resp.Error.Message)
	}
}

func (e *testEnv) skipN(n int) {
	for i := 0; i < n; i++ {
		e.readFrame()
	}
}

func TestHandler_Auth_InvalidToken(t *testing.T) {
	dataDir := t.TempDir()
	workDir := t.TempDir()
	cmdStore, _ := command.NewStore(dataDir)
	settingsStore, _ := settings.NewStore(dataDir)
	workStore, _ := work.NewFileStore(dataDir)
	registry := worktree.NewRegistry(workDir, dataDir)
	worktreeManager := worktree.NewManager(registry, mockRegistry(&mockAgent{}), dataDir, 10*time.Minute)
	defer worktreeManager.Shutdown()

	agentRoleStore, _ := agentrole.NewFileStore(dataDir)
	workStarter := worktree.NewWorkStarter(worktreeManager, agentRoleStore, settingsStore)
	workStopper := worktree.NewWorkStopper(worktreeManager, workStore)
	workOps := work.NewOperations(workStore, workStarter, nil)
	h := NewRPCHandler("secret-token", "test", true, cmdStore, worktreeManager, settingsStore, workStore, workOps, workStopper, agentRoleStore)
	server := httptest.NewServer(h)
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn, err := dialTestClient(ctx, server.URL)
	if err != nil {
		t.Fatalf("failed to connect: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	req := rpcRequest{JSONRPC: "2.0", ID: 1, Method: "auth", Params: rpc.AuthParams{Token: "wrong-token"}}
	data, _ := json.Marshal(req)
	if err := conn.Write(ctx, websocket.MessageText, data); err != nil {
		t.Fatalf("failed to send: %v", err)
	}

	_, respData, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("failed to read: %v", err)
	}

	var resp rpcResponse
	if err := json.Unmarshal(respData, &resp); err != nil {
		t.Fatalf("failed to unmarshal: %v", err)
	}

	if resp.Error == nil {
		t.Error("expected auth to fail")
	}
	if !strings.Contains(resp.Error.Message, "invalid token") {
		t.Errorf("expected 'invalid token' error, got %q", resp.Error.Message)
	}
}

func TestHandler_Auth_FirstMessageMustBeAuth(t *testing.T) {
	dataDir := t.TempDir()
	workDir := t.TempDir()
	cmdStore, _ := command.NewStore(dataDir)
	settingsStore, _ := settings.NewStore(dataDir)
	workStore, _ := work.NewFileStore(dataDir)
	registry := worktree.NewRegistry(workDir, dataDir)
	worktreeManager := worktree.NewManager(registry, mockRegistry(&mockAgent{}), dataDir, 10*time.Minute)
	defer worktreeManager.Shutdown()
	agentRoleStore, _ := agentrole.NewFileStore(dataDir)

	workStarter := worktree.NewWorkStarter(worktreeManager, agentRoleStore, settingsStore)
	workStopper := worktree.NewWorkStopper(worktreeManager, workStore)
	workOps := work.NewOperations(workStore, workStarter, nil)
	h := NewRPCHandler("test-token", "test", true, cmdStore, worktreeManager, settingsStore, workStore, workOps, workStopper, agentRoleStore)
	server := httptest.NewServer(h)
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn, err := dialTestClient(ctx, server.URL)
	if err != nil {
		t.Fatalf("failed to connect: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	req := rpcRequest{JSONRPC: "2.0", ID: 1, Method: "chat.messages.subscribe", Params: rpc.ChatMessagesSubscribeParams{SessionID: "sess"}}
	data, _ := json.Marshal(req)
	if err := conn.Write(ctx, websocket.MessageText, data); err != nil {
		t.Fatalf("failed to send: %v", err)
	}

	_, respData, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("failed to read: %v", err)
	}

	var resp rpcResponse
	if err := json.Unmarshal(respData, &resp); err != nil {
		t.Fatalf("failed to unmarshal: %v", err)
	}

	if resp.Error == nil {
		t.Error("expected auth to fail")
	}
	if !strings.Contains(resp.Error.Message, "first request must be auth") {
		t.Errorf("expected 'first request must be auth' error, got %q", resp.Error.Message)
	}
}

func TestHandler_ChatMessagesSubscribe(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	env.getMainWorktree().SessionStore.Create(bgCtx, "sess", "", "")

	result := env.subscribeChatMessages("sess")

	if result.State != "ended" {
		t.Errorf("expected state=ended before message, got %s", result.State)
	}
	if result.ID == "" {
		t.Error("expected subscription ID")
	}
}

func TestHandler_ChatMessagesSubscribe_ProcessState(t *testing.T) {
	mock := &mockAgent{
		events: []agent.AgentEvent{
			agent.TextEvent{Content: "Response"},
			agent.DoneEvent{},
		},
	}
	env := newTestEnv(t, mock)
	wt := env.getMainWorktree()
	wt.SessionStore.Create(bgCtx, "sess", "", "")

	// Start process by sending message
	env.subscribeChatMessages("sess")
	env.sendMessage("sess", "hello")
	env.skipN(2) // Text + Done notifications

	// Verify process is still running
	if !wt.ProcessManager.HasProcess("sess") {
		t.Fatal("expected process to be running")
	}

	// New subscribe should show state=idle (process alive, done with response)
	result := env.subscribeChatMessages("sess")
	if result.State != "idle" {
		t.Errorf("expected state=idle after message, got %s", result.State)
	}
}

func TestHandler_ChatMessagesSubscribe_InvalidSession(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	resp := env.call("chat.messages.subscribe", rpc.ChatMessagesSubscribeParams{SessionID: "non-existent"})

	if resp.Error == nil || !strings.Contains(resp.Error.Message, "session not found") {
		t.Errorf("expected session not found error, got %+v", resp)
	}
}

func TestHandler_WebSocketConnection(t *testing.T) {
	mock := &mockAgent{
		events: []agent.AgentEvent{
			agent.TextEvent{Content: "Hello"},
			agent.DoneEvent{},
		},
	}
	env := newTestEnv(t, mock)
	env.getMainWorktree().SessionStore.Create(bgCtx, "sess", "", "")

	env.subscribeChatMessages("sess")
	env.sendMessage("sess", "Hello AI")

	// Read notifications
	notif1 := env.readNotification()
	notif2 := env.readNotification()

	if notif1.Method != "chat.text" {
		t.Errorf("expected method 'chat.text', got %q", notif1.Method)
	}
	if notif2.Method != "chat.done" {
		t.Errorf("expected method 'chat.done', got %q", notif2.Method)
	}
}

func TestHandler_MultipleSessions(t *testing.T) {
	mock := &mockAgent{
		events: []agent.AgentEvent{
			agent.TextEvent{Content: "Response"},
			agent.DoneEvent{},
		},
	}
	env := newTestEnv(t, mock)
	store := env.getMainWorktree().SessionStore
	store.Create(bgCtx, "session-A", "", "")
	store.Create(bgCtx, "session-B", "", "")

	env.subscribeChatMessages("session-A")
	env.subscribeChatMessages("session-B")
	env.sendMessage("session-A", "Hello from A")
	env.skipN(2)
	env.sendMessage("session-B", "Hello from B")
	env.skipN(2)
	env.sendMessage("session-A", "Second from A")
	env.skipN(2)

	if len(mock.messagesBySession["session-A"]) != 2 {
		t.Errorf("expected 2 messages for session A, got %d", len(mock.messagesBySession["session-A"]))
	}
	if len(mock.messagesBySession["session-B"]) != 1 {
		t.Errorf("expected 1 message for session B, got %d", len(mock.messagesBySession["session-B"]))
	}
}

func TestHandler_PermissionRequest(t *testing.T) {
	mock := &mockAgent{
		events: []agent.AgentEvent{
			agent.PermissionRequestEvent{
				RequestID: "req-123",
				ToolName:  "Bash",
				ToolInput: []byte(`{"command":"ls"}`),
				ToolUseID: "toolu_perm",
			},
			agent.DoneEvent{},
		},
	}
	env := newTestEnv(t, mock)
	env.getMainWorktree().SessionStore.Create(bgCtx, "sess", "", "")

	env.subscribeChatMessages("sess")
	env.sendMessage("sess", "run ls")
	notif := env.readNotification()

	if notif.Method != "chat.permission_request" {
		t.Errorf("expected method 'chat.permission_request', got %q", notif.Method)
	}

	var params rpc.PermissionRequestParams
	if err := json.Unmarshal(notif.Params, &params); err != nil {
		t.Fatalf("failed to unmarshal params: %v", err)
	}

	if params.RequestID != "req-123" {
		t.Errorf("expected request_id 'req-123', got %q", params.RequestID)
	}
	if params.ToolName != "Bash" {
		t.Errorf("expected tool_name 'Bash', got %q", params.ToolName)
	}
}

func TestHandler_AgentStartError(t *testing.T) {
	mock := &mockAgent{
		startErr: fmt.Errorf("failed to start agent"),
	}
	env := newTestEnv(t, mock)
	env.getMainWorktree().SessionStore.Create(bgCtx, "sess", "", "")

	env.subscribeChatMessages("sess")
	resp := env.call("chat.message", rpc.MessageParams{SessionID: "sess", Content: "hello"})

	if resp.Error == nil || !strings.Contains(resp.Error.Message, "failed to start agent") {
		t.Errorf("expected agent start error, got %+v", resp)
	}
}

func TestHandler_Interrupt(t *testing.T) {
	mock := &mockAgent{
		events: []agent.AgentEvent{
			agent.TextEvent{Content: "Response"},
			agent.DoneEvent{},
		},
	}
	env := newTestEnv(t, mock)
	env.getMainWorktree().SessionStore.Create(bgCtx, "sess", "", "")

	env.subscribeChatMessages("sess")
	env.sendMessage("sess", "hello")
	env.skipN(2)

	sess := mock.sessions["sess"]
	if sess == nil {
		t.Fatal("session should exist")
	}

	resp := env.call("chat.interrupt", rpc.InterruptParams{SessionID: "sess"})
	if resp.Error != nil {
		t.Errorf("unexpected error: %s", resp.Error.Message)
	}

	select {
	case <-sess.interruptCh:
	case <-env.ctx.Done():
		t.Fatal("timeout waiting for interrupt")
	}
}

func TestHandler_Interrupt_InvalidSession(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	resp := env.call("chat.interrupt", rpc.InterruptParams{SessionID: "non-existent"})

	if resp.Error == nil || !strings.Contains(resp.Error.Message, "session not found") {
		t.Errorf("expected session not found error, got %+v", resp)
	}
}

func TestHandler_NewSession_ResumeFalse(t *testing.T) {
	mock := &mockAgent{
		events: []agent.AgentEvent{
			agent.TextEvent{Content: "Response"},
			agent.DoneEvent{},
		},
	}
	env := newTestEnv(t, mock)
	store := env.getMainWorktree().SessionStore
	store.Create(bgCtx, "new-session", "", "")

	env.subscribeChatMessages("new-session")
	env.sendMessage("new-session", "hello")
	env.skipN(2)

	if len(mock.startCalls) != 1 || mock.startCalls[0].resume {
		t.Errorf("expected resume=false, got %+v", mock.startCalls)
	}

	sess, _, _ := store.Get("new-session")
	if !sess.Activated {
		t.Error("expected session to be activated")
	}
}

// TestHandler_FailedFirstTurn_KeepsAgentTypeSwitchable covers the escape hatch a
// session needs when its very first turn fails before the agent says anything.
// Nothing was started, so the session must not be treated as started: the user
// can still move it to another agent instead of being stuck retrying the one
// whose login expired.
func TestHandler_FailedFirstTurn_KeepsAgentTypeSwitchable(t *testing.T) {
	mock := &mockAgent{
		// What Claude emits for a first message it cannot deliver, measured on
		// 2.1.259 against an endpoint answering 401: retry banners (system events),
		// the CLI's own account of the failure, then a result flagged as an error
		// (subtype "success", is_error set — the flag is what counts). The account
		// comes over the wire as an assistant message and only reaches this layer
		// as a warning because the Claude parser keeps synthetic messages off the
		// text path — read as agent output it would start the session and take the
		// escape hatch away in precisely this scenario.
		events: []agent.AgentEvent{
			agent.SystemEvent{Content: `{"subtype":"api_retry"}`},
			agent.WarningEvent{
				Message: "Invalid API key \u00b7 Fix external API key",
				Code:    "authentication_failed",
			},
			agent.ErrorEvent{Error: "Invalid API key \u00b7 Fix external API key"},
		},
	}
	env := newTestEnv(t, mock)
	store := env.getMainWorktree().SessionStore
	store.Create(bgCtx, "failed-session", session.AgentTypeClaude, "")

	env.subscribeChatMessages("failed-session")
	env.sendMessage("failed-session", "hello")
	env.skipN(4) // api_retry, warning, error, done

	sess, _, _ := store.Get("failed-session")
	if sess.Activated {
		t.Error("expected session to stay unactivated after a turn with no agent output")
	}

	resp := env.call("session.set_agent_type", rpc.SessionSetAgentTypeParams{
		SessionID: "failed-session",
		AgentType: session.AgentTypeCodex,
	})
	if resp.Error != nil {
		t.Errorf("expected agent type change to be allowed, got %s", resp.Error.Message)
	}

	// The failed turn's process can still be alive — Codex's mcp-server outlives
	// a turn it could not run. Reusing it would send the next message to the
	// agent the user just switched away from.
	if env.getMainWorktree().ProcessManager.HasProcess("failed-session") {
		t.Error("expected the old agent's process to be closed by the switch")
	}
}

// TestHandler_SessionWithAgentOutput_LocksAgentType is the other half: once the
// agent has actually produced output there is a conversation on the agent's side,
// and switching backends would silently abandon it.
func TestHandler_SessionWithAgentOutput_LocksAgentType(t *testing.T) {
	mock := &mockAgent{
		events: []agent.AgentEvent{
			agent.TextEvent{Content: "Response"},
			agent.DoneEvent{},
		},
	}
	env := newTestEnv(t, mock)
	store := env.getMainWorktree().SessionStore
	store.Create(bgCtx, "started-session", session.AgentTypeClaude, "")

	env.subscribeChatMessages("started-session")
	env.sendMessage("started-session", "hello")
	env.skipN(2) // text, done

	resp := env.call("session.set_agent_type", rpc.SessionSetAgentTypeParams{
		SessionID: "started-session",
		AgentType: session.AgentTypeCodex,
	})
	if resp.Error == nil || !strings.Contains(resp.Error.Message, "cannot change agent type after session has started") {
		t.Errorf("expected rejection for a session the agent has answered in, got %+v", resp)
	}
}

func TestHandler_ActivatedSession_ResumeTrue(t *testing.T) {
	mock := &mockAgent{
		events: []agent.AgentEvent{
			agent.TextEvent{Content: "Response"},
			agent.DoneEvent{},
		},
	}
	env := newTestEnv(t, mock)
	store := env.getMainWorktree().SessionStore
	store.Create(bgCtx, "activated-session", "", "")
	store.Activate(bgCtx, "activated-session")

	env.subscribeChatMessages("activated-session")
	env.sendMessage("activated-session", "hello")
	env.skipN(2)

	if len(mock.startCalls) != 1 || !mock.startCalls[0].resume {
		t.Errorf("expected resume=true, got %+v", mock.startCalls)
	}
}

func TestHandler_AskUserQuestion(t *testing.T) {
	mock := &mockAgent{
		events: []agent.AgentEvent{
			agent.AskUserQuestionEvent{
				RequestID: "req-q-123",
				ToolUseID: "toolu_q_123",
				Questions: []agent.AskUserQuestion{
					{
						Question:    "Which library?",
						Header:      "Library",
						Options:     []agent.QuestionOption{{Label: "A", Description: "Option A"}},
						MultiSelect: false,
					},
				},
			},
			agent.DoneEvent{},
		},
	}
	env := newTestEnv(t, mock)
	env.getMainWorktree().SessionStore.Create(bgCtx, "sess", "", "")

	env.subscribeChatMessages("sess")
	env.sendMessage("sess", "ask me")
	notif := env.readNotification()

	if notif.Method != "chat.ask_user_question" {
		t.Errorf("expected method 'chat.ask_user_question', got %q", notif.Method)
	}

	var params rpc.AskUserQuestionParams
	if err := json.Unmarshal(notif.Params, &params); err != nil {
		t.Fatalf("failed to unmarshal params: %v", err)
	}

	if params.RequestID != "req-q-123" {
		t.Errorf("expected request_id 'req-q-123', got %q", params.RequestID)
	}
	if len(params.Questions) != 1 {
		t.Errorf("expected 1 question, got %d", len(params.Questions))
	}
	if params.Questions[0].Question != "Which library?" {
		t.Errorf("expected question 'Which library?', got %q", params.Questions[0].Question)
	}
}

func TestHandler_UnknownMethod(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	resp := env.call("unknown_method", nil)

	if resp.Error == nil || !strings.Contains(resp.Error.Message, "method not found") {
		t.Errorf("expected method not found error, got %+v", resp)
	}
}

func TestHandler_Message_SessionNotInStore(t *testing.T) {
	mock := &mockAgent{}
	env := newTestEnv(t, mock)

	// Try to send message to non-existent session
	resp := env.call("chat.message", rpc.MessageParams{SessionID: "non-existent-session", Content: "hello"})

	if resp.Error == nil || !strings.Contains(resp.Error.Message, "session not found") {
		t.Errorf("expected session not found error, got %+v", resp)
	}
}

// Session management tests

func TestHandler_SessionListSubscribe(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	store := env.getMainWorktree().SessionStore
	store.Create(bgCtx, "session-1", "", "")
	store.Create(bgCtx, "session-2", "", "")

	resp := env.call("session.list.subscribe", nil)

	if resp.Error != nil {
		t.Errorf("unexpected error: %s", resp.Error.Message)
	}

	var result struct {
		ID       string                `json:"id"`
		Sessions []session.SessionMeta `json:"sessions"`
	}
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		t.Fatalf("failed to unmarshal result: %v", err)
	}

	if result.ID == "" {
		t.Error("expected non-empty subscription ID")
	}

	if len(result.Sessions) != 2 {
		t.Errorf("expected 2 sessions, got %d", len(result.Sessions))
	}
}

func TestHandler_SessionCreate(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	resp := env.call("session.create", nil)

	if resp.Error != nil {
		t.Errorf("unexpected error: %s", resp.Error.Message)
	}

	var result session.SessionMeta
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		t.Fatalf("failed to unmarshal result: %v", err)
	}

	if result.ID == "" {
		t.Error("expected non-empty session ID")
	}
	if result.Title != "New Chat" {
		t.Errorf("expected title 'New Chat', got %q", result.Title)
	}
	if result.Activated {
		t.Error("expected activated=false for new session")
	}
}

// A create that fails on disk (full disk, unwritable .pockode) used to reply
// with a bare "failed to create session" and log nothing, leaving the failure
// without a trace on either side of the connection.
func TestHandler_SessionCreate_ReportsUnderlyingCause(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root bypasses directory permissions")
	}

	env := newTestEnv(t, &mockAgent{})

	// A read-only sessions dir stands in for any I/O failure the store hits.
	sessionsDir := filepath.Join(env.dataDir, "sessions")
	if err := os.Chmod(sessionsDir, 0500); err != nil {
		t.Fatalf("chmod sessions dir: %v", err)
	}
	defer os.Chmod(sessionsDir, 0700) // let t.TempDir clean up

	resp := env.call("session.create", nil)

	if resp.Error == nil {
		t.Fatal("expected an error when the sessions dir is not writable")
	}
	if !strings.Contains(resp.Error.Message, "failed to create session") {
		t.Errorf("expected the message to say what failed, got %q", resp.Error.Message)
	}
	if !strings.Contains(resp.Error.Message, "permission denied") {
		t.Errorf("expected the message to carry the underlying cause, got %q", resp.Error.Message)
	}
}

func TestHandler_SessionDelete(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	store := env.getMainWorktree().SessionStore
	sess, _ := store.Create(bgCtx, "to-delete", "", "")

	resp := env.call("session.delete", rpc.SessionDeleteParams{SessionID: sess.ID})

	if resp.Error != nil {
		t.Errorf("unexpected error: %s", resp.Error.Message)
	}

	sessions, _ := store.List()
	if len(sessions) != 0 {
		t.Errorf("expected 0 sessions after delete, got %d", len(sessions))
	}
}

func TestHandler_SessionDelete_ClosesProcess(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	wt := env.getMainWorktree()
	sess, _ := wt.SessionStore.Create(bgCtx, "to-delete-with-process", "", "")
	env.sendMessage(sess.ID, "hello")

	if !wt.ProcessManager.HasProcess(sess.ID) {
		t.Fatal("expected process to be running after message")
	}

	resp := env.call("session.delete", rpc.SessionDeleteParams{SessionID: sess.ID})

	if resp.Error != nil {
		t.Errorf("unexpected error: %s", resp.Error.Message)
	}
	if wt.ProcessManager.HasProcess(sess.ID) {
		t.Error("expected process to be closed after session delete")
	}
}

func TestHandler_SessionUpdateTitle(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	store := env.getMainWorktree().SessionStore
	sess, _ := store.Create(bgCtx, "to-update", "", "")

	resp := env.call("session.update_title", rpc.SessionUpdateTitleParams{
		SessionID: sess.ID,
		Title:     "New Title",
	})

	if resp.Error != nil {
		t.Errorf("unexpected error: %s", resp.Error.Message)
	}

	updated, _, _ := store.Get(sess.ID)
	if updated.Title != "New Title" {
		t.Errorf("expected title 'New Title', got %q", updated.Title)
	}
}

func TestHandler_SessionUpdateTitle_EmptyTitle(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	sess, _ := env.getMainWorktree().SessionStore.Create(bgCtx, "to-update", "", "")

	resp := env.call("session.update_title", rpc.SessionUpdateTitleParams{
		SessionID: sess.ID,
		Title:     "",
	})

	if resp.Error == nil || !strings.Contains(resp.Error.Message, "title required") {
		t.Errorf("expected title required error, got %+v", resp)
	}
}

func TestHandler_SessionUpdateTitle_NotFound(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	resp := env.call("session.update_title", rpc.SessionUpdateTitleParams{
		SessionID: "non-existent",
		Title:     "Title",
	})

	if resp.Error == nil || !strings.Contains(resp.Error.Message, "session not found") {
		t.Errorf("expected session not found error, got %+v", resp)
	}
}

func TestHandler_SessionSetAgentType(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	store := env.getMainWorktree().SessionStore
	sess, _ := store.Create(bgCtx, "sess", session.AgentTypeClaude, "")

	resp := env.call("session.set_agent_type", rpc.SessionSetAgentTypeParams{
		SessionID: sess.ID,
		AgentType: session.AgentTypeCodex,
	})

	if resp.Error != nil {
		t.Errorf("unexpected error: %s", resp.Error.Message)
	}

	updated, _, _ := store.Get(sess.ID)
	if updated.AgentType != session.AgentTypeCodex {
		t.Errorf("expected agent type 'codex', got %q", updated.AgentType)
	}
}

func TestHandler_SessionSetAgentType_ActivatedSession(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	store := env.getMainWorktree().SessionStore
	store.Create(bgCtx, "activated", session.AgentTypeClaude, "")
	store.Activate(bgCtx, "activated")

	resp := env.call("session.set_agent_type", rpc.SessionSetAgentTypeParams{
		SessionID: "activated",
		AgentType: session.AgentTypeCodex,
	})

	if resp.Error == nil || !strings.Contains(resp.Error.Message, "cannot change agent type after session has started") {
		t.Errorf("expected rejection for activated session, got %+v", resp)
	}
}

func TestHandler_SessionSetAgentType_NotFound(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	resp := env.call("session.set_agent_type", rpc.SessionSetAgentTypeParams{
		SessionID: "non-existent",
		AgentType: session.AgentTypeClaude,
	})

	if resp.Error == nil || !strings.Contains(resp.Error.Message, "session not found") {
		t.Errorf("expected session not found error, got %+v", resp)
	}
}

// TestHandler_SessionFork covers the wiring: a fork asked for over the wire comes
// back as a session of its own, carrying the anchored conversation and pointing at
// the session it came from.
func TestHandler_SessionFork(t *testing.T) {
	env := newForkableTestEnv(t)
	store := env.getMainWorktree().SessionStore
	store.Create(bgCtx, "source", session.AgentTypeClaude, session.ModeYolo)
	store.Update(bgCtx, "source", "Fix the parser")
	anchor, _ := store.AppendToHistory(bgCtx, "source", map[string]string{"type": "message", "content": "keep me"})
	store.AppendToHistory(bgCtx, "source", map[string]string{"type": "text", "content": "drop me"})

	resp := env.call("session.fork", rpc.SessionForkParams{SessionID: "source", AnchorSeq: anchor})
	if resp.Error != nil {
		t.Fatalf("fork failed: %s", resp.Error.Message)
	}

	var forked rpc.SessionListItem
	if err := json.Unmarshal(resp.Result, &forked); err != nil {
		t.Fatalf("failed to unmarshal result: %v", err)
	}

	if forked.ID == "source" || forked.ID == "" {
		t.Fatalf("forked session ID = %q, want a new one", forked.ID)
	}
	if forked.Title != "Fix the parser" || forked.Mode != session.ModeYolo {
		t.Errorf("title/mode = %q/%q, want the source's", forked.Title, forked.Mode)
	}
	if forked.ForkedFrom == nil || forked.ForkedFrom.SessionID != "source" {
		t.Errorf("forkedFrom = %+v, want the source", forked.ForkedFrom)
	}

	history, err := store.GetHistory(bgCtx, forked.ID)
	if err != nil {
		t.Fatalf("GetHistory: %v", err)
	}
	// The anchored record, plus the warning that this agent brought no context with
	// it — the mock answers carried == false.
	if len(history) != 2 {
		t.Fatalf("forked history has %d records, want 2: %s", len(history), history)
	}
	if !strings.Contains(string(history[0]), "keep me") {
		t.Errorf("first record = %s, want the anchored one", history[0])
	}
}

// TestHandler_SessionFork_AnchorOutOfRange: the reply has to say what was wrong
// with the request, since the sheet shows the server's message to the user.
func TestHandler_SessionFork_AnchorOutOfRange(t *testing.T) {
	env := newForkableTestEnv(t)
	env.getMainWorktree().SessionStore.Create(bgCtx, "source", session.AgentTypeClaude, "")

	resp := env.call("session.fork", rpc.SessionForkParams{SessionID: "source", AnchorSeq: 7})

	if resp.Error == nil || !strings.Contains(resp.Error.Message, "outside the session's history") {
		t.Errorf("expected an out-of-range error, got %+v", resp)
	}
}

// TestHandler_SessionFork_AgentCannotFork: the method refuses a fork its agent
// cannot follow, with InvalidParams rather than an internal error — nothing
// failed, the request asked for something this agent does not do — and a message
// the sheet can show as-is.
func TestHandler_SessionFork_AgentCannotFork(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	store := env.getMainWorktree().SessionStore
	store.Create(bgCtx, "source", session.AgentTypeClaude, session.ModeYolo)
	anchor, _ := store.AppendToHistory(bgCtx, "source", map[string]string{"type": "message", "content": "keep me"})

	resp := env.call("session.fork", rpc.SessionForkParams{SessionID: "source", AnchorSeq: anchor})

	if resp.Error == nil || !strings.Contains(resp.Error.Message, "does not support forking") {
		t.Fatalf("expected a refusal naming the missing capability, got %+v", resp)
	}
	if resp.Error.Code != jsonrpc2.CodeInvalidParams {
		t.Errorf("error code = %d, want InvalidParams (%d)", resp.Error.Code, jsonrpc2.CodeInvalidParams)
	}

	sessions, err := store.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(sessions) != 1 {
		t.Errorf("sessions = %+v, want only the source", sessions)
	}
}

// TestHandler_AgentList: the frontend decides what to offer from this table, so
// every registered agent has to appear in it with a declaration it can read.
func TestHandler_AgentList(t *testing.T) {
	env := newForkableTestEnv(t)

	resp := env.call("agent.list", struct{}{})
	if resp.Error != nil {
		t.Fatalf("agent.list failed: %s", resp.Error.Message)
	}

	var result rpc.AgentListResult
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		t.Fatalf("failed to unmarshal result: %v", err)
	}
	if len(result.Agents) != 1 {
		t.Fatalf("agents = %+v, want the one registered agent", result.Agents)
	}
	if result.Agents[0].Type != session.AgentTypeClaude {
		t.Errorf("agent type = %q, want the registered one", result.Agents[0].Type)
	}
	if result.Agents[0].ForkSupport != agent.ForkFromAnyMessage {
		t.Errorf("forkSupport = %q, want the agent's own declaration", result.Agents[0].ForkSupport)
	}
}

func TestHandler_SessionSetModel(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	store := env.getMainWorktree().SessionStore
	sess, _ := store.Create(bgCtx, "sess", session.AgentTypeClaude, "")
	model := session.ModelsForAgent(session.AgentTypeClaude)[0].ID

	resp := env.call("session.set_model", rpc.SessionSetModelParams{
		SessionID: sess.ID,
		Model:     model,
	})

	if resp.Error != nil {
		t.Errorf("unexpected error: %s", resp.Error.Message)
	}

	updated, _, _ := store.Get(sess.ID)
	if updated.Model != model {
		t.Errorf("expected model %q, got %q", model, updated.Model)
	}
}

func TestHandler_SessionSetModel_ForeignAgentModel(t *testing.T) {
	// The lists are per agent; accepting another agent's model would only
	// surface later, as a CLI that refuses to start.
	env := newTestEnv(t, &mockAgent{})
	store := env.getMainWorktree().SessionStore
	sess, _ := store.Create(bgCtx, "sess", session.AgentTypeClaude, "")

	resp := env.call("session.set_model", rpc.SessionSetModelParams{
		SessionID: sess.ID,
		Model:     session.ModelsForAgent(session.AgentTypeCodex)[0].ID,
	})

	if resp.Error == nil || !strings.Contains(resp.Error.Message, "model not available") {
		t.Errorf("expected rejection of the other agent's model, got %+v", resp)
	}

	updated, _, _ := store.Get(sess.ID)
	if updated.Model != "" {
		t.Errorf("expected model to stay unset, got %q", updated.Model)
	}
}

// The whole reason set_model writes to the store before closing the process:
// a model the session's agent cannot run is an invalid request, and an invalid
// request must not cost the user the CLI they have running.
func TestHandler_SessionSetModel_RefusalSparesTheProcess(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	wt := env.getMainWorktree()
	sess, _ := wt.SessionStore.Create(bgCtx, "sess", session.AgentTypeClaude, "")
	env.sendMessage(sess.ID, "hello")

	if !wt.ProcessManager.HasProcess(sess.ID) {
		t.Fatal("expected process to be running after message")
	}

	resp := env.call("session.set_model", rpc.SessionSetModelParams{
		SessionID: sess.ID,
		Model:     session.ModelsForAgent(session.AgentTypeCodex)[0].ID,
	})

	if resp.Error == nil {
		t.Fatal("expected the other agent's model to be refused")
	}
	if !wt.ProcessManager.HasProcess(sess.ID) {
		t.Error("a refused model must not close the running process")
	}
}

// An accepted model does close it: the CLI is told which model to use only at
// launch, so the choice takes effect on the next one.
func TestHandler_SessionSetModel_ClosesProcess(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	wt := env.getMainWorktree()
	sess, _ := wt.SessionStore.Create(bgCtx, "sess", session.AgentTypeClaude, "")
	env.sendMessage(sess.ID, "hello")

	if !wt.ProcessManager.HasProcess(sess.ID) {
		t.Fatal("expected process to be running after message")
	}

	resp := env.call("session.set_model", rpc.SessionSetModelParams{
		SessionID: sess.ID,
		Model:     session.ModelsForAgent(session.AgentTypeClaude)[0].ID,
	})

	if resp.Error != nil {
		t.Fatalf("unexpected error: %s", resp.Error.Message)
	}
	if wt.ProcessManager.HasProcess(sess.ID) {
		t.Error("expected process to be closed so the next launch uses the new model")
	}
}

func TestHandler_SessionSetModel_NotFound(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	resp := env.call("session.set_model", rpc.SessionSetModelParams{
		SessionID: "non-existent",
		Model:     "",
	})

	if resp.Error == nil || !strings.Contains(resp.Error.Message, "session not found") {
		t.Errorf("expected session not found error, got %+v", resp)
	}
}

func TestHandler_SessionModels(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	resp := env.call("session.models", nil)

	if resp.Error != nil {
		t.Fatalf("unexpected error: %s", resp.Error.Message)
	}

	var result rpc.SessionModelsResult
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		t.Fatalf("failed to unmarshal result: %v", err)
	}

	for _, agentType := range []session.AgentType{session.AgentTypeClaude, session.AgentTypeCodex} {
		if len(result.Models[agentType]) == 0 {
			t.Errorf("expected models for %q", agentType)
		}
	}
}

func TestHandler_ChatMessagesSubscribe_History(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	store := env.getMainWorktree().SessionStore
	sess, _ := store.Create(bgCtx, "with-history", "", "")
	store.AppendToHistory(bgCtx, sess.ID, map[string]string{"type": "message", "content": "hello"})

	result := env.subscribeChatMessages(sess.ID)

	if len(result.History) != 1 {
		t.Errorf("expected 1 history record, got %d", len(result.History))
	}
}

// File/Git RPC tests

// newWorkDirTestEnv is a convenience wrapper for tests that need a specific workDir.
func newWorkDirTestEnv(t *testing.T, workDir string) *testEnv {
	return newTestEnvWithWorkDir(t, &mockAgent{}, workDir)
}

func TestHandler_FileGet_ListRootDir(t *testing.T) {
	workDir := t.TempDir()
	env := newWorkDirTestEnv(t, workDir)
	os.WriteFile(filepath.Join(workDir, "file.txt"), []byte("hello"), 0644)
	os.Mkdir(filepath.Join(workDir, "subdir"), 0755)

	resp := env.call("file.get", rpc.FileGetParams{Path: ""})

	if resp.Error != nil {
		t.Fatalf("unexpected error: %s", resp.Error.Message)
	}

	var result rpc.FileGetResult
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		t.Fatalf("failed to unmarshal result: %v", err)
	}

	if result.Type != "directory" {
		t.Errorf("expected type 'directory', got %q", result.Type)
	}
	if len(result.Entries) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(result.Entries))
	}
	if result.Entries[0].Name != "subdir" {
		t.Errorf("expected first entry 'subdir', got %q", result.Entries[0].Name)
	}
	if result.Entries[1].Name != "file.txt" {
		t.Errorf("expected second entry 'file.txt', got %q", result.Entries[1].Name)
	}
}

func TestHandler_FileGet_ListSubDir(t *testing.T) {
	workDir := t.TempDir()
	env := newWorkDirTestEnv(t, workDir)
	os.MkdirAll(filepath.Join(workDir, "src"), 0755)
	os.WriteFile(filepath.Join(workDir, "src", "main.go"), []byte("package main"), 0644)

	resp := env.call("file.get", rpc.FileGetParams{Path: "src"})

	if resp.Error != nil {
		t.Fatalf("unexpected error: %s", resp.Error.Message)
	}

	var result rpc.FileGetResult
	json.Unmarshal(resp.Result, &result)

	if result.Type != "directory" {
		t.Errorf("expected type 'directory', got %q", result.Type)
	}
	if len(result.Entries) != 1 || result.Entries[0].Name != "main.go" {
		t.Errorf("expected main.go, got %+v", result.Entries)
	}
}

func TestHandler_FileGet_ReadFile(t *testing.T) {
	workDir := t.TempDir()
	env := newWorkDirTestEnv(t, workDir)
	os.WriteFile(filepath.Join(workDir, "hello.txt"), []byte("world"), 0644)

	resp := env.call("file.get", rpc.FileGetParams{Path: "hello.txt"})

	if resp.Error != nil {
		t.Fatalf("unexpected error: %s", resp.Error.Message)
	}

	var result rpc.FileGetResult
	json.Unmarshal(resp.Result, &result)

	if result.Type != "file" {
		t.Errorf("expected type 'file', got %q", result.Type)
	}
	if result.File == nil {
		t.Fatal("expected file content")
	}
	if result.File.Content != "world" {
		t.Errorf("expected content 'world', got %q", result.File.Content)
	}
	if result.File.Size != 5 || result.File.MIME == "" {
		t.Errorf("expected size and mime, got size %d mime %q", result.File.Size, result.File.MIME)
	}
}

func TestHandler_FileGet_BinaryFileReturnsMetadataOnly(t *testing.T) {
	workDir := t.TempDir()
	env := newWorkDirTestEnv(t, workDir)
	os.WriteFile(filepath.Join(workDir, "app.wasm"), []byte("\x00asm\x01\x00\x00\x00"), 0644)

	resp := env.call("file.get", rpc.FileGetParams{Path: "app.wasm"})

	if resp.Error != nil {
		t.Fatalf("unexpected error: %s", resp.Error.Message)
	}

	var result rpc.FileGetResult
	json.Unmarshal(resp.Result, &result)

	if result.File == nil {
		t.Fatal("expected file metadata")
	}
	if result.File.Encoding != contents.EncodingNone || result.File.Omitted != contents.OmitBinary {
		t.Errorf("got encoding %q omitted %q, want %q/%q",
			result.File.Encoding, result.File.Omitted, contents.EncodingNone, contents.OmitBinary)
	}
	if result.File.Content != "" {
		t.Errorf("expected no content, got %q", result.File.Content)
	}
	if result.File.MIME != "application/wasm" {
		t.Errorf("got mime %q, want application/wasm", result.File.MIME)
	}
}

func TestHandler_FileGet_NotFound(t *testing.T) {
	env := newWorkDirTestEnv(t, t.TempDir())

	resp := env.call("file.get", rpc.FileGetParams{Path: "nonexistent.txt"})

	if resp.Error == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(resp.Error.Message, "not found") {
		t.Errorf("expected 'not found' error, got %q", resp.Error.Message)
	}
}

func TestHandler_FileGet_InvalidPath(t *testing.T) {
	env := newWorkDirTestEnv(t, t.TempDir())

	resp := env.call("file.get", rpc.FileGetParams{Path: "../etc/passwd"})

	if resp.Error == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(resp.Error.Message, "invalid path") {
		t.Errorf("expected 'invalid path' error, got %q", resp.Error.Message)
	}
}

func TestHandler_FileWrite(t *testing.T) {
	workDir := t.TempDir()
	env := newWorkDirTestEnv(t, workDir)
	testFile := filepath.Join(workDir, "test.txt")
	os.WriteFile(testFile, []byte("original"), 0644)

	resp := env.call("file.write", rpc.FileWriteParams{Path: "test.txt", Content: "updated"})

	if resp.Error != nil {
		t.Fatalf("unexpected error: %s", resp.Error.Message)
	}

	content, _ := os.ReadFile(testFile)
	if string(content) != "updated" {
		t.Errorf("expected 'updated', got %q", string(content))
	}
}

func TestHandler_FileWrite_CreatesNewFile(t *testing.T) {
	workDir := t.TempDir()
	env := newWorkDirTestEnv(t, workDir)

	resp := env.call("file.write", rpc.FileWriteParams{Path: "newfile.txt", Content: "new content"})

	if resp.Error != nil {
		t.Fatalf("unexpected error: %v", resp.Error)
	}

	content, err := os.ReadFile(filepath.Join(workDir, "newfile.txt"))
	if err != nil {
		t.Fatalf("failed to read created file: %v", err)
	}
	if string(content) != "new content" {
		t.Errorf("expected 'new content', got %q", string(content))
	}
}

func TestHandler_FileWrite_InvalidPath(t *testing.T) {
	env := newWorkDirTestEnv(t, t.TempDir())

	resp := env.call("file.write", rpc.FileWriteParams{Path: "../etc/passwd", Content: "test"})

	if resp.Error == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(resp.Error.Message, "invalid path") {
		t.Errorf("expected 'invalid path' error, got %q", resp.Error.Message)
	}
}

func TestHandler_FileCreate(t *testing.T) {
	workDir := t.TempDir()
	env := newWorkDirTestEnv(t, workDir)

	if resp := env.call("file.create", rpc.FileCreateParams{Path: "docs/notes.md", Type: contents.TypeFile}); resp.Error != nil {
		t.Fatalf("unexpected error: %s", resp.Error.Message)
	}
	if resp := env.call("file.create", rpc.FileCreateParams{Path: "pkg", Type: contents.TypeDir}); resp.Error != nil {
		t.Fatalf("unexpected error: %s", resp.Error.Message)
	}

	info, err := os.Stat(filepath.Join(workDir, "docs/notes.md"))
	if err != nil {
		t.Fatalf("failed to stat created file: %v", err)
	}
	if info.IsDir() {
		t.Error("expected docs/notes.md to be a file")
	}

	info, err = os.Stat(filepath.Join(workDir, "pkg"))
	if err != nil {
		t.Fatalf("failed to stat created directory: %v", err)
	}
	if !info.IsDir() {
		t.Error("expected pkg to be a directory")
	}
}

func TestHandler_FileCreate_Exists(t *testing.T) {
	workDir := t.TempDir()
	env := newWorkDirTestEnv(t, workDir)
	os.WriteFile(filepath.Join(workDir, "taken.txt"), []byte("content"), 0644)

	resp := env.call("file.create", rpc.FileCreateParams{Path: "taken.txt", Type: contents.TypeFile})

	if resp.Error == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(resp.Error.Message, "already exists") {
		t.Errorf("expected 'already exists' error, got %q", resp.Error.Message)
	}
}

func TestHandler_FileCreate_InvalidPath(t *testing.T) {
	env := newWorkDirTestEnv(t, t.TempDir())

	resp := env.call("file.create", rpc.FileCreateParams{Path: "../escape", Type: contents.TypeDir})

	if resp.Error == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(resp.Error.Message, "invalid path") {
		t.Errorf("expected 'invalid path' error, got %q", resp.Error.Message)
	}
}

func TestHandler_FileCreate_InvalidType(t *testing.T) {
	workDir := t.TempDir()
	env := newWorkDirTestEnv(t, workDir)

	resp := env.call("file.create", rpc.FileCreateParams{Path: "thing", Type: "symlink"})

	if resp.Error == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(resp.Error.Message, "type must be") {
		t.Errorf("expected type error, got %q", resp.Error.Message)
	}
	if _, err := os.Stat(filepath.Join(workDir, "thing")); !os.IsNotExist(err) {
		t.Error("expected nothing to be created")
	}
}

func TestHandler_FileDelete(t *testing.T) {
	workDir := t.TempDir()
	env := newWorkDirTestEnv(t, workDir)
	testFile := filepath.Join(workDir, "test.txt")
	os.WriteFile(testFile, []byte("content"), 0644)

	resp := env.call("file.delete", rpc.FileDeleteParams{Path: "test.txt"})

	if resp.Error != nil {
		t.Fatalf("unexpected error: %s", resp.Error.Message)
	}

	if _, err := os.Stat(testFile); !os.IsNotExist(err) {
		t.Error("expected file to be deleted")
	}
}

func TestHandler_FileDelete_NotFound(t *testing.T) {
	env := newWorkDirTestEnv(t, t.TempDir())

	resp := env.call("file.delete", rpc.FileDeleteParams{Path: "nonexistent.txt"})

	if resp.Error == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(resp.Error.Message, "not found") {
		t.Errorf("expected 'not found' error, got %q", resp.Error.Message)
	}
}

func TestHandler_FileDelete_InvalidPath(t *testing.T) {
	env := newWorkDirTestEnv(t, t.TempDir())

	resp := env.call("file.delete", rpc.FileDeleteParams{Path: "../etc/passwd"})

	if resp.Error == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(resp.Error.Message, "invalid path") {
		t.Errorf("expected 'invalid path' error, got %q", resp.Error.Message)
	}
}

func TestHandler_FileDelete_Directory(t *testing.T) {
	workDir := t.TempDir()
	env := newWorkDirTestEnv(t, workDir)
	subdir := filepath.Join(workDir, "subdir")
	os.Mkdir(subdir, 0755)
	os.WriteFile(filepath.Join(subdir, "file.txt"), []byte("content"), 0644)

	resp := env.call("file.delete", rpc.FileDeleteParams{Path: "subdir"})

	if resp.Error != nil {
		t.Fatalf("unexpected error: %v", resp.Error)
	}
	if _, err := os.Stat(subdir); !os.IsNotExist(err) {
		t.Error("directory should be deleted")
	}
}

// Git RPC tests

func setupGitRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	runGitIn(t, dir, "init")
	runGitIn(t, dir, "config", "user.email", "test@test.com")
	runGitIn(t, dir, "config", "user.name", "Test")
	runGitIn(t, dir, "config", "commit.gpgsign", "false")
	return dir
}

func runGitIn(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v failed: %v\n%s", args, err, out)
	}
}

func TestHandler_GitStatus_Empty(t *testing.T) {
	dir := setupGitRepo(t)
	env := newWorkDirTestEnv(t, dir)

	resp := env.call("git.status", nil)

	if resp.Error != nil {
		t.Fatalf("unexpected error: %s", resp.Error.Message)
	}

	var result rpc.GitStatusResult
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		t.Fatalf("failed to unmarshal: %v", err)
	}

	if len(result.Staged) != 0 || len(result.Unstaged) != 0 {
		t.Errorf("expected empty status, got staged=%d unstaged=%d", len(result.Staged), len(result.Unstaged))
	}
}

func TestHandler_GitStatus_UntrackedFile(t *testing.T) {
	dir := setupGitRepo(t)
	os.WriteFile(filepath.Join(dir, "test.txt"), []byte("hello"), 0644)
	env := newWorkDirTestEnv(t, dir)

	resp := env.call("git.status", nil)

	if resp.Error != nil {
		t.Fatalf("unexpected error: %s", resp.Error.Message)
	}

	var result rpc.GitStatusResult
	json.Unmarshal(resp.Result, &result)

	if len(result.Unstaged) != 1 {
		t.Fatalf("expected 1 unstaged file, got %d", len(result.Unstaged))
	}
	if result.Unstaged[0].Path != "test.txt" {
		t.Errorf("expected 'test.txt', got %q", result.Unstaged[0].Path)
	}
}

func TestHandler_GitDiffSubscribe_Unstaged(t *testing.T) {
	dir := setupGitRepo(t)

	// Create and commit a file
	testFile := filepath.Join(dir, "test.txt")
	os.WriteFile(testFile, []byte("original"), 0644)
	runGitIn(t, dir, "add", "test.txt")
	runGitIn(t, dir, "commit", "-m", "initial")

	// Modify the file (unstaged change)
	os.WriteFile(testFile, []byte("modified"), 0644)

	env := newWorkDirTestEnv(t, dir)
	resp := env.call("git.diff.subscribe", rpc.GitDiffSubscribeParams{Path: "test.txt", Staged: false})

	if resp.Error != nil {
		t.Fatalf("unexpected error: %s", resp.Error.Message)
	}

	var result rpc.GitDiffSubscribeResult
	json.Unmarshal(resp.Result, &result)

	if result.ID == "" {
		t.Error("expected subscription ID")
	}
	if result.OldContent != "original" {
		t.Errorf("expected old content 'original', got %q", result.OldContent)
	}
	if result.NewContent != "modified" {
		t.Errorf("expected new content 'modified', got %q", result.NewContent)
	}
}

func TestHandler_GitDiffSubscribe_Staged(t *testing.T) {
	dir := setupGitRepo(t)

	// Create and commit a file
	testFile := filepath.Join(dir, "test.txt")
	os.WriteFile(testFile, []byte("original"), 0644)
	runGitIn(t, dir, "add", "test.txt")
	runGitIn(t, dir, "commit", "-m", "initial")

	// Stage a change
	os.WriteFile(testFile, []byte("staged change"), 0644)
	runGitIn(t, dir, "add", "test.txt")

	env := newWorkDirTestEnv(t, dir)
	resp := env.call("git.diff.subscribe", rpc.GitDiffSubscribeParams{Path: "test.txt", Staged: true})

	if resp.Error != nil {
		t.Fatalf("unexpected error: %s", resp.Error.Message)
	}

	var result rpc.GitDiffSubscribeResult
	json.Unmarshal(resp.Result, &result)

	if result.ID == "" {
		t.Error("expected subscription ID")
	}
	if result.OldContent != "original" {
		t.Errorf("expected old content 'original', got %q", result.OldContent)
	}
	if result.NewContent != "staged change" {
		t.Errorf("expected new content 'staged change', got %q", result.NewContent)
	}
}

func TestHandler_GitDiffSubscribe_PathRequired(t *testing.T) {
	dir := setupGitRepo(t)
	env := newWorkDirTestEnv(t, dir)

	resp := env.call("git.diff.subscribe", rpc.GitDiffSubscribeParams{Path: "", Staged: false})

	if resp.Error == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(resp.Error.Message, "path required") {
		t.Errorf("expected 'path required' error, got %q", resp.Error.Message)
	}
}

func TestHandler_GitDiffSubscribe_InvalidPath(t *testing.T) {
	dir := setupGitRepo(t)
	env := newWorkDirTestEnv(t, dir)

	resp := env.call("git.diff.subscribe", rpc.GitDiffSubscribeParams{Path: "../etc/passwd", Staged: false})

	if resp.Error == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(resp.Error.Message, "invalid path") {
		t.Errorf("expected 'invalid path' error, got %q", resp.Error.Message)
	}
}

// Worktree RPC tests
// Unit tests for worktree logic are in worktree/registry_test.go.
// These integration tests verify RPC layer behavior only.

func TestHandler_WorktreeList(t *testing.T) {
	t.Run("non-git repo returns main only", func(t *testing.T) {
		env := newTestEnv(t, &mockAgent{})

		resp := env.call("worktree.list", nil)
		if resp.Error != nil {
			t.Fatalf("unexpected error: %s", resp.Error.Message)
		}

		var result rpc.WorktreeListResult
		json.Unmarshal(resp.Result, &result)

		if len(result.Worktrees) != 1 || !result.Worktrees[0].IsMain {
			t.Errorf("expected single main worktree, got %+v", result.Worktrees)
		}
	})

	t.Run("git repo includes main", func(t *testing.T) {
		dir := setupGitRepo(t)
		env := newWorkDirTestEnv(t, dir)

		resp := env.call("worktree.list", nil)
		if resp.Error != nil {
			t.Fatalf("unexpected error: %s", resp.Error.Message)
		}

		var result rpc.WorktreeListResult
		json.Unmarshal(resp.Result, &result)

		var hasMain bool
		for _, wt := range result.Worktrees {
			if wt.IsMain {
				hasMain = true
				break
			}
		}
		if !hasMain {
			t.Error("expected main worktree in list")
		}
	})
}

func TestHandler_WorktreeCreate_Validation(t *testing.T) {
	dir := setupGitRepo(t)
	env := newWorkDirTestEnv(t, dir)

	resp := env.call("worktree.create", rpc.WorktreeCreateParams{Name: "", Branch: "branch"})
	if resp.Error == nil || !strings.Contains(resp.Error.Message, "name required") {
		t.Errorf("expected 'name required' error, got %+v", resp)
	}

	resp = env.call("worktree.create", rpc.WorktreeCreateParams{Name: "test", Branch: ""})
	if resp.Error == nil || !strings.Contains(resp.Error.Message, "branch required") {
		t.Errorf("expected 'branch required' error, got %+v", resp)
	}
}

func TestHandler_WorktreeCreateAndDelete_E2E(t *testing.T) {
	dir := setupGitRepo(t)
	os.WriteFile(filepath.Join(dir, "README.md"), []byte("# Test"), 0644)
	runGitIn(t, dir, "add", ".")
	runGitIn(t, dir, "commit", "-m", "initial")

	env := newWorkDirTestEnv(t, dir)

	// Create
	createResp := env.call("worktree.create", rpc.WorktreeCreateParams{
		Name:   "feature",
		Branch: "feature-branch",
	})
	if createResp.Error != nil {
		t.Fatalf("create failed: %s", createResp.Error.Message)
	}

	var createResult rpc.WorktreeCreateResult
	json.Unmarshal(createResp.Result, &createResult)
	if createResult.Worktree.Name != "feature" {
		t.Errorf("expected name 'feature', got %q", createResult.Worktree.Name)
	}

	// Verify in list
	listResp := env.call("worktree.list", nil)
	var listResult rpc.WorktreeListResult
	json.Unmarshal(listResp.Result, &listResult)

	var found bool
	for _, wt := range listResult.Worktrees {
		if wt.Name == "feature" {
			found = true
			break
		}
	}
	if !found {
		t.Error("created worktree not found in list")
	}

	// Delete
	deleteResp := env.call("worktree.delete", rpc.WorktreeDeleteParams{Name: "feature"})
	if deleteResp.Error != nil {
		t.Fatalf("delete failed: %s", deleteResp.Error.Message)
	}

	// Verify removed from list
	listResp = env.call("worktree.list", nil)
	json.Unmarshal(listResp.Result, &listResult)
	for _, wt := range listResult.Worktrees {
		if wt.Name == "feature" {
			t.Error("deleted worktree still in list")
		}
	}
}

func TestHandler_WorktreeSwitch(t *testing.T) {
	dir := setupGitRepo(t)
	os.WriteFile(filepath.Join(dir, "README.md"), []byte("# Test"), 0644)
	runGitIn(t, dir, "add", ".")
	runGitIn(t, dir, "commit", "-m", "initial")

	env := newWorkDirTestEnv(t, dir)

	// Create a worktree to switch to
	createResp := env.call("worktree.create", rpc.WorktreeCreateParams{
		Name:   "feature",
		Branch: "feature-branch",
	})
	if createResp.Error != nil {
		t.Fatalf("create failed: %s", createResp.Error.Message)
	}

	// Switch to the new worktree
	switchResp := env.call("worktree.switch", rpc.WorktreeSwitchParams{Name: "feature"})
	if switchResp.Error != nil {
		t.Fatalf("switch failed: %s", switchResp.Error.Message)
	}

	var switchResult rpc.WorktreeSwitchResult
	json.Unmarshal(switchResp.Result, &switchResult)

	if switchResult.WorktreeName != "feature" {
		t.Errorf("expected worktree_name 'feature', got %q", switchResult.WorktreeName)
	}
	if !strings.Contains(switchResult.WorkDir, "feature") {
		t.Errorf("expected work_dir to contain 'feature', got %q", switchResult.WorkDir)
	}

	// Switch back to main (empty name)
	switchResp = env.call("worktree.switch", rpc.WorktreeSwitchParams{Name: ""})
	if switchResp.Error != nil {
		t.Fatalf("switch to main failed: %s", switchResp.Error.Message)
	}

	json.Unmarshal(switchResp.Result, &switchResult)
	if switchResult.WorktreeName != "" {
		t.Errorf("expected empty worktree_name for main, got %q", switchResult.WorktreeName)
	}
}

func TestHandler_WorktreeSwitch_SameWorktree(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	// Switch to main (already on main) - should be no-op
	resp := env.call("worktree.switch", rpc.WorktreeSwitchParams{Name: ""})
	if resp.Error != nil {
		t.Fatalf("unexpected error: %s", resp.Error.Message)
	}

	var result rpc.WorktreeSwitchResult
	json.Unmarshal(resp.Result, &result)

	// Should return current worktree info without error
	if result.WorkDir == "" {
		t.Error("expected non-empty work_dir")
	}
}

func TestHandler_WorktreeSwitch_NotFound(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	resp := env.call("worktree.switch", rpc.WorktreeSwitchParams{Name: "nonexistent"})

	if resp.Error == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(resp.Error.Message, "worktree not found") {
		t.Errorf("expected 'worktree not found' error, got %q", resp.Error.Message)
	}
}

func TestHandler_MissingParams(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	// Send request without params field
	data := []byte(`{"jsonrpc":"2.0","id":999,"method":"session.delete"}`)
	if err := env.conn.Write(env.ctx, websocket.MessageText, data); err != nil {
		t.Fatalf("failed to send: %v", err)
	}

	_, respData, err := env.conn.Read(env.ctx)
	if err != nil {
		t.Fatalf("failed to read: %v", err)
	}

	var resp rpcResponse
	json.Unmarshal(respData, &resp)

	if resp.Error == nil {
		t.Fatal("expected error for missing params")
	}
	if !strings.Contains(resp.Error.Message, "invalid params") {
		t.Errorf("expected 'invalid params' error, got %q", resp.Error.Message)
	}
}

// effortOnlyOnCodex returns an effort level codex offers and claude does not.
func effortOnlyOnCodex(t *testing.T) string {
	t.Helper()
	for _, e := range session.EffortsForAgent(session.AgentTypeCodex) {
		if !session.IsValidEffort(session.AgentTypeClaude, e.ID) {
			return e.ID
		}
	}
	t.Skip("codex offers no effort level claude lacks")
	return ""
}

func TestHandler_SessionSetEffort(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	store := env.getMainWorktree().SessionStore
	sess, _ := store.Create(bgCtx, "sess", session.AgentTypeClaude, "")
	effort := session.EffortsForAgent(session.AgentTypeClaude)[0].ID

	resp := env.call("session.set_effort", rpc.SessionSetEffortParams{
		SessionID: sess.ID,
		Effort:    effort,
	})

	if resp.Error != nil {
		t.Errorf("unexpected error: %s", resp.Error.Message)
	}

	updated, _, _ := store.Get(sess.ID)
	if updated.Effort != effort {
		t.Errorf("expected effort %q, got %q", effort, updated.Effort)
	}
}

func TestHandler_SessionSetEffort_ForeignAgentEffort(t *testing.T) {
	// The lists are per agent; a level the CLI does not accept would be ignored
	// with nothing but a warning nobody reads, so it is refused here.
	env := newTestEnv(t, &mockAgent{})
	store := env.getMainWorktree().SessionStore
	sess, _ := store.Create(bgCtx, "sess", session.AgentTypeClaude, "")

	resp := env.call("session.set_effort", rpc.SessionSetEffortParams{
		SessionID: sess.ID,
		Effort:    effortOnlyOnCodex(t),
	})

	if resp.Error == nil || !strings.Contains(resp.Error.Message, "effort not available") {
		t.Errorf("expected rejection of the other agent's effort, got %+v", resp)
	}

	updated, _, _ := store.Get(sess.ID)
	if updated.Effort != "" {
		t.Errorf("expected effort to stay unset, got %q", updated.Effort)
	}
}

// As with set_model: an invalid request must not cost the user the CLI they
// have running, and an accepted one must, since the level is read at launch.
func TestHandler_SessionSetEffort_ProcessLifetime(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	wt := env.getMainWorktree()
	sess, _ := wt.SessionStore.Create(bgCtx, "sess", session.AgentTypeClaude, "")
	env.sendMessage(sess.ID, "hello")

	if !wt.ProcessManager.HasProcess(sess.ID) {
		t.Fatal("expected process to be running after message")
	}

	resp := env.call("session.set_effort", rpc.SessionSetEffortParams{
		SessionID: sess.ID,
		Effort:    effortOnlyOnCodex(t),
	})
	if resp.Error == nil {
		t.Fatal("expected the other agent's effort to be refused")
	}
	if !wt.ProcessManager.HasProcess(sess.ID) {
		t.Error("a refused effort must not close the running process")
	}

	resp = env.call("session.set_effort", rpc.SessionSetEffortParams{
		SessionID: sess.ID,
		Effort:    session.EffortsForAgent(session.AgentTypeClaude)[0].ID,
	})
	if resp.Error != nil {
		t.Fatalf("unexpected error: %s", resp.Error.Message)
	}
	if wt.ProcessManager.HasProcess(sess.ID) {
		t.Error("expected process to be closed so the next launch uses the new effort")
	}
}

func TestHandler_SessionSetEffort_NotFound(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	resp := env.call("session.set_effort", rpc.SessionSetEffortParams{
		SessionID: "non-existent",
		Effort:    "",
	})

	if resp.Error == nil || !strings.Contains(resp.Error.Message, "session not found") {
		t.Errorf("expected session not found error, got %+v", resp)
	}
}

func TestHandler_SessionEfforts(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	resp := env.call("session.efforts", nil)

	if resp.Error != nil {
		t.Fatalf("unexpected error: %s", resp.Error.Message)
	}

	var result rpc.SessionEffortsResult
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		t.Fatalf("failed to unmarshal result: %v", err)
	}

	for _, agentType := range []session.AgentType{session.AgentTypeClaude, session.AgentTypeCodex} {
		if len(result.Efforts[agentType]) == 0 {
			t.Errorf("expected efforts for %q", agentType)
		}
	}
}
