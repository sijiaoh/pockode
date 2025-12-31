package process

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/pockode/server/agent"
	"github.com/pockode/server/session"
)

type mockAgent struct {
	mu         sync.Mutex
	startCalls []startCall
	sessions   map[string]*mockSession
}

type startCall struct {
	sessionID string
	resume    bool
}

func (m *mockAgent) Start(ctx context.Context, workDir string, sessionID string, resume bool) (agent.Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.startCalls = append(m.startCalls, startCall{sessionID, resume})

	if m.sessions == nil {
		m.sessions = make(map[string]*mockSession)
	}

	sess := &mockSession{
		events: make(chan agent.AgentEvent, 10),
	}
	m.sessions[sessionID] = sess
	return sess, nil
}

type mockSession struct {
	events   chan agent.AgentEvent
	closed   bool
	closedMu sync.Mutex
}

func (s *mockSession) Events() <-chan agent.AgentEvent { return s.events }
func (s *mockSession) SendMessage(prompt string) error { return nil }
func (s *mockSession) SendPermissionResponse(data agent.PermissionRequestData, choice agent.PermissionChoice) error {
	return nil
}
func (s *mockSession) SendQuestionResponse(data agent.QuestionRequestData, answers map[string]string) error {
	return nil
}
func (s *mockSession) SendInterrupt() error { return nil }
func (s *mockSession) Close() {
	s.closedMu.Lock()
	defer s.closedMu.Unlock()
	if !s.closed {
		s.closed = true
		close(s.events)
	}
}
func (s *mockSession) isClosed() bool {
	s.closedMu.Lock()
	defer s.closedMu.Unlock()
	return s.closed
}

func TestManager_GetOrCreateProcess_NewSession(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	m := NewManager(mock, "/tmp", store, 10*time.Minute)
	defer m.Shutdown()

	proc, created, err := m.GetOrCreateProcess(context.Background(), "sess-1", false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !created {
		t.Error("expected created=true for new session")
	}
	if proc == nil {
		t.Fatal("expected non-nil process")
	}
	if len(mock.startCalls) != 1 {
		t.Errorf("expected 1 start call, got %d", len(mock.startCalls))
	}
	if mock.startCalls[0].sessionID != "sess-1" {
		t.Errorf("expected sessionID=sess-1, got %s", mock.startCalls[0].sessionID)
	}
	if mock.startCalls[0].resume != false {
		t.Error("expected resume=false")
	}
}

func TestManager_GetOrCreateProcess_ExistingSession(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	m := NewManager(mock, "/tmp", store, 10*time.Minute)
	defer m.Shutdown()

	proc1, _, _ := m.GetOrCreateProcess(context.Background(), "sess-1", false)
	proc2, created, _ := m.GetOrCreateProcess(context.Background(), "sess-1", false)

	if created {
		t.Error("expected created=false for existing session")
	}
	if proc1 != proc2 {
		t.Error("expected same process for same session ID")
	}
	if len(mock.startCalls) != 1 {
		t.Errorf("expected 1 start call, got %d", len(mock.startCalls))
	}
}

func TestManager_IdleReaper(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	idleTimeout := 50 * time.Millisecond
	m := NewManager(mock, "/tmp", store, idleTimeout)
	defer m.Shutdown()

	_, _, _ = m.GetOrCreateProcess(context.Background(), "sess-1", false)

	time.Sleep(idleTimeout * 2)

	if proc := m.GetProcess("sess-1"); proc != nil {
		t.Error("expected process to be reaped")
	}
	if !mock.sessions["sess-1"].isClosed() {
		t.Error("expected process to be closed")
	}
}

func TestManager_Touch_PreventsReaping(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	idleTimeout := 50 * time.Millisecond
	m := NewManager(mock, "/tmp", store, idleTimeout)
	defer m.Shutdown()

	_, _, _ = m.GetOrCreateProcess(context.Background(), "sess-1", false)

	// Touch periodically for 2x idleTimeout
	// Reaper runs multiple times, but process survives due to Touch
	for i := 0; i < 4; i++ {
		time.Sleep(idleTimeout / 2)
		m.Touch("sess-1")
	}
	// Total elapsed: 4 * 25ms = 100ms = 2x idleTimeout

	if proc := m.GetProcess("sess-1"); proc == nil {
		t.Error("expected process to still exist after touch")
	}
	if mock.sessions["sess-1"].isClosed() {
		t.Error("expected process to not be closed")
	}
}

func TestManager_Shutdown_ClosesAllProcesses(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	m := NewManager(mock, "/tmp", store, 10*time.Minute)

	_, _, _ = m.GetOrCreateProcess(context.Background(), "sess-1", false)
	_, _, _ = m.GetOrCreateProcess(context.Background(), "sess-2", false)

	m.Shutdown()

	if !mock.sessions["sess-1"].isClosed() {
		t.Error("expected process for sess-1 to be closed")
	}
	if !mock.sessions["sess-2"].isClosed() {
		t.Error("expected process for sess-2 to be closed")
	}
	if m.GetProcess("sess-1") != nil {
		t.Error("expected process for sess-1 to be removed from manager")
	}
	if m.GetProcess("sess-2") != nil {
		t.Error("expected process for sess-2 to be removed from manager")
	}
}

func TestManager_Close_SpecificProcess(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	m := NewManager(mock, "/tmp", store, 10*time.Minute)
	defer m.Shutdown()

	_, _, _ = m.GetOrCreateProcess(context.Background(), "sess-1", false)
	_, _, _ = m.GetOrCreateProcess(context.Background(), "sess-2", false)

	m.Close("sess-1")

	if !mock.sessions["sess-1"].isClosed() {
		t.Error("expected process for sess-1 to be closed")
	}
	if mock.sessions["sess-2"].isClosed() {
		t.Error("expected process for sess-2 to still be open")
	}
	if m.GetProcess("sess-1") != nil {
		t.Error("expected process for sess-1 to be removed from manager")
	}
	if m.GetProcess("sess-2") == nil {
		t.Error("expected process for sess-2 to still exist in manager")
	}
}

// newTestWebSocket creates a WebSocket connection pair for testing.
func newTestWebSocket(t *testing.T) (*websocket.Conn, *websocket.Conn) {
	t.Helper()

	serverConnCh := make(chan *websocket.Conn, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Errorf("failed to accept websocket: %v", err)
			return
		}
		serverConnCh <- conn
		// Block until test cleanup to prevent premature connection close
		<-r.Context().Done()
	}))

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)

	clientConn, _, err := websocket.Dial(ctx, "ws"+server.URL[4:], nil)
	if err != nil {
		cancel()
		server.Close()
		t.Fatalf("failed to dial websocket: %v", err)
	}

	serverConn := <-serverConnCh

	t.Cleanup(func() {
		cancel()
		server.Close()
	})

	return serverConn, clientConn
}

func TestManager_SubscribeUnsubscribe(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	m := NewManager(mock, "/tmp", store, 10*time.Minute)
	defer m.Shutdown()

	conn1, _ := newTestWebSocket(t)
	conn2, _ := newTestWebSocket(t)

	// Subscribe to session (no process needed)
	if !m.Subscribe("sess-1", conn1) {
		t.Error("expected first subscribe to return true")
	}
	if !m.Subscribe("sess-1", conn2) {
		t.Error("expected second subscribe to return true")
	}

	// Duplicate subscribe should return false
	if m.Subscribe("sess-1", conn1) {
		t.Error("expected duplicate subscribe to return false")
	}

	m.Unsubscribe("sess-1", conn1)
	m.Unsubscribe("sess-1", conn2)

	// Unsubscribe non-existent should not panic
	m.Unsubscribe("sess-1", conn1)
}

func TestManager_Broadcast(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	m := NewManager(mock, "/tmp", store, 10*time.Minute)
	defer m.Shutdown()

	serverConn1, clientConn1 := newTestWebSocket(t)
	serverConn2, clientConn2 := newTestWebSocket(t)

	// Subscribe first
	m.Subscribe("sess-1", serverConn1)
	m.Subscribe("sess-1", serverConn2)

	// Create process
	_, _, _ = m.GetOrCreateProcess(context.Background(), "sess-1", false)

	// Send event through agent session
	mock.sessions["sess-1"].events <- agent.AgentEvent{
		Type:    agent.EventTypeText,
		Content: "hello",
	}

	// Both clients should receive the broadcast
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()

	_, data1, err := clientConn1.Read(ctx)
	if err != nil {
		t.Fatalf("client1 read error: %v", err)
	}
	if string(data1) == "" {
		t.Error("client1 received empty message")
	}

	_, data2, err := clientConn2.Read(ctx)
	if err != nil {
		t.Fatalf("client2 read error: %v", err)
	}
	if string(data2) == "" {
		t.Error("client2 received empty message")
	}

	// Both should receive the same message
	if string(data1) != string(data2) {
		t.Errorf("clients received different messages: %s vs %s", data1, data2)
	}
}

func TestManager_HasProcess(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	m := NewManager(mock, "/tmp", store, 10*time.Minute)
	defer m.Shutdown()

	// No process initially
	if m.HasProcess("sess-1") {
		t.Error("expected HasProcess to return false before process creation")
	}

	// Create process
	_, _, _ = m.GetOrCreateProcess(context.Background(), "sess-1", false)

	if !m.HasProcess("sess-1") {
		t.Error("expected HasProcess to return true after process creation")
	}
}
