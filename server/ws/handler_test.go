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
	"github.com/pockode/server/session"
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
}

func newTestEnv(t *testing.T, mock *mockAgent) *testEnv {
	store, err := session.NewFileStore(t.TempDir())
	if err != nil {
		t.Fatalf("failed to create store: %v", err)
	}

	manager := process.NewManager(mock, "/tmp", store, 10*time.Minute)
	h := NewHandler("test-token", manager, true, store)
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
	}

	env.send(ClientMessage{Type: ClientMessageAuth, Token: "test-token"})
	resp := env.read()
	if resp.Type != ServerMessageAuthResponse {
		t.Fatalf("expected %s, got %s", ServerMessageAuthResponse, resp.Type)
	}
	if !resp.Success {
		t.Fatalf("auth failed: %s", resp.Error)
	}

	t.Cleanup(func() {
		conn.Close(websocket.StatusNormalClosure, "")
		cancel()
		server.Close()
		manager.Shutdown()
	})

	return env
}

func (e *testEnv) send(msg ClientMessage) {
	data, _ := json.Marshal(msg)
	if err := e.conn.Write(e.ctx, websocket.MessageText, data); err != nil {
		e.t.Fatalf("failed to send: %v", err)
	}
}

func (e *testEnv) attach(sessionID string) {
	e.send(ClientMessage{Type: ClientMessageAttach, SessionID: sessionID})
	e.read() // consume attach_response
}

func (e *testEnv) sendMessage(sessionID, content string) {
	e.send(ClientMessage{Type: ClientMessageMessage, SessionID: sessionID, Content: content})
}

func (e *testEnv) read() agent.ServerMessage {
	_, data, err := e.conn.Read(e.ctx)
	if err != nil {
		e.t.Fatalf("failed to read: %v", err)
	}
	var msg agent.ServerMessage
	if err := json.Unmarshal(data, &msg); err != nil {
		e.t.Fatalf("failed to unmarshal: %v", err)
	}
	return msg
}

func (e *testEnv) readN(n int) []agent.ServerMessage {
	msgs := make([]agent.ServerMessage, n)
	for i := 0; i < n; i++ {
		msgs[i] = e.read()
	}
	return msgs
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

	h := NewHandler("secret-token", manager, true, store)
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

	data, _ := json.Marshal(ClientMessage{Type: ClientMessageAuth, Token: "wrong-token"})
	if err := conn.Write(ctx, websocket.MessageText, data); err != nil {
		t.Fatalf("failed to send: %v", err)
	}

	_, respData, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("failed to read: %v", err)
	}

	var resp agent.ServerMessage
	if err := json.Unmarshal(respData, &resp); err != nil {
		t.Fatalf("failed to unmarshal: %v", err)
	}

	if resp.Type != ServerMessageAuthResponse {
		t.Errorf("expected %s, got %s", ServerMessageAuthResponse, resp.Type)
	}
	if resp.Success {
		t.Error("expected auth to fail")
	}
	if !strings.Contains(resp.Error, "Invalid token") {
		t.Errorf("expected 'Invalid token' error, got %q", resp.Error)
	}
}

func TestHandler_Auth_FirstMessageMustBeAuth(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	manager := process.NewManager(&mockAgent{}, "/tmp", store, 10*time.Minute)
	defer manager.Shutdown()

	h := NewHandler("test-token", manager, true, store)
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

	data, _ := json.Marshal(ClientMessage{Type: ClientMessageAttach, SessionID: "sess"})
	if err := conn.Write(ctx, websocket.MessageText, data); err != nil {
		t.Fatalf("failed to send: %v", err)
	}

	_, respData, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("failed to read: %v", err)
	}

	var resp agent.ServerMessage
	if err := json.Unmarshal(respData, &resp); err != nil {
		t.Fatalf("failed to unmarshal: %v", err)
	}

	if resp.Type != ServerMessageAuthResponse {
		t.Errorf("expected %s, got %s", ServerMessageAuthResponse, resp.Type)
	}
	if resp.Success {
		t.Error("expected auth to fail")
	}
	if !strings.Contains(resp.Error, "First message must be auth") {
		t.Errorf("expected 'First message must be auth' error, got %q", resp.Error)
	}
}

func TestHandler_Attach(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	env.store.Create(bgCtx, "sess")

	env.send(ClientMessage{Type: ClientMessageAttach, SessionID: "sess"})
	resp := env.read()

	if resp.Type != ServerMessageAttachResponse {
		t.Errorf("expected %s, got %s", ServerMessageAttachResponse, resp.Type)
	}
	if resp.SessionID != "sess" {
		t.Errorf("expected session_id 'sess', got %q", resp.SessionID)
	}
	if resp.ProcessRunning {
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
	env.skipN(2) // Text + Done

	// Verify process is still running
	if !env.manager.HasProcess("sess") {
		t.Fatal("expected process to be running")
	}

	// New attach should show process_running=true
	env.send(ClientMessage{Type: ClientMessageAttach, SessionID: "sess"})
	resp := env.read()

	if resp.Type != ServerMessageAttachResponse {
		t.Fatalf("expected %s, got %s", ServerMessageAttachResponse, resp.Type)
	}
	if !resp.ProcessRunning {
		t.Error("expected process_running=true after message")
	}
}

func TestHandler_Attach_InvalidSession(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	env.send(ClientMessage{Type: ClientMessageAttach, SessionID: "non-existent"})
	resp := env.read()

	if resp.Type != agent.EventTypeError || !strings.Contains(resp.Error, "session not found") {
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
	responses := env.readN(2)

	if responses[0].Type != agent.EventTypeText || responses[0].Content != "Hello" {
		t.Errorf("unexpected first response: %+v", responses[0])
	}
	if responses[1].Type != agent.EventTypeDone {
		t.Errorf("unexpected second response: %+v", responses[1])
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
	resp := env.read()

	if resp.Type != agent.EventTypePermissionRequest {
		t.Errorf("expected %s, got %s", agent.EventTypePermissionRequest, resp.Type)
	}
	if resp.RequestID != "req-123" {
		t.Errorf("expected request_id 'req-123', got %q", resp.RequestID)
	}
	if resp.ToolName != "Bash" {
		t.Errorf("expected tool_name 'Bash', got %q", resp.ToolName)
	}
}

func TestHandler_AgentStartError(t *testing.T) {
	mock := &mockAgent{
		startErr: fmt.Errorf("failed to start agent"),
	}
	env := newTestEnv(t, mock)
	env.store.Create(bgCtx, "sess")

	env.sendMessage("sess", "hello")
	resp := env.read()

	if resp.Type != agent.EventTypeError || !strings.Contains(resp.Error, "failed to start agent") {
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

	env.send(ClientMessage{Type: ClientMessageInterrupt, SessionID: "sess"})

	select {
	case <-sess.interruptCh:
	case <-env.ctx.Done():
		t.Fatal("timeout waiting for interrupt")
	}
}

func TestHandler_Interrupt_InvalidSession(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	env.send(ClientMessage{Type: ClientMessageInterrupt, SessionID: "non-existent"})
	resp := env.read()

	if resp.Type != agent.EventTypeError || !strings.Contains(resp.Error, "session not found") {
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
	resp := env.read()

	if resp.Type != agent.EventTypeAskUserQuestion {
		t.Errorf("expected %s, got %s", agent.EventTypeAskUserQuestion, resp.Type)
	}
	if resp.RequestID != "req-q-123" {
		t.Errorf("expected request_id 'req-q-123', got %q", resp.RequestID)
	}
	if len(resp.Questions) != 1 {
		t.Errorf("expected 1 question, got %d", len(resp.Questions))
	}
	if resp.Questions[0].Question != "Which library?" {
		t.Errorf("expected question 'Which library?', got %q", resp.Questions[0].Question)
	}
}

func TestHandler_InvalidJSON(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	if err := env.conn.Write(env.ctx, websocket.MessageText, []byte("{invalid json")); err != nil {
		t.Fatalf("failed to send: %v", err)
	}
	resp := env.read()

	if resp.Type != agent.EventTypeError || !strings.Contains(resp.Error, "Invalid message format") {
		t.Errorf("expected invalid format error, got %+v", resp)
	}
}

func TestHandler_UnknownMessageType(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	env.send(ClientMessage{Type: "unknown_type", SessionID: "sess"})
	resp := env.read()

	if resp.Type != agent.EventTypeError || !strings.Contains(resp.Error, "Unknown message type") {
		t.Errorf("expected unknown message type error, got %+v", resp)
	}
}

func TestHandler_Message_SessionNotInStore(t *testing.T) {
	mock := &mockAgent{}
	env := newTestEnv(t, mock)

	env.sendMessage("non-existent-session", "hello")
	resp := env.read()

	if resp.Type != agent.EventTypeError || !strings.Contains(resp.Error, "session not found") {
		t.Errorf("expected session not found error, got %+v", resp)
	}
}
