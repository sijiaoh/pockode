package process

import (
	"context"
	"sync"
	"testing"
	"time"

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
	mode      session.Mode
}

func (m *mockAgent) Start(ctx context.Context, opts agent.StartOptions) (agent.Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.startCalls = append(m.startCalls, startCall{opts.SessionID, opts.Resume, opts.Mode})

	if m.sessions == nil {
		m.sessions = make(map[string]*mockSession)
	}

	sess := &mockSession{
		events: make(chan agent.AgentEvent, 10),
	}
	m.sessions[opts.SessionID] = sess
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
	m := NewManager(mock, "/tmp", store, 10*time.Minute, "")
	defer m.Shutdown()

	proc, created, err := m.GetOrCreateProcess(context.Background(), "sess-1", false, session.ModeDefault)
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
	m := NewManager(mock, "/tmp", store, 10*time.Minute, "")
	defer m.Shutdown()

	proc1, _, _ := m.GetOrCreateProcess(context.Background(), "sess-1", false, session.ModeDefault)
	proc2, created, _ := m.GetOrCreateProcess(context.Background(), "sess-1", false, session.ModeDefault)

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
	m := NewManager(mock, "/tmp", store, idleTimeout, "")
	defer m.Shutdown()

	_, _, _ = m.GetOrCreateProcess(context.Background(), "sess-1", false, session.ModeDefault)

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
	m := NewManager(mock, "/tmp", store, idleTimeout, "")
	defer m.Shutdown()

	_, _, _ = m.GetOrCreateProcess(context.Background(), "sess-1", false, session.ModeDefault)

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
	m := NewManager(mock, "/tmp", store, 10*time.Minute, "")

	_, _, _ = m.GetOrCreateProcess(context.Background(), "sess-1", false, session.ModeDefault)
	_, _, _ = m.GetOrCreateProcess(context.Background(), "sess-2", false, session.ModeDefault)

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
	m := NewManager(mock, "/tmp", store, 10*time.Minute, "")
	defer m.Shutdown()

	_, _, _ = m.GetOrCreateProcess(context.Background(), "sess-1", false, session.ModeDefault)
	_, _, _ = m.GetOrCreateProcess(context.Background(), "sess-2", false, session.ModeDefault)

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

func TestManager_HasProcess(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	m := NewManager(mock, "/tmp", store, 10*time.Minute, "")
	defer m.Shutdown()

	// No process initially
	if m.HasProcess("sess-1") {
		t.Error("expected HasProcess to return false before process creation")
	}

	// Create process
	_, _, _ = m.GetOrCreateProcess(context.Background(), "sess-1", false, session.ModeDefault)

	if !m.HasProcess("sess-1") {
		t.Error("expected HasProcess to return true after process creation")
	}
}

func TestManager_StreamingEvents_PreventsReaping(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	idleTimeout := 50 * time.Millisecond
	m := NewManager(mock, "/tmp", store, idleTimeout, "")
	defer m.Shutdown()

	_, _, _ = m.GetOrCreateProcess(context.Background(), "sess-1", false, session.ModeDefault)

	// Send events periodically for 2x idleTimeout
	// Process should survive because streamEvents calls touch() on each event
	for i := 0; i < 4; i++ {
		time.Sleep(idleTimeout / 2)
		mock.sessions["sess-1"].events <- agent.TextEvent{Content: "test"}
	}
	// Total elapsed: 4 * 25ms = 100ms = 2x idleTimeout

	// Give streamEvents goroutine time to process the events
	time.Sleep(10 * time.Millisecond)

	if proc := m.GetProcess("sess-1"); proc == nil {
		t.Error("expected process to still exist while streaming events")
	}
	if mock.sessions["sess-1"].isClosed() {
		t.Error("expected process to not be closed while streaming events")
	}
}

func TestProcess_SetRunning_EmitsStateChange(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	m := NewManager(mock, "/tmp", store, 10*time.Minute, "")
	defer m.Shutdown()

	var events []StateChangeEvent
	m.SetOnStateChange(func(e StateChangeEvent) {
		events = append(events, e)
	})

	proc, _, _ := m.GetOrCreateProcess(context.Background(), "sess-1", false, session.ModeDefault)

	// Initial state is idle, creation emits idle with IsInitial=true
	if len(events) != 1 || events[0].State != ProcessStateIdle || !events[0].IsInitial {
		t.Fatalf("expected initial idle event with IsInitial=true, got %v", events)
	}

	// SetRunning should emit running with IsInitial=false
	proc.SetRunning()
	if len(events) != 2 || events[1].State != ProcessStateRunning || events[1].IsInitial {
		t.Errorf("expected running event with IsInitial=false, got %v", events)
	}

	// Duplicate SetRunning should not emit
	proc.SetRunning()
	if len(events) != 2 {
		t.Errorf("expected no duplicate event, got %d events", len(events))
	}
}

func TestProcess_SetIdle_EmitsStateChange(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	m := NewManager(mock, "/tmp", store, 10*time.Minute, "")
	defer m.Shutdown()

	var events []StateChangeEvent
	m.SetOnStateChange(func(e StateChangeEvent) {
		events = append(events, e)
	})

	proc, _, _ := m.GetOrCreateProcess(context.Background(), "sess-1", false, session.ModeDefault)
	proc.SetRunning()

	// SetIdle should emit idle with IsInitial=false (not initial, it's after running)
	proc.SetIdle()
	if len(events) != 3 || events[2].State != ProcessStateIdle || events[2].IsInitial {
		t.Errorf("expected idle event with IsInitial=false, got %v", events)
	}

	// Duplicate SetIdle should not emit
	proc.SetIdle()
	if len(events) != 3 {
		t.Errorf("expected no duplicate event, got %d events", len(events))
	}
}

func TestProcess_SendMessage_SetsRunning(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	m := NewManager(mock, "/tmp", store, 10*time.Minute, "")
	defer m.Shutdown()

	var events []StateChangeEvent
	m.SetOnStateChange(func(e StateChangeEvent) {
		events = append(events, e)
	})

	proc, _, _ := m.GetOrCreateProcess(context.Background(), "sess-1", false, session.ModeDefault)

	if proc.State() != ProcessStateIdle {
		t.Fatalf("expected initial state to be idle")
	}

	_ = proc.SendMessage("hello")

	if proc.State() != ProcessStateRunning {
		t.Errorf("expected state to be running after SendMessage")
	}
	if len(events) != 2 || events[1].State != ProcessStateRunning {
		t.Errorf("expected running event after SendMessage, got %v", events)
	}
}
