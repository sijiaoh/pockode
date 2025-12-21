package ws

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/pockode/server/agent"
)

// mockSession implements agent.Session for testing.
type mockSession struct {
	events          chan agent.AgentEvent
	messageQueue    chan string
	pendingRequests *sync.Map
	ctx             context.Context
	closed          bool
	closeMu         sync.Mutex
}

func (s *mockSession) Events() <-chan agent.AgentEvent {
	return s.events
}

func (s *mockSession) SendMessage(prompt string) error {
	select {
	case s.messageQueue <- prompt:
		return nil
	case <-s.ctx.Done():
		return s.ctx.Err()
	}
}

func (s *mockSession) SendPermissionResponse(requestID string, allow bool) error {
	_, ok := s.pendingRequests.LoadAndDelete(requestID)
	if !ok {
		return fmt.Errorf("no pending request for id: %s", requestID)
	}
	return nil
}

func (s *mockSession) Close() {
	s.closeMu.Lock()
	defer s.closeMu.Unlock()
	if s.closed {
		return
	}
	s.closed = true
	close(s.messageQueue)
}

// mockAgent implements agent.Agent for testing.
type mockAgent struct {
	events    []agent.AgentEvent // events to send for each message
	startErr  error              // error to return from Start
	sessionID string             // session ID to return

	mu                sync.Mutex
	messages          []string            // record of all messages sent
	messagesBySession map[string][]string // messages grouped by sessionID
}

func (m *mockAgent) Start(ctx context.Context, workDir string, sessionID string) (agent.Session, error) {
	if m.startErr != nil {
		return nil, m.startErr
	}

	eventsChan := make(chan agent.AgentEvent, 100)
	messageQueue := make(chan string, 10)
	pendingRequests := &sync.Map{}

	effectiveSessionID := sessionID
	if effectiveSessionID == "" {
		effectiveSessionID = m.sessionID
	}
	if effectiveSessionID == "" {
		effectiveSessionID = "mock-session-default"
	}

	sess := &mockSession{
		events:          eventsChan,
		messageQueue:    messageQueue,
		pendingRequests: pendingRequests,
		ctx:             ctx,
	}

	go func() {
		defer close(eventsChan)

		for {
			select {
			case prompt, ok := <-messageQueue:
				if !ok {
					return
				}

				m.mu.Lock()
				m.messages = append(m.messages, prompt)
				if m.messagesBySession == nil {
					m.messagesBySession = make(map[string][]string)
				}
				m.messagesBySession[effectiveSessionID] = append(m.messagesBySession[effectiveSessionID], prompt)
				m.mu.Unlock()

				select {
				case eventsChan <- agent.AgentEvent{Type: agent.EventTypeSession, SessionID: effectiveSessionID}:
				case <-ctx.Done():
					return
				}

				for _, event := range m.events {
					if event.Type == agent.EventTypePermissionRequest {
						pendingRequests.Store(event.RequestID, true)
					}
					select {
					case eventsChan <- event:
					case <-ctx.Done():
						return
					}
				}

				hasDone := false
				for _, e := range m.events {
					if e.Type == agent.EventTypeDone {
						hasDone = true
						break
					}
				}
				if !hasDone {
					select {
					case eventsChan <- agent.AgentEvent{Type: agent.EventTypeDone}:
					case <-ctx.Done():
						return
					}
				}

			case <-ctx.Done():
				return
			}
		}
	}()

	return sess, nil
}

func (m *mockAgent) getMessages() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	result := make([]string, len(m.messages))
	copy(result, m.messages)
	return result
}

func (m *mockAgent) getMessagesBySession(sessionID string) []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	msgs := m.messagesBySession[sessionID]
	result := make([]string, len(msgs))
	copy(result, msgs)
	return result
}

func TestHandler_MissingToken(t *testing.T) {
	h := NewHandler("secret-token", &mockAgent{}, "/tmp", true)

	req := httptest.NewRequest(http.MethodGet, "/ws", nil)
	rec := httptest.NewRecorder()

	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expected status %d, got %d", http.StatusUnauthorized, rec.Code)
	}

	if !strings.Contains(rec.Body.String(), "Missing token") {
		t.Errorf("expected 'Missing token' in body, got %q", rec.Body.String())
	}
}

func TestHandler_InvalidToken(t *testing.T) {
	h := NewHandler("secret-token", &mockAgent{}, "/tmp", true)

	req := httptest.NewRequest(http.MethodGet, "/ws?token=wrong-token", nil)
	rec := httptest.NewRecorder()

	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expected status %d, got %d", http.StatusUnauthorized, rec.Code)
	}

	if !strings.Contains(rec.Body.String(), "Invalid token") {
		t.Errorf("expected 'Invalid token' in body, got %q", rec.Body.String())
	}
}

func TestHandler_WebSocketConnection(t *testing.T) {
	events := []agent.AgentEvent{
		{Type: agent.EventTypeText, Content: "Hello"},
		{Type: agent.EventTypeDone},
	}
	h := NewHandler("test-token", &mockAgent{events: events}, "/tmp", true)

	server := httptest.NewServer(h)
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http") + "?token=test-token"

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("failed to connect: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	msg := ClientMessage{
		Type:    "message",
		ID:      "test-123",
		Content: "Hello AI",
	}
	msgData, _ := json.Marshal(msg)
	if err := conn.Write(ctx, websocket.MessageText, msgData); err != nil {
		t.Fatalf("failed to write: %v", err)
	}

	var responses []ServerMessage
	for i := 0; i < 3; i++ {
		_, data, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("failed to read response %d: %v", i, err)
		}
		var resp ServerMessage
		if err := json.Unmarshal(data, &resp); err != nil {
			t.Fatalf("failed to unmarshal: %v", err)
		}
		responses = append(responses, resp)
	}

	if len(responses) != 3 {
		t.Fatalf("expected 3 responses, got %d", len(responses))
	}

	if responses[0].Type != "session" {
		t.Errorf("expected first response to be session, got %+v", responses[0])
	}

	if responses[1].Type != "text" || responses[1].Content != "Hello" {
		t.Errorf("unexpected second response: %+v", responses[1])
	}

	if responses[2].Type != "done" {
		t.Errorf("unexpected third response: %+v", responses[2])
	}
}

func TestHandler_MultipleMessages(t *testing.T) {
	mock := &mockAgent{
		sessionID: "session-abc-123",
		events: []agent.AgentEvent{
			{Type: agent.EventTypeText, Content: "Response"},
			{Type: agent.EventTypeDone},
		},
	}
	h := NewHandler("test-token", mock, "/tmp", true)

	server := httptest.NewServer(h)
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http") + "?token=test-token"

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("failed to connect: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	msg1 := ClientMessage{Type: "message", ID: "msg-1", Content: "First message"}
	msgData, _ := json.Marshal(msg1)
	if err := conn.Write(ctx, websocket.MessageText, msgData); err != nil {
		t.Fatalf("failed to write first message: %v", err)
	}

	for i := 0; i < 3; i++ {
		_, _, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("failed to read response %d: %v", i, err)
		}
	}

	msg2 := ClientMessage{Type: "message", ID: "msg-2", Content: "Second message"}
	msgData, _ = json.Marshal(msg2)
	if err := conn.Write(ctx, websocket.MessageText, msgData); err != nil {
		t.Fatalf("failed to write second message: %v", err)
	}

	for i := 0; i < 3; i++ {
		_, _, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("failed to read response %d: %v", i, err)
		}
	}

	messages := mock.getMessages()
	if len(messages) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(messages))
	}

	if messages[0] != "First message" {
		t.Errorf("expected first message 'First message', got %q", messages[0])
	}

	if messages[1] != "Second message" {
		t.Errorf("expected second message 'Second message', got %q", messages[1])
	}
}

func TestHandler_MultipleSessions(t *testing.T) {
	mock := &mockAgent{
		events: []agent.AgentEvent{
			{Type: agent.EventTypeText, Content: "Response"},
			{Type: agent.EventTypeDone},
		},
	}
	h := NewHandler("test-token", mock, "/tmp", true)

	server := httptest.NewServer(h)
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http") + "?token=test-token"

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("failed to connect: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	msgA := ClientMessage{Type: "message", ID: "msg-a", SessionID: "session-A", Content: "Hello from A"}
	msgData, _ := json.Marshal(msgA)
	if err := conn.Write(ctx, websocket.MessageText, msgData); err != nil {
		t.Fatalf("failed to write message A: %v", err)
	}

	for i := 0; i < 3; i++ {
		_, _, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("failed to read response A-%d: %v", i, err)
		}
	}

	msgB := ClientMessage{Type: "message", ID: "msg-b", SessionID: "session-B", Content: "Hello from B"}
	msgData, _ = json.Marshal(msgB)
	if err := conn.Write(ctx, websocket.MessageText, msgData); err != nil {
		t.Fatalf("failed to write message B: %v", err)
	}

	for i := 0; i < 3; i++ {
		_, _, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("failed to read response B-%d: %v", i, err)
		}
	}

	msgA2 := ClientMessage{Type: "message", ID: "msg-a2", SessionID: "session-A", Content: "Second from A"}
	msgData, _ = json.Marshal(msgA2)
	if err := conn.Write(ctx, websocket.MessageText, msgData); err != nil {
		t.Fatalf("failed to write message A2: %v", err)
	}

	for i := 0; i < 3; i++ {
		_, _, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("failed to read response A2-%d: %v", i, err)
		}
	}

	messagesA := mock.getMessagesBySession("session-A")
	if len(messagesA) != 2 {
		t.Fatalf("expected 2 messages for session A, got %d", len(messagesA))
	}
	if messagesA[0] != "Hello from A" {
		t.Errorf("expected first message 'Hello from A', got %q", messagesA[0])
	}
	if messagesA[1] != "Second from A" {
		t.Errorf("expected second message 'Second from A', got %q", messagesA[1])
	}

	messagesB := mock.getMessagesBySession("session-B")
	if len(messagesB) != 1 {
		t.Fatalf("expected 1 message for session B, got %d", len(messagesB))
	}
	if messagesB[0] != "Hello from B" {
		t.Errorf("expected message 'Hello from B', got %q", messagesB[0])
	}
}

func TestHandler_PermissionRequest(t *testing.T) {
	events := []agent.AgentEvent{
		{
			Type:      agent.EventTypePermissionRequest,
			RequestID: "req-123",
			ToolName:  "Bash",
			ToolInput: []byte(`{"command":"ruby --version"}`),
			ToolUseID: "toolu_abc",
		},
		{Type: agent.EventTypeDone},
	}
	h := NewHandler("test-token", &mockAgent{events: events}, "/tmp", true)

	server := httptest.NewServer(h)
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http") + "?token=test-token"

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("failed to connect: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	msg := ClientMessage{
		Type:    "message",
		ID:      "test-perm-123",
		Content: "run ruby --version",
	}
	msgData, _ := json.Marshal(msg)
	if err := conn.Write(ctx, websocket.MessageText, msgData); err != nil {
		t.Fatalf("failed to write: %v", err)
	}

	var responses []ServerMessage
	for i := 0; i < 3; i++ {
		_, data, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("failed to read: %v", err)
		}
		var resp ServerMessage
		if err := json.Unmarshal(data, &resp); err != nil {
			t.Fatalf("failed to unmarshal: %v", err)
		}
		responses = append(responses, resp)
	}

	if responses[1].Type != "permission_request" {
		t.Errorf("expected second response to be permission_request, got %+v", responses[1])
	}

	if responses[1].RequestID != "req-123" {
		t.Errorf("expected request_id 'req-123', got %q", responses[1].RequestID)
	}

	if responses[1].ToolName != "Bash" {
		t.Errorf("expected tool_name 'Bash', got %q", responses[1].ToolName)
	}
}

func TestHandler_PermissionResponseInvalidSessionID(t *testing.T) {
	h := NewHandler("test-token", &mockAgent{}, "/tmp", true)

	server := httptest.NewServer(h)
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http") + "?token=test-token"

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("failed to connect: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	msg := ClientMessage{
		Type:      "permission_response",
		SessionID: "non-existent-session",
		RequestID: "req-123",
		Allow:     true,
	}
	msgData, _ := json.Marshal(msg)
	if err := conn.Write(ctx, websocket.MessageText, msgData); err != nil {
		t.Fatalf("failed to write: %v", err)
	}

	_, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("failed to read: %v", err)
	}

	var resp ServerMessage
	if err := json.Unmarshal(data, &resp); err != nil {
		t.Fatalf("failed to unmarshal: %v", err)
	}

	if resp.Type != "error" {
		t.Errorf("expected error response, got %+v", resp)
	}

	if !strings.Contains(resp.Error, "session not found") {
		t.Errorf("expected error message about session not found, got %q", resp.Error)
	}
}

func TestHandler_PermissionResponseInvalidRequestID(t *testing.T) {
	events := []agent.AgentEvent{
		{Type: agent.EventTypeText, Content: "Hello"},
		{Type: agent.EventTypeDone},
	}
	h := NewHandler("test-token", &mockAgent{events: events}, "/tmp", true)

	server := httptest.NewServer(h)
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http") + "?token=test-token"

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("failed to connect: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	msg := ClientMessage{Type: "message", ID: "msg-1", SessionID: "valid-session", Content: "hello"}
	msgData, _ := json.Marshal(msg)
	if err := conn.Write(ctx, websocket.MessageText, msgData); err != nil {
		t.Fatalf("failed to write: %v", err)
	}

	for i := 0; i < 3; i++ {
		_, _, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("failed to read response %d: %v", i, err)
		}
	}

	permResp := ClientMessage{
		Type:      "permission_response",
		SessionID: "valid-session",
		RequestID: "non-existent-request-id",
		Allow:     true,
	}
	msgData, _ = json.Marshal(permResp)
	if err := conn.Write(ctx, websocket.MessageText, msgData); err != nil {
		t.Fatalf("failed to write: %v", err)
	}

	_, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("failed to read: %v", err)
	}

	var resp ServerMessage
	if err := json.Unmarshal(data, &resp); err != nil {
		t.Fatalf("failed to unmarshal: %v", err)
	}

	if resp.Type != "error" {
		t.Errorf("expected error response, got %+v", resp)
	}

	if !strings.Contains(resp.Error, "no pending request") {
		t.Errorf("expected error about no pending request, got %q", resp.Error)
	}
}

func TestHandler_AgentStartError(t *testing.T) {
	mock := &mockAgent{
		startErr: fmt.Errorf("failed to start claude CLI"),
	}
	h := NewHandler("test-token", mock, "/tmp", true)

	server := httptest.NewServer(h)
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http") + "?token=test-token"

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("failed to connect: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	msg := ClientMessage{Type: "message", ID: "msg-1", Content: "hello"}
	msgData, _ := json.Marshal(msg)
	if err := conn.Write(ctx, websocket.MessageText, msgData); err != nil {
		t.Fatalf("failed to write: %v", err)
	}

	_, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("failed to read: %v", err)
	}

	var resp ServerMessage
	if err := json.Unmarshal(data, &resp); err != nil {
		t.Fatalf("failed to unmarshal: %v", err)
	}

	if resp.Type != "error" {
		t.Errorf("expected error response, got %+v", resp)
	}

	if !strings.Contains(resp.Error, "failed to start claude CLI") {
		t.Errorf("expected error about failed to start, got %q", resp.Error)
	}
}

func TestHandler_Cancel(t *testing.T) {
	mock := &mockAgent{
		events: []agent.AgentEvent{
			{Type: agent.EventTypeText, Content: "Response"},
			{Type: agent.EventTypeDone},
		},
	}
	h := NewHandler("test-token", mock, "/tmp", true)

	server := httptest.NewServer(h)
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http") + "?token=test-token"

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("failed to connect: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	// Create a session first
	msg := ClientMessage{Type: "message", ID: "msg-1", SessionID: "cancel-test-session", Content: "hello"}
	msgData, _ := json.Marshal(msg)
	if err := conn.Write(ctx, websocket.MessageText, msgData); err != nil {
		t.Fatalf("failed to write: %v", err)
	}

	// Read responses (session, text, done)
	for i := 0; i < 3; i++ {
		_, _, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("failed to read response %d: %v", i, err)
		}
	}

	// Cancel the session
	cancelMsg := ClientMessage{Type: "cancel", SessionID: "cancel-test-session"}
	msgData, _ = json.Marshal(cancelMsg)
	if err := conn.Write(ctx, websocket.MessageText, msgData); err != nil {
		t.Fatalf("failed to write cancel: %v", err)
	}

	// Try to send message to cancelled session - should get error
	msg2 := ClientMessage{Type: "message", ID: "msg-2", SessionID: "cancel-test-session", Content: "should create new"}
	msgData, _ = json.Marshal(msg2)
	if err := conn.Write(ctx, websocket.MessageText, msgData); err != nil {
		t.Fatalf("failed to write: %v", err)
	}

	// Should receive session event for the new session (cancel removes old one)
	_, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("failed to read: %v", err)
	}

	var resp ServerMessage
	if err := json.Unmarshal(data, &resp); err != nil {
		t.Fatalf("failed to unmarshal: %v", err)
	}

	// New session should be created
	if resp.Type != "session" {
		t.Errorf("expected session event after cancel, got %+v", resp)
	}
}

func TestHandler_CancelInvalidSession(t *testing.T) {
	h := NewHandler("test-token", &mockAgent{}, "/tmp", true)

	server := httptest.NewServer(h)
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http") + "?token=test-token"

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("failed to connect: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	// Try to cancel non-existent session
	cancelMsg := ClientMessage{Type: "cancel", SessionID: "non-existent"}
	msgData, _ := json.Marshal(cancelMsg)
	if err := conn.Write(ctx, websocket.MessageText, msgData); err != nil {
		t.Fatalf("failed to write: %v", err)
	}

	_, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("failed to read: %v", err)
	}

	var resp ServerMessage
	if err := json.Unmarshal(data, &resp); err != nil {
		t.Fatalf("failed to unmarshal: %v", err)
	}

	if resp.Type != "error" {
		t.Errorf("expected error response, got %+v", resp)
	}

	if !strings.Contains(resp.Error, "session not found") {
		t.Errorf("expected error about session not found, got %q", resp.Error)
	}
}

func TestHandler_PermissionResponseDuplicate(t *testing.T) {
	events := []agent.AgentEvent{
		{
			Type:      agent.EventTypePermissionRequest,
			RequestID: "req-dup-test",
			ToolName:  "Bash",
			ToolInput: []byte(`{"command":"ls"}`),
			ToolUseID: "toolu_dup",
		},
		{Type: agent.EventTypeDone},
	}
	h := NewHandler("test-token", &mockAgent{events: events}, "/tmp", true)

	server := httptest.NewServer(h)
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http") + "?token=test-token"

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("failed to connect: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	msg := ClientMessage{Type: "message", ID: "msg-1", SessionID: "test-session", Content: "test"}
	msgData, _ := json.Marshal(msg)
	if err := conn.Write(ctx, websocket.MessageText, msgData); err != nil {
		t.Fatalf("failed to write: %v", err)
	}

	for i := 0; i < 3; i++ {
		_, _, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("failed to read response %d: %v", i, err)
		}
	}

	permResp1 := ClientMessage{
		Type:      "permission_response",
		ID:        "perm-1",
		SessionID: "test-session",
		RequestID: "req-dup-test",
		Allow:     true,
	}
	msgData, _ = json.Marshal(permResp1)
	if err := conn.Write(ctx, websocket.MessageText, msgData); err != nil {
		t.Fatalf("failed to write first permission response: %v", err)
	}

	permResp2 := ClientMessage{
		Type:      "permission_response",
		ID:        "perm-2",
		SessionID: "test-session",
		RequestID: "req-dup-test",
		Allow:     true,
	}
	msgData, _ = json.Marshal(permResp2)
	if err := conn.Write(ctx, websocket.MessageText, msgData); err != nil {
		t.Fatalf("failed to write duplicate permission response: %v", err)
	}

	_, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("failed to read error response: %v", err)
	}

	var resp ServerMessage
	if err := json.Unmarshal(data, &resp); err != nil {
		t.Fatalf("failed to unmarshal: %v", err)
	}

	if resp.Type != "error" {
		t.Errorf("expected error response for duplicate, got %+v", resp)
	}

	if !strings.Contains(resp.Error, "no pending request") {
		t.Errorf("expected error about no pending request, got %q", resp.Error)
	}
}
