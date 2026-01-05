package process

import (
	"context"
	"io"
	"sync"
	"testing"
	"time"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/rpc"
	"github.com/pockode/server/session"
	"github.com/sourcegraph/jsonrpc2"
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

// testObjectStream is a mock ObjectStream for testing JSON-RPC connections.
type testObjectStream struct {
	r        *io.PipeReader
	w        *io.PipeWriter
	received chan interface{}
	closed   chan struct{}
}

func newTestObjectStream() *testObjectStream {
	r, w := io.Pipe()
	return &testObjectStream{
		r:        r,
		w:        w,
		received: make(chan interface{}, 10),
		closed:   make(chan struct{}),
	}
}

func (s *testObjectStream) ReadObject(v interface{}) error {
	<-s.closed
	return io.EOF
}

func (s *testObjectStream) WriteObject(v interface{}) error {
	s.received <- v
	return nil
}

func (s *testObjectStream) Close() error {
	close(s.closed)
	s.r.Close()
	s.w.Close()
	return nil
}

func TestManager_SubscribeUnsubscribeRPC(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	m := NewManager(mock, "/tmp", store, 10*time.Minute)
	defer m.Shutdown()

	stream1 := newTestObjectStream()
	stream2 := newTestObjectStream()
	conn1 := jsonrpc2.NewConn(context.Background(), stream1, nil)
	conn2 := jsonrpc2.NewConn(context.Background(), stream2, nil)
	defer conn1.Close()
	defer conn2.Close()

	// Subscribe to session (no process needed)
	if !m.SubscribeRPC("sess-1", conn1) {
		t.Error("expected first subscribe to return true")
	}
	if !m.SubscribeRPC("sess-1", conn2) {
		t.Error("expected second subscribe to return true")
	}

	// Duplicate subscribe should return false
	if m.SubscribeRPC("sess-1", conn1) {
		t.Error("expected duplicate subscribe to return false")
	}

	m.UnsubscribeRPC("sess-1", conn1)
	m.UnsubscribeRPC("sess-1", conn2)

	// Unsubscribe non-existent should not panic
	m.UnsubscribeRPC("sess-1", conn1)
}

func TestManager_Notify(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	m := NewManager(mock, "/tmp", store, 10*time.Minute)
	defer m.Shutdown()

	_, _ = store.Create(context.Background(), "sess-1")

	stream1 := newTestObjectStream()
	stream2 := newTestObjectStream()
	conn1 := jsonrpc2.NewConn(context.Background(), stream1, nil)
	conn2 := jsonrpc2.NewConn(context.Background(), stream2, nil)
	defer conn1.Close()
	defer conn2.Close()

	m.SubscribeRPC("sess-1", conn1)
	m.SubscribeRPC("sess-1", conn2)

	params := rpc.TextParams{SessionID: "sess-1", Content: "hello"}
	m.Notify(context.Background(), "sess-1", "text", params)

	select {
	case msg := <-stream1.received:
		if msg == nil {
			t.Error("stream1 received nil message")
		}
	case <-time.After(100 * time.Millisecond):
		t.Error("stream1 did not receive notification")
	}

	select {
	case msg := <-stream2.received:
		if msg == nil {
			t.Error("stream2 received nil message")
		}
	case <-time.After(100 * time.Millisecond):
		t.Error("stream2 did not receive notification")
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
