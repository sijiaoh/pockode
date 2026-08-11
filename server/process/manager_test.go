package process

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/session"
)

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

// testIdleTimeout is long enough that the background reaper never fires during
// a test; reaping is driven explicitly through reapIdleAsOf instead.
const testIdleTimeout = 10 * time.Minute

// awaitTimeout bounds waits for something that must happen. It is not a tuning
// knob: overshooting it means the transition never came, not that the machine
// was slow.
const awaitTimeout = 10 * time.Second

func TestManager_IdleReaper(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	m := NewManager(mockRegistry(mock), "/tmp", "", "", store, testIdleTimeout)
	defer m.Shutdown()

	_, _, _ = m.GetOrCreateProcess(context.Background(), "sess-1", false, session.AgentTypeClaude, session.ModeDefault)

	m.reapIdleAsOf(time.Now().Add(2 * testIdleTimeout))

	if proc := m.GetProcess("sess-1"); proc != nil {
		t.Error("expected process to be reaped")
	}
	if !mock.sessions["sess-1"].isClosed() {
		t.Error("expected process to be closed")
	}
}

func TestManager_IdleReaper_EmitsProcessStateEnded(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	m := NewManager(mockRegistry(mock), "/tmp", "", "", store, testIdleTimeout)
	defer m.Shutdown()

	ended := make(chan string, 8)
	m.SetOnStateChange(func(e StateChangeEvent) {
		if e.State == ProcessStateEnded {
			ended <- e.SessionID
		}
	})

	_, _, _ = m.GetOrCreateProcess(context.Background(), "sess-1", false, session.AgentTypeClaude, session.ModeDefault)

	m.reapIdleAsOf(time.Now().Add(2 * testIdleTimeout))

	// Emitted from the streamEvents goroutine once the session's event channel
	// closes, so the wait is for a state transition rather than for a duration.
	select {
	case sessionID := <-ended:
		if sessionID != "sess-1" {
			t.Errorf("ProcessStateEnded for %q, want sess-1", sessionID)
		}
	case <-time.After(awaitTimeout):
		t.Error("timed out waiting for ProcessStateEnded event")
	}
}

func TestManager_Touch_PreventsReaping(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	m := NewManager(mockRegistry(mock), "/tmp", "", "", store, testIdleTimeout)
	defer m.Shutdown()

	proc, _, _ := m.GetOrCreateProcess(context.Background(), "sess-1", false, session.AgentTypeClaude, session.ModeDefault)

	// Start out already overdue, so Touch has to actually move the process out
	// of reaping range. Touching a freshly created process proves nothing: it
	// would survive the check below whether Touch did anything or not.
	backdate(proc, 2*testIdleTimeout)

	m.Touch("sess-1")
	m.reapIdleAsOf(time.Now().Add(testIdleTimeout / 2))

	if m.GetProcess("sess-1") == nil {
		t.Fatal("expected process to still exist after touch")
	}
	if mock.sessions["sess-1"].isClosed() {
		t.Error("expected process to not be closed")
	}

	// And once that touch goes stale the process must be reaped again.
	m.reapIdleAsOf(time.Now().Add(2 * testIdleTimeout))
	if m.GetProcess("sess-1") != nil {
		t.Error("expected process to be reaped once the touch went stale")
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

// Shutdown is the point after which the caller is entitled to tear down the
// data directory, so nothing may still be writing to it. The streaming
// goroutine writes session history and flips session state, and it keeps doing
// both while draining events already buffered when the session closed.
func TestManager_Shutdown_WaitsForStreamingToFinish(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	m := NewManager(mockRegistry(mock), "/tmp", "", "", store, testIdleTimeout)

	proc, _, _ := m.GetOrCreateProcess(context.Background(), "sess-1", false, session.AgentTypeClaude, session.ModeDefault)

	// Give the goroutine real work left to do at shutdown: a closed channel
	// still yields what was buffered before it closed.
	for i := 0; i < 3; i++ {
		mock.sessions["sess-1"].events <- agent.TextEvent{Content: "buffered"}
	}

	m.Shutdown()

	select {
	case <-proc.drained:
	default:
		t.Error("Shutdown returned while the session was still streaming")
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
	m := NewManager(mockRegistry(mock), "/tmp", "", "", store, testIdleTimeout)
	defer m.Shutdown()

	// streamEvents emits to the listener after touching the process, so the
	// listener is the point at which the event is known to have been counted as
	// activity. Sleeping instead would only guess at when that happened.
	seen := make(chan struct{}, 8)
	m.SetMessageListener(listenerFunc(func(ChatMessage) { seen <- struct{}{} }))

	proc, _, _ := m.GetOrCreateProcess(context.Background(), "sess-1", false, session.AgentTypeClaude, session.ModeDefault)

	// Same reason as in the Touch test: unless the process starts out overdue,
	// it survives the check below whether or not the event counted as activity.
	backdate(proc, 2*testIdleTimeout)

	mock.sessions["sess-1"].events <- agent.TextEvent{Content: "test"}
	select {
	case <-seen:
	case <-time.After(awaitTimeout):
		t.Fatal("timed out waiting for the event to be streamed")
	}

	m.reapIdleAsOf(time.Now().Add(testIdleTimeout / 2))

	if m.GetProcess("sess-1") == nil {
		t.Fatal("expected process to still exist while streaming events")
	}
	if mock.sessions["sess-1"].isClosed() {
		t.Error("expected process to not be closed while streaming events")
	}

	// And once the stream goes quiet the process must be reaped again.
	m.reapIdleAsOf(time.Now().Add(2 * testIdleTimeout))
	if m.GetProcess("sess-1") != nil {
		t.Error("expected process to be reaped once the stream went quiet")
	}
}

func TestProcess_ClosedFlagSuppressesStateChanges(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	m := NewManager(mockRegistry(mock), "/tmp", "", "", store, 10*time.Minute)
	defer m.Shutdown()

	var mu sync.Mutex
	var events []StateChangeEvent
	ended := make(chan struct{}, 8)
	m.SetOnStateChange(func(e StateChangeEvent) {
		mu.Lock()
		events = append(events, e)
		mu.Unlock()
		if e.State == ProcessStateEnded {
			ended <- struct{}{}
		}
	})

	proc, _, _ := m.GetOrCreateProcess(context.Background(), "sess-1", false, session.AgentTypeClaude, session.ModeDefault)

	// Close sets the closed flag, preventing further state changes.
	m.Close("sess-1")

	// The ended event is the streamEvents goroutine's last act, so it marks the
	// point after which any further event could only come from the calls below.
	select {
	case <-ended:
	case <-time.After(awaitTimeout):
		t.Fatal("timed out waiting for the streamEvents goroutine to exit")
	}

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

// backdate makes a process look as though it has been idle for d, giving a
// later Touch or event something to actually move.
func backdate(p *Process, d time.Duration) {
	p.mu.Lock()
	p.lastActive = time.Now().Add(-d)
	p.mu.Unlock()
}

type listenerFunc func(ChatMessage)

func (f listenerFunc) OnChatMessage(msg ChatMessage) { f(msg) }
