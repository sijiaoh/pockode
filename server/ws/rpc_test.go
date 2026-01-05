package ws

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/pockode/server/agent"
	"github.com/pockode/server/process"
	"github.com/pockode/server/rpc"
	"github.com/pockode/server/session"
	"github.com/sourcegraph/jsonrpc2"
)

var bgCtx = context.Background()

type testEnv struct {
	t       *testing.T
	mock    *mockAgent
	store   *session.FileStore
	manager *process.Manager
	server  *httptest.Server
	conn    *websocket.Conn
	ctx     context.Context
	cancel  context.CancelFunc
	reqID   int
}

func newTestEnv(t *testing.T, mock *mockAgent) *testEnv {
	store, err := session.NewFileStore(t.TempDir())
	if err != nil {
		t.Fatalf("failed to create store: %v", err)
	}

	manager := process.NewManager(mock, "/tmp", store, 10*time.Minute)
	h := NewRPCHandler("test-token", manager, true, store)
	server := httptest.NewServer(h)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")
	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		cancel()
		server.Close()
		t.Fatalf("failed to connect: %v", err)
	}

	env := &testEnv{
		t:       t,
		mock:    mock,
		store:   store,
		manager: manager,
		server:  server,
		conn:    conn,
		ctx:     ctx,
		cancel:  cancel,
		reqID:   0,
	}

	// Authenticate
	resp := env.call("auth", rpc.AuthParams{Token: "test-token"})
	if resp.Error != nil {
		t.Fatalf("auth failed: %s", resp.Error.Message)
	}

	t.Cleanup(func() {
		conn.Close(websocket.StatusNormalClosure, "")
		cancel()
		server.Close()
		manager.Shutdown()
	})

	return env
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
	req := rpcRequest{
		JSONRPC: "2.0",
		ID:      e.nextID(),
		Method:  method,
		Params:  params,
	}
	data, _ := json.Marshal(req)
	if err := e.conn.Write(e.ctx, websocket.MessageText, data); err != nil {
		e.t.Fatalf("failed to send: %v", err)
	}

	_, respData, err := e.conn.Read(e.ctx)
	if err != nil {
		e.t.Fatalf("failed to read: %v", err)
	}

	var resp rpcResponse
	if err := json.Unmarshal(respData, &resp); err != nil {
		e.t.Fatalf("failed to unmarshal response: %v", err)
	}
	return resp
}

func (e *testEnv) readNotification() rpcNotification {
	_, data, err := e.conn.Read(e.ctx)
	if err != nil {
		e.t.Fatalf("failed to read: %v", err)
	}

	var notif rpcNotification
	if err := json.Unmarshal(data, &notif); err != nil {
		e.t.Fatalf("failed to unmarshal notification: %v", err)
	}
	return notif
}

func (e *testEnv) attach(sessionID string) {
	resp := e.call("chat.attach", rpc.AttachParams{SessionID: sessionID})
	if resp.Error != nil {
		e.t.Fatalf("attach failed: %s", resp.Error.Message)
	}
}

func (e *testEnv) sendMessage(sessionID, content string) {
	resp := e.call("chat.message", rpc.MessageParams{SessionID: sessionID, Content: content})
	if resp.Error != nil {
		e.t.Fatalf("message failed: %s", resp.Error.Message)
	}
}

func (e *testEnv) skipN(n int) {
	for i := 0; i < n; i++ {
		if _, _, err := e.conn.Read(e.ctx); err != nil {
			e.t.Fatalf("failed to skip response %d: %v", i, err)
		}
	}
}

func TestHandler_Auth_InvalidToken(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	manager := process.NewManager(&mockAgent{}, "/tmp", store, 10*time.Minute)
	defer manager.Shutdown()

	h := NewRPCHandler("secret-token", manager, true, store)
	server := httptest.NewServer(h)
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")
	conn, _, err := websocket.Dial(ctx, wsURL, nil)
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
	store, _ := session.NewFileStore(t.TempDir())
	manager := process.NewManager(&mockAgent{}, "/tmp", store, 10*time.Minute)
	defer manager.Shutdown()

	h := NewRPCHandler("test-token", manager, true, store)
	server := httptest.NewServer(h)
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")
	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("failed to connect: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	req := rpcRequest{JSONRPC: "2.0", ID: 1, Method: "attach", Params: rpc.AttachParams{SessionID: "sess"}}
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

func TestHandler_Attach(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	env.store.Create(bgCtx, "sess")

	resp := env.call("chat.attach", rpc.AttachParams{SessionID: "sess"})

	if resp.Error != nil {
		t.Errorf("unexpected error: %s", resp.Error.Message)
	}

	var result rpc.AttachResult
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		t.Fatalf("failed to unmarshal result: %v", err)
	}

	if result.ProcessRunning {
		t.Error("expected process_running=false before message")
	}
}

func TestHandler_Attach_ProcessRunning(t *testing.T) {
	mock := &mockAgent{
		events: []agent.AgentEvent{
			agent.TextEvent{Content: "Response"},
			agent.DoneEvent{},
		},
	}
	env := newTestEnv(t, mock)
	env.store.Create(bgCtx, "sess")

	// Start process by sending message
	env.attach("sess")
	env.sendMessage("sess", "hello")
	env.skipN(2) // Text + Done notifications

	// Verify process is still running
	if !env.manager.HasProcess("sess") {
		t.Fatal("expected process to be running")
	}

	// New attach should show process_running=true
	resp := env.call("chat.attach", rpc.AttachParams{SessionID: "sess"})
	if resp.Error != nil {
		t.Fatalf("unexpected error: %s", resp.Error.Message)
	}

	var result rpc.AttachResult
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		t.Fatalf("failed to unmarshal result: %v", err)
	}

	if !result.ProcessRunning {
		t.Error("expected process_running=true after message")
	}
}

func TestHandler_Attach_InvalidSession(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	resp := env.call("chat.attach", rpc.AttachParams{SessionID: "non-existent"})

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
	env.store.Create(bgCtx, "sess")

	env.attach("sess")
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
	env.store.Create(bgCtx, "session-A")
	env.store.Create(bgCtx, "session-B")

	env.attach("session-A")
	env.attach("session-B")
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
	env.store.Create(bgCtx, "sess")

	env.attach("sess")
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
	env.store.Create(bgCtx, "sess")

	env.attach("sess")
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
	env.store.Create(bgCtx, "sess")

	env.attach("sess")
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
	env.store.Create(bgCtx, "new-session")

	env.attach("new-session")
	env.sendMessage("new-session", "hello")
	env.skipN(2)

	if len(mock.startCalls) != 1 || mock.startCalls[0].resume {
		t.Errorf("expected resume=false, got %+v", mock.startCalls)
	}

	sess, _, _ := env.store.Get("new-session")
	if !sess.Activated {
		t.Error("expected session to be activated")
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
	env.store.Create(bgCtx, "activated-session")
	env.store.Activate(bgCtx, "activated-session")

	env.attach("activated-session")
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
	env.store.Create(bgCtx, "sess")

	env.attach("sess")
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
