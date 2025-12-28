package ws

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/pockode/server/agent"
	"github.com/pockode/server/session"
)

type testEnv struct {
	t      *testing.T
	mock   *mockAgent
	store  *session.FileStore
	server *httptest.Server
	conn   *websocket.Conn
	ctx    context.Context
	cancel context.CancelFunc
}

func newTestEnv(t *testing.T, mock *mockAgent) *testEnv {
	store, err := session.NewFileStore(t.TempDir())
	if err != nil {
		t.Fatalf("failed to create store: %v", err)
	}

	h := NewHandler("test-token", mock, "/tmp", true, store)
	server := httptest.NewServer(h)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http") + "?token=test-token"
	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		cancel()
		server.Close()
		t.Fatalf("failed to connect: %v", err)
	}

	t.Cleanup(func() {
		conn.Close(websocket.StatusNormalClosure, "")
		cancel()
		server.Close()
	})

	return &testEnv{
		t:      t,
		mock:   mock,
		store:  store,
		server: server,
		conn:   conn,
		ctx:    ctx,
		cancel: cancel,
	}
}

func (e *testEnv) send(msg ClientMessage) {
	data, _ := json.Marshal(msg)
	if err := e.conn.Write(e.ctx, websocket.MessageText, data); err != nil {
		e.t.Fatalf("failed to send: %v", err)
	}
}

func (e *testEnv) sendMessage(sessionID, content string) {
	e.send(ClientMessage{Type: "message", SessionID: sessionID, Content: content})
}

func (e *testEnv) read() ServerMessage {
	_, data, err := e.conn.Read(e.ctx)
	if err != nil {
		e.t.Fatalf("failed to read: %v", err)
	}
	var msg ServerMessage
	if err := json.Unmarshal(data, &msg); err != nil {
		e.t.Fatalf("failed to unmarshal: %v", err)
	}
	return msg
}

func (e *testEnv) readN(n int) []ServerMessage {
	msgs := make([]ServerMessage, n)
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

func TestHandler_MissingToken(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	h := NewHandler("secret-token", &mockAgent{}, "/tmp", true, store)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/ws", nil))

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expected status %d, got %d", http.StatusUnauthorized, rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "Missing token") {
		t.Errorf("expected 'Missing token' in body, got %q", rec.Body.String())
	}
}

func TestHandler_InvalidToken(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	h := NewHandler("secret-token", &mockAgent{}, "/tmp", true, store)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/ws?token=wrong-token", nil))

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expected status %d, got %d", http.StatusUnauthorized, rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "Invalid token") {
		t.Errorf("expected 'Invalid token' in body, got %q", rec.Body.String())
	}
}

func TestHandler_WebSocketConnection(t *testing.T) {
	mock := &mockAgent{
		events: []agent.AgentEvent{
			{Type: agent.EventTypeText, Content: "Hello"},
			{Type: agent.EventTypeDone},
		},
	}
	env := newTestEnv(t, mock)
	env.store.Create("sess")

	env.sendMessage("sess", "Hello AI")
	responses := env.readN(2)

	if responses[0].Type != "text" || responses[0].Content != "Hello" {
		t.Errorf("unexpected first response: %+v", responses[0])
	}
	if responses[1].Type != "done" {
		t.Errorf("unexpected second response: %+v", responses[1])
	}
}

func TestHandler_MultipleMessages(t *testing.T) {
	mock := &mockAgent{
		events: []agent.AgentEvent{
			{Type: agent.EventTypeText, Content: "Response"},
			{Type: agent.EventTypeDone},
		},
	}
	env := newTestEnv(t, mock)
	env.store.Create("sess")

	env.sendMessage("sess", "First message")
	env.skipN(2)
	env.sendMessage("sess", "Second message")
	env.skipN(2)

	if len(mock.messages) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(mock.messages))
	}
	if mock.messages[0] != "First message" || mock.messages[1] != "Second message" {
		t.Errorf("unexpected messages: %v", mock.messages)
	}
}

func TestHandler_MultipleSessions(t *testing.T) {
	mock := &mockAgent{
		events: []agent.AgentEvent{
			{Type: agent.EventTypeText, Content: "Response"},
			{Type: agent.EventTypeDone},
		},
	}
	env := newTestEnv(t, mock)
	env.store.Create("session-A")
	env.store.Create("session-B")

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
			{
				Type:      agent.EventTypePermissionRequest,
				RequestID: "req-123",
				ToolName:  "Bash",
				ToolInput: []byte(`{"command":"ls"}`),
			},
			{Type: agent.EventTypeDone},
		},
	}
	env := newTestEnv(t, mock)
	env.store.Create("sess")

	env.sendMessage("sess", "run ls")
	resp := env.read()

	if resp.Type != "permission_request" {
		t.Errorf("expected permission_request, got %s", resp.Type)
	}
	if resp.RequestID != "req-123" {
		t.Errorf("expected request_id 'req-123', got %q", resp.RequestID)
	}
	if resp.ToolName != "Bash" {
		t.Errorf("expected tool_name 'Bash', got %q", resp.ToolName)
	}
}

func TestHandler_PermissionResponse_InvalidSession(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	env.send(ClientMessage{
		Type:      "permission_response",
		SessionID: "non-existent",
		RequestID: "req-123",
		Choice:    "allow",
	})
	resp := env.read()

	if resp.Type != "error" || !strings.Contains(resp.Error, "session not found") {
		t.Errorf("expected session not found error, got %+v", resp)
	}
}

func TestHandler_PermissionResponse_InvalidRequestID(t *testing.T) {
	mock := &mockAgent{
		events: []agent.AgentEvent{
			{Type: agent.EventTypeText, Content: "Hello"},
			{Type: agent.EventTypeDone},
		},
	}
	env := newTestEnv(t, mock)
	env.store.Create("sess")

	env.sendMessage("sess", "hello")
	env.skipN(2)

	env.send(ClientMessage{
		Type:      "permission_response",
		SessionID: "sess",
		RequestID: "non-existent-request",
		Choice:    "allow",
	})
	resp := env.read()

	if resp.Type != "error" || !strings.Contains(resp.Error, "no pending request") {
		t.Errorf("expected no pending request error, got %+v", resp)
	}
}

func TestHandler_PermissionResponse_Duplicate(t *testing.T) {
	mock := &mockAgent{
		events: []agent.AgentEvent{
			{Type: agent.EventTypePermissionRequest, RequestID: "req-dup"},
			{Type: agent.EventTypeDone},
		},
	}
	env := newTestEnv(t, mock)
	env.store.Create("sess")

	env.sendMessage("sess", "test")
	env.skipN(2)

	permResp := ClientMessage{Type: "permission_response", SessionID: "sess", RequestID: "req-dup", Choice: "allow"}
	env.send(permResp)
	env.send(permResp)
	resp := env.read()

	if resp.Type != "error" || !strings.Contains(resp.Error, "no pending request") {
		t.Errorf("expected no pending request error for duplicate, got %+v", resp)
	}
}

func TestHandler_AgentStartError(t *testing.T) {
	mock := &mockAgent{
		startErr: fmt.Errorf("failed to start agent"),
	}
	env := newTestEnv(t, mock)
	env.store.Create("sess")

	env.sendMessage("sess", "hello")
	resp := env.read()

	if resp.Type != "error" || !strings.Contains(resp.Error, "failed to start agent") {
		t.Errorf("expected agent start error, got %+v", resp)
	}
}

func TestHandler_Interrupt(t *testing.T) {
	mock := &mockAgent{
		events: []agent.AgentEvent{
			{Type: agent.EventTypeText, Content: "Response"},
			{Type: agent.EventTypeDone},
		},
	}
	env := newTestEnv(t, mock)
	env.store.Create("sess")

	env.sendMessage("sess", "hello")
	env.skipN(2)

	sess := mock.sessions["sess"]
	if sess == nil {
		t.Fatal("session should exist")
	}

	env.send(ClientMessage{Type: "interrupt", SessionID: "sess"})

	select {
	case <-sess.interruptCh:
	case <-env.ctx.Done():
		t.Fatal("timeout waiting for interrupt")
	}
}

func TestHandler_Interrupt_InvalidSession(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	env.send(ClientMessage{Type: "interrupt", SessionID: "non-existent"})
	resp := env.read()

	if resp.Type != "error" || !strings.Contains(resp.Error, "session not found") {
		t.Errorf("expected session not found error, got %+v", resp)
	}
}

func TestHandler_NewSession_ResumeFalse(t *testing.T) {
	mock := &mockAgent{
		events: []agent.AgentEvent{
			{Type: agent.EventTypeText, Content: "Response"},
			{Type: agent.EventTypeDone},
		},
	}
	env := newTestEnv(t, mock)
	env.store.Create("new-session")

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
			{Type: agent.EventTypeText, Content: "Response"},
			{Type: agent.EventTypeDone},
		},
	}
	env := newTestEnv(t, mock)
	env.store.Create("activated-session")
	env.store.Activate("activated-session")

	env.sendMessage("activated-session", "hello")
	env.skipN(2)

	if len(mock.startCalls) != 1 || !mock.startCalls[0].resume {
		t.Errorf("expected resume=true, got %+v", mock.startCalls)
	}
}

func TestHandler_AskUserQuestion(t *testing.T) {
	mock := &mockAgent{
		events: []agent.AgentEvent{
			{
				Type:      agent.EventTypeAskUserQuestion,
				RequestID: "req-q-123",
				Questions: []agent.AskUserQuestion{
					{
						Question:    "Which library?",
						Header:      "Library",
						Options:     []agent.QuestionOption{{Label: "A", Description: "Option A"}},
						MultiSelect: false,
					},
				},
			},
			{Type: agent.EventTypeDone},
		},
	}
	env := newTestEnv(t, mock)
	env.store.Create("sess")

	env.sendMessage("sess", "ask me")
	resp := env.read()

	if resp.Type != "ask_user_question" {
		t.Errorf("expected ask_user_question, got %s", resp.Type)
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

func TestHandler_QuestionResponse_InvalidSession(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	env.send(ClientMessage{
		Type:      "question_response",
		SessionID: "non-existent",
		RequestID: "req-123",
		Answers:   map[string]string{"q": "a"},
	})
	resp := env.read()

	if resp.Type != "error" || !strings.Contains(resp.Error, "session not found") {
		t.Errorf("expected session not found error, got %+v", resp)
	}
}

func TestHandler_QuestionResponse_InvalidRequestID(t *testing.T) {
	mock := &mockAgent{
		events: []agent.AgentEvent{
			{Type: agent.EventTypeText, Content: "Hello"},
			{Type: agent.EventTypeDone},
		},
	}
	env := newTestEnv(t, mock)
	env.store.Create("sess")

	env.sendMessage("sess", "hello")
	env.skipN(2)

	env.send(ClientMessage{
		Type:      "question_response",
		SessionID: "sess",
		RequestID: "non-existent-request",
		Answers:   map[string]string{"q": "a"},
	})
	resp := env.read()

	if resp.Type != "error" || !strings.Contains(resp.Error, "no pending request") {
		t.Errorf("expected no pending request error, got %+v", resp)
	}
}
