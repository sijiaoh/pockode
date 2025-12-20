package ws

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/pockode/server/agent"
)

// mockAgent implements agent.Agent for testing.
type mockAgent struct {
	events []agent.AgentEvent
	err    error
}

func (m *mockAgent) Run(ctx context.Context, prompt string, workDir string) (<-chan agent.AgentEvent, error) {
	if m.err != nil {
		return nil, m.err
	}

	ch := make(chan agent.AgentEvent)
	go func() {
		defer close(ch)
		for _, event := range m.events {
			select {
			case ch <- event:
			case <-ctx.Done():
				return
			}
		}
	}()
	return ch, nil
}

func TestHandler_MissingToken(t *testing.T) {
	h := NewHandler("secret-token", &mockAgent{}, "/tmp")

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
	h := NewHandler("secret-token", &mockAgent{}, "/tmp")

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
	h := NewHandler("test-token", &mockAgent{events: events}, "/tmp")

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

	// Send a message
	msg := ClientMessage{
		Type:    "message",
		ID:      "test-123",
		Content: "Hello AI",
	}
	msgData, _ := json.Marshal(msg)
	if err := conn.Write(ctx, websocket.MessageText, msgData); err != nil {
		t.Fatalf("failed to write: %v", err)
	}

	// Read responses
	var responses []ServerMessage
	for i := 0; i < 2; i++ {
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

	// Verify responses
	if len(responses) != 2 {
		t.Fatalf("expected 2 responses, got %d", len(responses))
	}

	if responses[0].Type != "text" || responses[0].Content != "Hello" {
		t.Errorf("unexpected first response: %+v", responses[0])
	}

	if responses[1].Type != "done" {
		t.Errorf("unexpected second response: %+v", responses[1])
	}

	if responses[0].MessageID != "test-123" {
		t.Errorf("expected message_id 'test-123', got %q", responses[0].MessageID)
	}
}

func TestHandler_ToolCallEvent(t *testing.T) {
	events := []agent.AgentEvent{
		{
			Type:      agent.EventTypeToolCall,
			ToolName:  "Read",
			ToolInput: json.RawMessage(`{"file":"test.go"}`),
		},
		{Type: agent.EventTypeDone},
	}
	h := NewHandler("test-token", &mockAgent{events: events}, "/tmp")

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

	// Send a message
	msg := ClientMessage{Type: "message", ID: "msg-1", Content: "test"}
	msgData, _ := json.Marshal(msg)
	if err := conn.Write(ctx, websocket.MessageText, msgData); err != nil {
		t.Fatalf("failed to write: %v", err)
	}

	// Read tool_call response
	_, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("failed to read: %v", err)
	}

	var resp ServerMessage
	if err := json.Unmarshal(data, &resp); err != nil {
		t.Fatalf("failed to unmarshal: %v", err)
	}

	if resp.Type != "tool_call" {
		t.Errorf("expected type 'tool_call', got %q", resp.Type)
	}

	if resp.ToolName != "Read" {
		t.Errorf("expected tool_name 'Read', got %q", resp.ToolName)
	}

	if string(resp.ToolInput) != `{"file":"test.go"}` {
		t.Errorf("expected tool_input '%s', got %q", `{"file":"test.go"}`, string(resp.ToolInput))
	}
}

func TestSessionState_CancelCurrent(t *testing.T) {
	session := &sessionState{}

	called := false
	session.setCancel(func() {
		called = true
	})

	session.cancelCurrent()

	if !called {
		t.Error("cancel function was not called")
	}

	// Second call should not panic
	session.cancelCurrent()
}

func TestSessionState_SetCancelReplacesExisting(t *testing.T) {
	session := &sessionState{}

	firstCalled := false
	secondCalled := false

	session.setCancel(func() {
		firstCalled = true
	})

	// Setting new cancel should call the first one
	session.setCancel(func() {
		secondCalled = true
	})

	if !firstCalled {
		t.Error("first cancel function was not called when replaced")
	}

	if secondCalled {
		t.Error("second cancel function should not be called yet")
	}
}
