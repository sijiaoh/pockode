package process

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/session"
)

// testIdleTimeout paces the tests that assert a process is *kept alive* by
// activity. Those cannot poll for an outcome — they have to let wall-clock time
// pass — so the budget is generous: a loaded machine easily stalls a goroutine
// for a few hundred milliseconds, which a shorter budget misread as an idle
// process.
const testIdleTimeout = time.Second

// waitFor polls until cond holds, so tests that expect something to happen
// finish as soon as it does instead of betting on a fixed sleep.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func mockRegistry(mock *mockAgent) *agent.Registry {
	r := agent.NewRegistry()
	r.Register(session.AgentTypeClaude, mock)
	return r
}

type mockAgent struct {
	mu         sync.Mutex
	startCalls []startCall
	sessions   map[string]*mockSession
}

type startCall struct {
	sessionID    string
	resume       bool
	mode         session.Mode
	dataDir      string
	mcpServerDir string
}

func (m *mockAgent) Start(ctx context.Context, opts agent.StartOptions) (agent.Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.startCalls = append(m.startCalls, startCall{opts.SessionID, opts.Resume, opts.Mode, opts.DataDir, opts.MCPServerDir})

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
	m := NewManager(mockRegistry(mock), "/tmp", "", "", store, 10*time.Minute)
	defer m.Shutdown()

	proc, created, err := m.GetOrCreateProcess(context.Background(), "sess-1", false, session.AgentTypeClaude, session.ModeDefault)
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

// TestManager_ForwardsSeparateDataAndMCPDirs locks the worktree fix: the manager
// hands the agent its own (worktree) data dir for session state and the main data
// dir separately for MCP server.json discovery. Conflating them would send the
// MCP proxy to a worktree dir that has no server.json.
func TestManager_ForwardsSeparateDataAndMCPDirs(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	m := NewManager(mockRegistry(mock), "/tmp", "/data/worktrees/feature-x", "/data", store, 10*time.Minute)
	defer m.Shutdown()

	if _, _, err := m.GetOrCreateProcess(context.Background(), "sess-1", false, session.AgentTypeClaude, session.ModeDefault); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(mock.startCalls) != 1 {
		t.Fatalf("expected 1 start call, got %d", len(mock.startCalls))
	}
	if got := mock.startCalls[0].dataDir; got != "/data/worktrees/feature-x" {
		t.Errorf("DataDir = %q, want the worktree data dir", got)
	}
	if got := mock.startCalls[0].mcpServerDir; got != "/data" {
		t.Errorf("MCPServerDir = %q, want the main data dir", got)
	}
}

func TestManager_GetOrCreateProcess_ExistingSession(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	m := NewManager(mockRegistry(mock), "/tmp", "", "", store, 10*time.Minute)
	defer m.Shutdown()

	proc1, _, _ := m.GetOrCreateProcess(context.Background(), "sess-1", false, session.AgentTypeClaude, session.ModeDefault)
	proc2, created, _ := m.GetOrCreateProcess(context.Background(), "sess-1", false, session.AgentTypeClaude, session.ModeDefault)

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
	m := NewManager(mockRegistry(mock), "/tmp", "", "", store, 50*time.Millisecond)
	defer m.Shutdown()

	_, _, _ = m.GetOrCreateProcess(context.Background(), "sess-1", false, session.AgentTypeClaude, session.ModeDefault)

	waitFor(t, "idle process to be reaped", func() bool {
		return m.GetProcess("sess-1") == nil
	})
	if !mock.sessions["sess-1"].isClosed() {
		t.Error("expected process to be closed")
	}
}

func TestManager_IdleReaper_EmitsProcessStateEnded(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	m := NewManager(mockRegistry(mock), "/tmp", "", "", store, 50*time.Millisecond)
	defer m.Shutdown()

	var mu sync.Mutex
	var events []StateChangeEvent
	m.SetOnStateChange(func(e StateChangeEvent) {
		mu.Lock()
		events = append(events, e)
		mu.Unlock()
	})

	_, _, _ = m.GetOrCreateProcess(context.Background(), "sess-1", false, session.AgentTypeClaude, session.ModeDefault)

	waitFor(t, "ProcessStateEnded event for sess-1", func() bool {
		mu.Lock()
		defer mu.Unlock()
		for _, e := range events {
			if e.SessionID == "sess-1" && e.State == ProcessStateEnded {
				return true
			}
		}
		return false
	})
}

func TestManager_Touch_PreventsReaping(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	idleTimeout := testIdleTimeout
	m := NewManager(mockRegistry(mock), "/tmp", "", "", store, idleTimeout)
	defer m.Shutdown()

	_, _, _ = m.GetOrCreateProcess(context.Background(), "sess-1", false, session.AgentTypeClaude, session.ModeDefault)

	// Touch periodically for 2x idleTimeout
	// Reaper runs multiple times, but process survives due to Touch
	for i := 0; i < 4; i++ {
		time.Sleep(idleTimeout / 2)
		m.Touch("sess-1")
	}

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
	m := NewManager(mockRegistry(mock), "/tmp", "", "", store, 10*time.Minute)

	_, _, _ = m.GetOrCreateProcess(context.Background(), "sess-1", false, session.AgentTypeClaude, session.ModeDefault)
	_, _, _ = m.GetOrCreateProcess(context.Background(), "sess-2", false, session.AgentTypeClaude, session.ModeDefault)

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
	m := NewManager(mockRegistry(mock), "/tmp", "", "", store, 10*time.Minute)
	defer m.Shutdown()

	_, _, _ = m.GetOrCreateProcess(context.Background(), "sess-1", false, session.AgentTypeClaude, session.ModeDefault)
	_, _, _ = m.GetOrCreateProcess(context.Background(), "sess-2", false, session.AgentTypeClaude, session.ModeDefault)

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
	m := NewManager(mockRegistry(mock), "/tmp", "", "", store, 10*time.Minute)
	defer m.Shutdown()

	// No process initially
	if m.HasProcess("sess-1") {
		t.Error("expected HasProcess to return false before process creation")
	}

	// Create process
	_, _, _ = m.GetOrCreateProcess(context.Background(), "sess-1", false, session.AgentTypeClaude, session.ModeDefault)

	if !m.HasProcess("sess-1") {
		t.Error("expected HasProcess to return true after process creation")
	}
}

func TestManager_StreamingEvents_PreventsReaping(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	idleTimeout := testIdleTimeout
	m := NewManager(mockRegistry(mock), "/tmp", "", "", store, idleTimeout)
	defer m.Shutdown()

	_, _, _ = m.GetOrCreateProcess(context.Background(), "sess-1", false, session.AgentTypeClaude, session.ModeDefault)

	// The reaper closes the events channel, and sending on a closed channel
	// panics — recover so a regression fails this test instead of aborting the
	// whole package run.
	sendEvent := func() (sent bool) {
		defer func() {
			if recover() != nil {
				sent = false
			}
		}()
		mock.sessions["sess-1"].events <- agent.TextEvent{Content: "test"}
		return true
	}

	// Send events periodically for 2x idleTimeout
	// Process should survive because streamEvents calls touch() on each event
	for i := 0; i < 4; i++ {
		time.Sleep(idleTimeout / 2)
		if !sendEvent() {
			t.Fatal("process was reaped while events were still streaming")
		}
	}

	// Give streamEvents goroutine time to process the events
	time.Sleep(10 * time.Millisecond)

	if proc := m.GetProcess("sess-1"); proc == nil {
		t.Error("expected process to still exist while streaming events")
	}
	if mock.sessions["sess-1"].isClosed() {
		t.Error("expected process to not be closed while streaming events")
	}
}

func TestProcess_ClosedFlagSuppressesStateChanges(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	m := NewManager(mockRegistry(mock), "/tmp", "", "", store, 10*time.Minute)
	defer m.Shutdown()

	var mu sync.Mutex
	var events []StateChangeEvent
	m.SetOnStateChange(func(e StateChangeEvent) {
		mu.Lock()
		events = append(events, e)
		mu.Unlock()
	})

	proc, _, _ := m.GetOrCreateProcess(context.Background(), "sess-1", false, session.AgentTypeClaude, session.ModeDefault)

	// Close sets the closed flag, preventing further state changes.
	m.Close("sess-1")

	// Wait for the streamEvents goroutine to exit.
	time.Sleep(50 * time.Millisecond)

	mu.Lock()
	events = nil // clear initial idle + ended
	mu.Unlock()

	// After Close, SetRunning and SetIdle must be no-ops.
	proc.SetRunning()
	proc.SetIdle(false)

	mu.Lock()
	defer mu.Unlock()
	if len(events) != 0 {
		t.Errorf("expected no state changes after Close, got %v", events)
	}
}

func TestProcess_SetRunning_EmitsStateChange(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	m := NewManager(mockRegistry(mock), "/tmp", "", "", store, 10*time.Minute)
	defer m.Shutdown()

	var events []StateChangeEvent
	m.SetOnStateChange(func(e StateChangeEvent) {
		events = append(events, e)
	})

	proc, _, _ := m.GetOrCreateProcess(context.Background(), "sess-1", false, session.AgentTypeClaude, session.ModeDefault)

	// Initial state is idle, creation emits idle
	if len(events) != 1 || events[0].State != ProcessStateIdle {
		t.Fatalf("expected initial idle event, got %v", events)
	}

	// SetRunning should emit running
	proc.SetRunning()
	if len(events) != 2 || events[1].State != ProcessStateRunning {
		t.Errorf("expected running event, got %v", events)
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
	m := NewManager(mockRegistry(mock), "/tmp", "", "", store, 10*time.Minute)
	defer m.Shutdown()

	var events []StateChangeEvent
	m.SetOnStateChange(func(e StateChangeEvent) {
		events = append(events, e)
	})

	proc, _, _ := m.GetOrCreateProcess(context.Background(), "sess-1", false, session.AgentTypeClaude, session.ModeDefault)
	proc.SetRunning()

	// SetIdle should emit idle
	proc.SetIdle(false)
	if len(events) != 3 || events[2].State != ProcessStateIdle {
		t.Errorf("expected idle event, got %v", events)
	}

	// Duplicate SetIdle should not emit
	proc.SetIdle(false)
	if len(events) != 3 {
		t.Errorf("expected no duplicate event, got %d events", len(events))
	}
}

func TestProcess_SendMessage_SetsRunning(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	m := NewManager(mockRegistry(mock), "/tmp", "", "", store, 10*time.Minute)
	defer m.Shutdown()

	var events []StateChangeEvent
	m.SetOnStateChange(func(e StateChangeEvent) {
		events = append(events, e)
	})

	proc, _, _ := m.GetOrCreateProcess(context.Background(), "sess-1", false, session.AgentTypeClaude, session.ModeDefault)

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
