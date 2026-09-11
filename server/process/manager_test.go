package process

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
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
	// startWaiting makes every session it creates start out waiting on
	// background work, so a test never races the reaper to set the flag.
	startWaiting bool
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
	sess.waitingForBackground.Store(m.startWaiting)
	m.sessions[opts.SessionID] = sess
	return sess, nil
}

// session returns the session the mock created for sessionID. Start writes the
// map from the manager's goroutine, so reading it needs the same lock.
func (m *mockAgent) session(t *testing.T, sessionID string) *mockSession {
	t.Helper()
	m.mu.Lock()
	defer m.mu.Unlock()
	sess, ok := m.sessions[sessionID]
	if !ok {
		t.Fatalf("no session started for %q", sessionID)
	}
	return sess
}

type mockSession struct {
	events   chan agent.AgentEvent
	closed   bool
	closedMu sync.Mutex

	// waitingForBackground makes the mock an agent.BackgroundWaiter that is
	// currently holding a turn open.
	waitingForBackground atomic.Bool
}

func (s *mockSession) WaitingForBackgroundWork() bool { return s.waitingForBackground.Load() }

// emit delivers an event as the agent would. Holding closedMu keeps a test that
// races the idle reaper from panicking on a closed channel, reporting the
// unexpected close instead.
func (s *mockSession) emit(t *testing.T, event agent.AgentEvent) {
	t.Helper()
	s.closedMu.Lock()
	defer s.closedMu.Unlock()
	if s.closed {
		t.Fatal("session closed before the event could be emitted")
	}
	s.events <- event
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

// stateRecorder collects the state changes a manager emits.
type stateRecorder struct {
	mu     sync.Mutex
	events []StateChangeEvent
}

func (r *stateRecorder) record(e StateChangeEvent) {
	r.mu.Lock()
	r.events = append(r.events, e)
	r.mu.Unlock()
}

func (r *stateRecorder) reset() {
	r.mu.Lock()
	r.events = nil
	r.mu.Unlock()
}

func (r *stateRecorder) snapshot() []StateChangeEvent {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]StateChangeEvent(nil), r.events...)
}

// waitUntil polls cond until it holds, failing the test with what it was waiting
// for if it never does. Everything the manager does happens on its own
// goroutines, so this is how the tests below stay off the wall clock.
func waitUntil(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

// waitForCount waits until at least n state changes have been recorded.
func (r *stateRecorder) waitForCount(t *testing.T, n int) {
	t.Helper()
	waitUntil(t, fmt.Sprintf("%d state changes", n), func() bool {
		return len(r.snapshot()) >= n
	})
}

// waitForHistory waits until n events have been written to the session's
// history. streamEvents persists an event after deciding its state transition,
// so this is how a test observes that events it does not expect to change the
// state have nonetheless been processed.
func waitForHistory(t *testing.T, store session.Store, sessionID string, n int) {
	t.Helper()
	waitUntil(t, fmt.Sprintf("%d history records", n), func() bool {
		records, err := store.GetHistory(context.Background(), sessionID)
		if err != nil {
			t.Fatalf("failed to read history: %v", err)
		}
		return len(records) >= n
	})
}

// TestProcess_OutOfTurnEventsKeepProcessIdle covers events that reach the
// process with no turn in flight. Codex emits a warning at startup when it
// cannot resume the session's thread; treating that as agent output would leave
// a session marked running with nothing running, which work.AutoResumer reads as
// "the agent is working" and never corrects.
func TestProcess_OutOfTurnEventsKeepProcessIdle(t *testing.T) {
	tests := []struct {
		name  string
		event agent.AgentEvent
	}{
		{"warning", agent.WarningEvent{Message: "cannot resume", Code: "session_not_resumable"}},
		{"request cancelled", agent.RequestCancelledEvent{RequestID: "r1"}},
		{"process ended", agent.ProcessEndedEvent{}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store, _ := session.NewFileStore(t.TempDir())
			mock := &mockAgent{}
			m := NewManager(mockRegistry(mock), "/tmp", "", "", store, 10*time.Minute)
			defer m.Shutdown()

			rec := &stateRecorder{}
			m.SetOnStateChange(rec.record)

			proc, _, _ := m.GetOrCreateProcess(context.Background(), session.SessionMeta{ID: "sess-1", Activated: true, AgentType: session.AgentTypeClaude, Mode: session.ModeDefault})
			rec.waitForCount(t, 1) // initial idle
			rec.reset()

			mock.session(t, "sess-1").emit(t, tt.event)
			waitForHistory(t, store, "sess-1", 1)

			if state := proc.State(); state != ProcessStateIdle {
				t.Errorf("state = %q, want %q", state, ProcessStateIdle)
			}
			if events := rec.snapshot(); len(events) != 0 {
				t.Errorf("expected no state changes, got %v", events)
			}
		})
	}
}

// TestProcess_TurnStateTransitions locks the mapping from agent events to
// process state changes for a turn that has been started by a message.
func TestProcess_TurnStateTransitions(t *testing.T) {
	tests := []struct {
		name   string
		events []agent.AgentEvent
		want   []StateChangeEvent
	}{
		{
			name:   "done ends the turn",
			events: []agent.AgentEvent{agent.TextEvent{Content: "hi"}, agent.DoneEvent{}},
			want:   []StateChangeEvent{{State: ProcessStateIdle}},
		},
		{
			// A failed turn stops the agent exactly like a completed one, which
			// is what lets work.AutoResumer treat both as "the agent stopped".
			name:   "error ends the turn like done",
			events: []agent.AgentEvent{agent.ErrorEvent{Error: "is_error result"}},
			want:   []StateChangeEvent{{State: ProcessStateIdle}},
		},
		{
			name:   "permission request pauses the turn",
			events: []agent.AgentEvent{agent.PermissionRequestEvent{RequestID: "r1"}},
			want:   []StateChangeEvent{{State: ProcessStateIdle, NeedsInput: true}},
		},
		{
			// The permission prompt is gone with the turn, so the pause has to be
			// replaced by a stop; otherwise the session waits forever for an
			// answer to a question nobody can see anymore.
			name: "interrupt replaces a pending permission request",
			events: []agent.AgentEvent{
				agent.PermissionRequestEvent{RequestID: "r1"},
				agent.InterruptedEvent{},
			},
			want: []StateChangeEvent{
				{State: ProcessStateIdle, NeedsInput: true},
				{State: ProcessStateIdle, Interrupted: true},
			},
		},
		{
			// Codex answers an aborted call itself while Pockode synthesizes a
			// response for the same call, so both can arrive. A second stop would
			// look like a second turn ending to work.AutoResumer.
			name:   "a turn ends only once",
			events: []agent.AgentEvent{agent.InterruptedEvent{}, agent.DoneEvent{}},
			want:   []StateChangeEvent{{State: ProcessStateIdle, Interrupted: true}},
		},
		{
			// Claude reports which messages stay queued after an interrupt; their
			// output arrives with nothing on the send path to mark a new turn.
			name: "output queued behind an interrupt starts a new turn",
			events: []agent.AgentEvent{
				agent.InterruptedEvent{},
				agent.TextEvent{Content: "queued"},
				agent.DoneEvent{},
			},
			want: []StateChangeEvent{
				{State: ProcessStateIdle, Interrupted: true},
				{State: ProcessStateRunning},
				{State: ProcessStateIdle},
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store, _ := session.NewFileStore(t.TempDir())
			mock := &mockAgent{}
			m := NewManager(mockRegistry(mock), "/tmp", "", "", store, 10*time.Minute)
			defer m.Shutdown()

			rec := &stateRecorder{}
			m.SetOnStateChange(rec.record)

			proc, _, _ := m.GetOrCreateProcess(context.Background(), session.SessionMeta{ID: "sess-1", AgentType: session.AgentTypeClaude, Mode: session.ModeDefault})
			rec.waitForCount(t, 1) // initial idle
			if err := proc.SendMessage("go"); err != nil {
				t.Fatalf("SendMessage: %v", err)
			}
			rec.waitForCount(t, 2) // running
			rec.reset()

			for _, e := range tt.events {
				mock.session(t, "sess-1").emit(t, e)
			}
			rec.waitForCount(t, len(tt.want))
			// Let any surplus transition land before comparing.
			time.Sleep(20 * time.Millisecond)

			got := rec.snapshot()
			if len(got) != len(tt.want) {
				t.Fatalf("got %d state changes %v, want %d %v", len(got), got, len(tt.want), tt.want)
			}
			for i, want := range tt.want {
				want.SessionID = "sess-1"
				if got[i] != want {
					t.Errorf("state change %d = %+v, want %+v", i, got[i], want)
				}
			}
		})
	}
}

// TestProcess_ConsecutiveTurns covers what a single-turn test cannot: dropping
// the duplicate end of one turn must not also drop the next turn's transitions.
// Until this suite sent a second message no test could have caught that.
func TestProcess_ConsecutiveTurns(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	m := NewManager(mockRegistry(mock), "/tmp", "", "", store, 10*time.Minute)
	defer m.Shutdown()

	rec := &stateRecorder{}
	m.SetOnStateChange(rec.record)

	proc, _, _ := m.GetOrCreateProcess(context.Background(), session.SessionMeta{ID: "sess-1", AgentType: session.AgentTypeClaude, Mode: session.ModeDefault})
	rec.waitForCount(t, 1)
	rec.reset()

	// Turn 1: interrupted, then a duplicate end that must be dropped.
	if err := proc.SendMessage("first"); err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	mock.session(t, "sess-1").emit(t, agent.InterruptedEvent{})
	mock.session(t, "sess-1").emit(t, agent.DoneEvent{})
	// Both ends must be consumed before the next turn starts, or the duplicate
	// would land in turn 2 and stop measuring what this test is about.
	waitForHistory(t, store, "sess-1", 2)
	rec.waitForCount(t, 2)

	// Turn 2: a full cycle of its own.
	if err := proc.SendMessage("second"); err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	mock.session(t, "sess-1").emit(t, agent.TextEvent{Content: "working"})
	mock.session(t, "sess-1").emit(t, agent.DoneEvent{})
	rec.waitForCount(t, 4)
	time.Sleep(20 * time.Millisecond)

	want := []StateChangeEvent{
		{SessionID: "sess-1", State: ProcessStateRunning},
		{SessionID: "sess-1", State: ProcessStateIdle, Interrupted: true},
		{SessionID: "sess-1", State: ProcessStateRunning},
		{SessionID: "sess-1", State: ProcessStateIdle},
	}
	got := rec.snapshot()
	if len(got) != len(want) {
		t.Fatalf("got %d state changes %v, want %d %v", len(got), got, len(want), want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("state change %d = %+v, want %+v", i, got[i], want[i])
		}
	}
}

func TestManager_GetOrCreateProcess_NewSession(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	m := NewManager(mockRegistry(mock), "/tmp", "", "", store, 10*time.Minute)
	defer m.Shutdown()

	proc, created, err := m.GetOrCreateProcess(context.Background(), session.SessionMeta{ID: "sess-1", AgentType: session.AgentTypeClaude, Mode: session.ModeDefault})
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

	if _, _, err := m.GetOrCreateProcess(context.Background(), session.SessionMeta{ID: "sess-1", AgentType: session.AgentTypeClaude, Mode: session.ModeDefault}); err != nil {
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

	proc1, _, _ := m.GetOrCreateProcess(context.Background(), session.SessionMeta{ID: "sess-1", AgentType: session.AgentTypeClaude, Mode: session.ModeDefault})
	proc2, created, _ := m.GetOrCreateProcess(context.Background(), session.SessionMeta{ID: "sess-1", AgentType: session.AgentTypeClaude, Mode: session.ModeDefault})

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
	m := NewManager(mockRegistry(mock), "/tmp", "", "", store, idleTimeout)
	defer m.Shutdown()

	_, _, _ = m.GetOrCreateProcess(context.Background(), session.SessionMeta{ID: "sess-1", AgentType: session.AgentTypeClaude, Mode: session.ModeDefault})

	waitUntil(t, "process reaped", func() bool { return m.GetProcess("sess-1") == nil })

	if !mock.session(t, "sess-1").isClosed() {
		t.Error("expected process to be closed")
	}
}

// A background wait produces no events for as long as it lasts, so the reaper's
// only measure of liveness says the process is abandoned exactly when killing it
// would destroy the work being waited for.
func TestManager_IdleReaper_SparesABackgroundWait(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{startWaiting: true}
	idleTimeout := 50 * time.Millisecond
	m := NewManager(mockRegistry(mock), "/tmp", "", "", store, idleTimeout)
	defer m.Shutdown()

	_, _, _ = m.GetOrCreateProcess(context.Background(), session.SessionMeta{ID: "sess-1", AgentType: session.AgentTypeClaude, Mode: session.ModeDefault})
	sess := mock.session(t, "sess-1")

	// Long enough for several reaper passes to look at it and leave it alone.
	time.Sleep(4 * idleTimeout)
	if m.GetProcess("sess-1") == nil {
		t.Fatal("process reaped while it was waiting on background work")
	}

	// The exemption is not open-ended: once the agent stops waiting, the process
	// is reaped on the same stale timestamp it was spared on.
	sess.waitingForBackground.Store(false)
	waitUntil(t, "process reaped", func() bool { return m.GetProcess("sess-1") == nil })
}

func TestManager_IdleReaper_EmitsProcessStateEnded(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	idleTimeout := 50 * time.Millisecond
	m := NewManager(mockRegistry(mock), "/tmp", "", "", store, idleTimeout)
	defer m.Shutdown()

	rec := &stateRecorder{}
	m.SetOnStateChange(rec.record)

	_, _, _ = m.GetOrCreateProcess(context.Background(), session.SessionMeta{ID: "sess-1", AgentType: session.AgentTypeClaude, Mode: session.ModeDefault})

	// The ended state is emitted by the streamEvents goroutine after the reaper
	// closes the session, so it lands some time after the reap itself.
	waitUntil(t, "ended state change for sess-1", func() bool {
		for _, e := range rec.snapshot() {
			if e.SessionID == "sess-1" && e.State == ProcessStateEnded {
				return true
			}
		}
		return false
	})
}

// TestManager_ActivityRefreshesIdleClock covers why a busy session outlives the
// reaper: an explicit Touch and an event coming off the agent's stream both mark
// the process active. It asserts the timestamp rather than racing the reaper on
// the wall clock — a single history write can outlast a short idle timeout on a
// loaded machine, and the earlier form of these tests failed on that alone. That
// the reaper acts on the timestamp is TestManager_IdleReaper's job.
func TestManager_ActivityRefreshesIdleClock(t *testing.T) {
	tests := []struct {
		name string
		act  func(t *testing.T, m *Manager, mock *mockAgent, store session.Store)
	}{
		{
			name: "touch",
			act: func(t *testing.T, m *Manager, _ *mockAgent, _ session.Store) {
				m.Touch("sess-1")
			},
		},
		{
			name: "streamed event",
			act: func(t *testing.T, _ *Manager, mock *mockAgent, store session.Store) {
				mock.session(t, "sess-1").emit(t, agent.TextEvent{Content: "test"})
				waitForHistory(t, store, "sess-1", 1)
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store, _ := session.NewFileStore(t.TempDir())
			mock := &mockAgent{}
			m := NewManager(mockRegistry(mock), "/tmp", "", "", store, 10*time.Minute)
			defer m.Shutdown()

			proc, _, _ := m.GetOrCreateProcess(context.Background(), session.SessionMeta{ID: "sess-1", AgentType: session.AgentTypeClaude, Mode: session.ModeDefault})
			before := proc.getLastActive()

			time.Sleep(time.Millisecond) // ensure the clock has moved on
			tt.act(t, m, mock, store)

			if !proc.getLastActive().After(before) {
				t.Error("expected the activity to refresh the idle clock")
			}
		})
	}
}

func TestManager_Shutdown_ClosesAllProcesses(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	m := NewManager(mockRegistry(mock), "/tmp", "", "", store, 10*time.Minute)

	_, _, _ = m.GetOrCreateProcess(context.Background(), session.SessionMeta{ID: "sess-1", AgentType: session.AgentTypeClaude, Mode: session.ModeDefault})
	_, _, _ = m.GetOrCreateProcess(context.Background(), session.SessionMeta{ID: "sess-2", AgentType: session.AgentTypeClaude, Mode: session.ModeDefault})

	m.Shutdown()

	if !mock.session(t, "sess-1").isClosed() {
		t.Error("expected process for sess-1 to be closed")
	}
	if !mock.session(t, "sess-2").isClosed() {
		t.Error("expected process for sess-2 to be closed")
	}
	if m.GetProcess("sess-1") != nil {
		t.Error("expected process for sess-1 to be removed from manager")
	}
	if m.GetProcess("sess-2") != nil {
		t.Error("expected process for sess-2 to be removed from manager")
	}
}

// The store writes an ending process makes do not happen on the goroutine that
// calls Shutdown: SessionListWatcher writes needs_input and unread from the
// ended state change, which runs on the event stream's own goroutine. Shutdown
// has to outlast that, or a caller that tears the data directory down the moment
// it returns — every test using t.TempDir() — races those writes.
func TestManager_Shutdown_WaitsForTheEndedStateChange(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	m := NewManager(mockRegistry(mock), "/tmp", "", "", store, 10*time.Minute)

	var handled atomic.Bool
	m.SetOnStateChange(func(e StateChangeEvent) {
		if e.State != ProcessStateEnded {
			return
		}
		// Stands in for the writes the real listener makes here; without it the
		// assertion would hold whether or not Shutdown actually waits.
		time.Sleep(20 * time.Millisecond)
		handled.Store(true)
	})

	if _, _, err := m.GetOrCreateProcess(context.Background(), session.SessionMeta{ID: "sess-1", AgentType: session.AgentTypeClaude, Mode: session.ModeDefault}); err != nil {
		t.Fatalf("failed to create process: %v", err)
	}

	m.Shutdown()

	if !handled.Load() {
		t.Error("Shutdown returned while the ended state change was still running")
	}
}

// A manager that has been shut down has already stopped waiting for event
// streams, so it must not start another one.
func TestManager_GetOrCreateProcess_AfterShutdown(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	m := NewManager(mockRegistry(mock), "/tmp", "", "", store, 10*time.Minute)
	m.Shutdown()

	_, _, err := m.GetOrCreateProcess(context.Background(), session.SessionMeta{ID: "sess-1", AgentType: session.AgentTypeClaude, Mode: session.ModeDefault})
	if !errors.Is(err, ErrManagerClosed) {
		t.Errorf("expected ErrManagerClosed, got %v", err)
	}
	if m.HasProcess("sess-1") {
		t.Error("expected no process to be created after shutdown")
	}
}

func TestManager_Close_SpecificProcess(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	m := NewManager(mockRegistry(mock), "/tmp", "", "", store, 10*time.Minute)
	defer m.Shutdown()

	_, _, _ = m.GetOrCreateProcess(context.Background(), session.SessionMeta{ID: "sess-1", AgentType: session.AgentTypeClaude, Mode: session.ModeDefault})
	_, _, _ = m.GetOrCreateProcess(context.Background(), session.SessionMeta{ID: "sess-2", AgentType: session.AgentTypeClaude, Mode: session.ModeDefault})

	m.Close("sess-1")

	if !mock.session(t, "sess-1").isClosed() {
		t.Error("expected process for sess-1 to be closed")
	}
	if mock.session(t, "sess-2").isClosed() {
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
	_, _, _ = m.GetOrCreateProcess(context.Background(), session.SessionMeta{ID: "sess-1", AgentType: session.AgentTypeClaude, Mode: session.ModeDefault})

	if !m.HasProcess("sess-1") {
		t.Error("expected HasProcess to return true after process creation")
	}
}

func TestProcess_ClosedFlagSuppressesStateChanges(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	m := NewManager(mockRegistry(mock), "/tmp", "", "", store, 10*time.Minute)
	defer m.Shutdown()

	rec := &stateRecorder{}
	m.SetOnStateChange(rec.record)

	proc, _, _ := m.GetOrCreateProcess(context.Background(), session.SessionMeta{ID: "sess-1", AgentType: session.AgentTypeClaude, Mode: session.ModeDefault})

	// Close sets the closed flag, preventing further state changes.
	m.Close("sess-1")

	// Wait for the streamEvents goroutine to exit and emit ended.
	rec.waitForCount(t, 2) // initial idle + ended
	rec.reset()

	// After Close, SetRunning and SetIdle must be no-ops.
	proc.SetRunning()
	proc.SetIdle(false)

	if events := rec.snapshot(); len(events) != 0 {
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

	proc, _, _ := m.GetOrCreateProcess(context.Background(), session.SessionMeta{ID: "sess-1", AgentType: session.AgentTypeClaude, Mode: session.ModeDefault})

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

	proc, _, _ := m.GetOrCreateProcess(context.Background(), session.SessionMeta{ID: "sess-1", AgentType: session.AgentTypeClaude, Mode: session.ModeDefault})
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

	proc, _, _ := m.GetOrCreateProcess(context.Background(), session.SessionMeta{ID: "sess-1", AgentType: session.AgentTypeClaude, Mode: session.ModeDefault})

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

// TestProcess_ActivationFollowsAgentOutput covers what "activated" is supposed
// to mean. A first turn that dies before the agent says anything — expired
// login, provider outage — leaves a session that never really started; marking
// it activated would resume that non-existent conversation on the next message
// and lock the session to the agent type that just failed.
func TestProcess_ActivationFollowsAgentOutput(t *testing.T) {
	ctx := context.Background()
	store, _ := session.NewFileStore(t.TempDir())
	if _, err := store.Create(ctx, "sess-1", session.AgentTypeClaude, session.ModeDefault); err != nil {
		t.Fatalf("failed to create session: %v", err)
	}

	mock := &mockAgent{}
	m := NewManager(mockRegistry(mock), "/tmp", "", "", store, 10*time.Minute)
	defer m.Shutdown()

	if _, _, err := m.GetOrCreateProcess(ctx, session.SessionMeta{ID: "sess-1", AgentType: session.AgentTypeClaude, Mode: session.ModeDefault}); err != nil {
		t.Fatalf("failed to create process: %v", err)
	}

	// The whole of what a first message gets from Claude when the login has
	// expired or the endpoint is unreachable, in order: retry banners, the CLI's
	// own account of the failure, then a result flagged as an error (subtype
	// "success", is_error set — the flag is what counts). Two traps are buried
	// here — the banners are system events, which do mean a turn is under way but
	// not that the agent said anything, and the account of the failure arrives as
	// an assistant message, which the Claude parser has to keep off the text path
	// for it to reach this layer as a warning (see
	// claude.TestParseLine_FailedFirstTurnLeavesSessionSwitchable).
	sess := mock.session(t, "sess-1")
	sess.emit(t, agent.SystemEvent{Content: `{"subtype":"api_retry"}`})
	sess.emit(t, agent.WarningEvent{
		Message: "Invalid API key \u00b7 Fix external API key",
		Code:    "authentication_failed",
	})
	sess.emit(t, agent.ErrorEvent{Error: "Invalid API key \u00b7 Fix external API key"})
	waitForHistory(t, store, "sess-1", 3)

	if meta, _, _ := store.Get("sess-1"); meta.Activated {
		t.Error("a turn that produced no agent output should not activate the session")
	}

	sess.emit(t, agent.TextEvent{Content: "hi"})
	waitUntil(t, "the session to be activated", func() bool {
		meta, _, _ := store.Get("sess-1")
		return meta.Activated
	})
}
