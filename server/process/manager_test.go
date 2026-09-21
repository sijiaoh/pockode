package process

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/session"
)

// createSession registers a session the way the server does before it ever
// starts a process for one. A process has to have one: turn state is the
// session's own, so a process whose session is missing has nowhere to record
// what it is doing.
func createSession(t *testing.T, store session.Store, id string) session.SessionMeta {
	t.Helper()
	meta, err := store.Create(context.Background(), id, session.CreateSpec{
		AgentType: session.AgentTypeClaude,
		Mode:      session.ModeDefault,
	})
	if err != nil {
		t.Fatalf("failed to create session %q: %v", id, err)
	}
	return meta
}

// createActivatedSession is createSession for a session that has already run,
// which is what makes the manager resume it rather than start it fresh.
func createActivatedSession(t *testing.T, store session.Store, id string) session.SessionMeta {
	t.Helper()
	meta := createSession(t, store, id)
	if err := store.Activate(context.Background(), id); err != nil {
		t.Fatalf("failed to activate session %q: %v", id, err)
	}
	meta.Activated = true
	return meta
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
	worktree     string
	// onUsage is the callback the manager installed, so a test can report usage
	// the way the real CLI parsers do.
	onUsage func(session.UsageReport)
}

func (m *mockAgent) Start(ctx context.Context, opts agent.StartOptions) (agent.Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.startCalls = append(m.startCalls, startCall{opts.SessionID, opts.Resume, opts.Mode, opts.DataDir, opts.MCPServerDir, opts.Worktree, opts.OnUsage})

	if m.sessions == nil {
		m.sessions = make(map[string]*mockSession)
	}

	sess := &mockSession{
		events: make(chan agent.AgentEvent, 10),
	}
	m.sessions[opts.SessionID] = sess
	return sess, nil
}

// usageCallback returns the OnUsage the manager installed for sessionID, so a
// test can report usage the way the real CLI parsers do. Locked for the same
// reason session is: Start writes startCalls from the manager's goroutine.
func (m *mockAgent) usageCallback(t *testing.T, sessionID string) func(session.UsageReport) {
	t.Helper()
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, call := range m.startCalls {
		if call.sessionID == sessionID {
			return call.onUsage
		}
	}
	t.Fatalf("no agent started for %q", sessionID)
	return nil
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

	// interrupts and notes are what the lease reaper does to a CLI when a budget
	// runs out: it asks the turn to stop, and leaves the agent an explanation.
	interrupts atomic.Int32
	// answers counts the answers that actually reached the CLI, which is what a
	// refusal is measured against.
	answers atomic.Int32
	notesMu sync.Mutex
	notes   []string
}

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
	s.answers.Add(1)
	return nil
}
func (s *mockSession) SendInterrupt() error {
	s.interrupts.Add(1)
	return nil
}

// QueueNote makes the mock an agent.SessionNotifier, which Claude is and Codex
// is not; the lease reaper's note has to reach the one and be dropped by the
// other without either being a special case.
func (s *mockSession) QueueNote(note string) {
	s.notesMu.Lock()
	s.notes = append(s.notes, note)
	s.notesMu.Unlock()
}

func (s *mockSession) queuedNotes() []string {
	s.notesMu.Lock()
	defer s.notesMu.Unlock()
	return append([]string(nil), s.notes...)
}
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
// a session marked running with nothing running, which the work engine reads as
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
			m := NewManager(mockRegistry(mock), "", "/tmp", "", "", store, idleOnly(10*time.Minute))
			defer m.Shutdown()

			rec := &stateRecorder{}
			m.SetOnStateChange(rec.record)

			proc, _, _ := m.GetOrCreateProcess(context.Background(), createActivatedSession(t, store, "sess-1"))
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

// turnShape is what a session ends up saying after a scenario: the state change
// event is narrow by design — "is output being produced" and nothing else — so
// the facts the scenarios are about are asserted on the turn itself.
type turnShape struct {
	phase    session.TurnPhase
	outcome  session.TurnOutcome
	blockers int
}

func shapeOf(turn session.TurnState) turnShape {
	return turnShape{phase: turn.Phase, outcome: turn.LastOutcome, blockers: len(turn.Blockers)}
}

// TestProcess_TurnStateTransitions locks the mapping from agent events to a
// turn, and to the state changes it is narrowed to, for a turn that has been
// started by a message.
func TestProcess_TurnStateTransitions(t *testing.T) {
	tests := []struct {
		name     string
		events   []agent.AgentEvent
		want     []ProcessState
		wantTurn turnShape
	}{
		{
			name:     "done ends the turn",
			events:   []agent.AgentEvent{agent.TextEvent{Content: "hi"}, agent.DoneEvent{}},
			want:     []ProcessState{ProcessStateIdle},
			wantTurn: turnShape{phase: session.PhaseIdle, outcome: session.OutcomeCompleted},
		},
		{
			// A failed turn stops the agent exactly like a completed one, which
			// is what lets the work engine treat both as "the agent stopped".
			name:   "error ends the turn like done",
			events: []agent.AgentEvent{agent.ErrorEvent{Error: "is_error result"}},
			want:   []ProcessState{ProcessStateIdle},
			// Ended, but not the same ending: the outcome is what tells the work
			// engine a failed turn from a completed one, and both from an abort.
			wantTurn: turnShape{phase: session.PhaseIdle, outcome: session.OutcomeFailed},
		},
		{
			name:   "permission request pauses the turn",
			events: []agent.AgentEvent{agent.PermissionRequestEvent{RequestID: "r1"}},
			// Narrowed to idle — nothing is being produced, so the session goes
			// unread — while the turn itself says why, and that it is not over.
			want:     []ProcessState{ProcessStateIdle},
			wantTurn: turnShape{phase: session.PhaseBlocked, blockers: 1},
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
			want:     []ProcessState{ProcessStateIdle, ProcessStateIdle},
			wantTurn: turnShape{phase: session.PhaseIdle, outcome: session.OutcomeAborted},
		},
		{
			// Codex answers an aborted call itself while Pockode synthesizes a
			// response for the same call, so both can arrive. A second stop would
			// look like a second turn ending to the work engine.
			name:   "a turn ends only once",
			events: []agent.AgentEvent{agent.InterruptedEvent{}, agent.DoneEvent{}},
			want:   []ProcessState{ProcessStateIdle},
			// The second ending must not overwrite the first: an abort followed
			// by a done still reads as aborted, which is what stops the work
			// rather than nudging it.
			wantTurn: turnShape{phase: session.PhaseIdle, outcome: session.OutcomeAborted},
		},
		{
			// Parking a turn is not ending it: no idle reaches the wire until the
			// CLI has resumed and really finished. What ends the wait is checked
			// separately, because this wire cannot see it — parked and resumed are
			// both "running" here (TestProcess_OnlyContentEndsABackgroundWait).
			//
			// The two running entries are that narrowing showing through, not a
			// bug: emitTurn sends a real turn change even when the value it
			// narrows to repeats.
			name: "a parked turn is not an ended turn",
			events: []agent.AgentEvent{
				agent.BackgroundWaitEvent{},
				agent.TextEvent{Content: "resumed"},
				agent.DoneEvent{},
			},
			want:     []ProcessState{ProcessStateRunning, ProcessStateRunning, ProcessStateIdle},
			wantTurn: turnShape{phase: session.PhaseIdle, outcome: session.OutcomeCompleted},
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
			want:     []ProcessState{ProcessStateIdle, ProcessStateRunning, ProcessStateIdle},
			wantTurn: turnShape{phase: session.PhaseIdle, outcome: session.OutcomeCompleted},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store, _ := session.NewFileStore(t.TempDir())
			mock := &mockAgent{}
			m := NewManager(mockRegistry(mock), "", "/tmp", "", "", store, idleOnly(10*time.Minute))
			defer m.Shutdown()

			rec := &stateRecorder{}
			m.SetOnStateChange(rec.record)

			proc, _, _ := m.GetOrCreateProcess(context.Background(), createSession(t, store, "sess-1"))
			rec.waitForCount(t, 1) // initial idle
			if err := proc.SendMessage("go"); err != nil {
				t.Fatalf("SendMessage: %v", err)
			}
			rec.waitForCount(t, 2) // running
			rec.reset()

			for _, e := range tt.events {
				mock.session(t, "sess-1").emit(t, e)
			}
			// A barrier, not a delay. Every event above is persisted, events are
			// handled one at a time in order, and an event's state change is
			// announced before the next event's record is written — so the
			// barrier's own record existing means every announcement this
			// scenario will ever make has already been made. A warning is the
			// barrier because it is recorded and moves no turn, which is what
			// lets the count below be asserted exactly rather than waited for
			// and hoped about.
			mock.session(t, "sess-1").emit(t, agent.WarningEvent{Message: "barrier", Code: "test_barrier"})
			waitForHistory(t, store, "sess-1", len(tt.events)+1)

			got := rec.snapshot()
			if len(got) != len(tt.want) {
				t.Fatalf("got %d state changes %v, want %d %v", len(got), got, len(tt.want), tt.want)
			}
			for i, want := range tt.want {
				if got[i] != (StateChangeEvent{SessionID: "sess-1", State: want}) {
					t.Errorf("state change %d = %+v, want %q", i, got[i], want)
				}
			}
			if shape := shapeOf(proc.turnState()); shape != tt.wantTurn {
				t.Errorf("turn = %+v, want %+v", shape, tt.wantTurn)
			}
		})
	}
}

// TestProcess_OnlyContentEndsABackgroundWait drives the rule through the real
// event path, which is the only place it can be seen: the wire narrows parked
// and resumed to the same value, so what the wait is doing shows up in the one
// thing that reads the blockers — the lease the reaper holds the process on.
//
// The `system` frame matters specifically. The background task list changing is
// one, so counting it as the CLI resuming would make a task *finishing* look
// like the turn coming back, and the process would drop off the background lease
// that keeps the remaining tasks alive.
func TestProcess_OnlyContentEndsABackgroundWait(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	m := NewManager(mockRegistry(mock), "", "/tmp", "", "", store, idleOnly(10*time.Minute))
	defer m.Shutdown()

	proc, _, _ := m.GetOrCreateProcess(context.Background(), createSession(t, store, "sess-1"))
	sess := mock.session(t, "sess-1")

	if err := proc.SendMessage("go"); err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	sess.emit(t, agent.BackgroundWaitEvent{})
	waitUntil(t, "the turn to park", func() bool { return holdOf(proc) == session.LeaseBackground })

	// Two frames that show the turn is alive without proving the CLI came back.
	// The progress line goes first because it is never recorded: with the
	// recorded frame behind it, history reaching 2 means both have been reduced.
	sess.emit(t, agent.ToolActivityEvent{ToolUseID: "call-1", Activity: "still building"})
	sess.emit(t, agent.SystemEvent{Content: "background_tasks_changed"})
	waitForHistory(t, store, "sess-1", 2) // the park and the system frame
	if hold := holdOf(proc); hold != session.LeaseBackground {
		t.Fatalf("hold = %q, want the wait to still be on — neither frame is the CLI resuming", hold)
	}

	sess.emit(t, agent.TextEvent{Content: "resumed"})
	waitUntil(t, "the wait to end", func() bool { return holdOf(proc) == session.LeaseTurn })
}

// TestProcess_ConsecutiveTurns covers what a single-turn test cannot: dropping
// the duplicate end of one turn must not also drop the next turn's transitions.
// Until this suite sent a second message no test could have caught that.
func TestProcess_ConsecutiveTurns(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	m := NewManager(mockRegistry(mock), "", "/tmp", "", "", store, idleOnly(10*time.Minute))
	defer m.Shutdown()

	rec := &stateRecorder{}
	m.SetOnStateChange(rec.record)

	proc, _, _ := m.GetOrCreateProcess(context.Background(), createSession(t, store, "sess-1"))
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
		{SessionID: "sess-1", State: ProcessStateIdle},
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
	// The second turn's own ending, not the first one's leaking into it: an
	// abort carried over would read downstream as "do not carry on" and stop the
	// work the user had just started.
	if got := proc.turnState().LastOutcome; got != session.OutcomeCompleted {
		t.Errorf("last outcome = %q, want %q", got, session.OutcomeCompleted)
	}
}

func TestManager_GetOrCreateProcess_NewSession(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	m := NewManager(mockRegistry(mock), "", "/tmp", "", "", store, idleOnly(10*time.Minute))
	defer m.Shutdown()

	proc, created, err := m.GetOrCreateProcess(context.Background(), createSession(t, store, "sess-1"))
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
	m := NewManager(mockRegistry(mock), "", "/tmp", "/data/worktrees/feature-x", "/data", store, idleOnly(10*time.Minute))
	defer m.Shutdown()

	if _, _, err := m.GetOrCreateProcess(context.Background(), createSession(t, store, "sess-1")); err != nil {
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

// The worktree a manager serves is handed to every CLI it spawns: it is half of
// the identity the MCP proxy reports back, and nothing else in the spawn says
// where the session lives.
func TestManager_ForwardsWorktreeName(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	m := NewManager(mockRegistry(mock), "feature-x", "/tmp", "/data/worktrees/feature-x", "/data", store, idleOnly(10*time.Minute))
	defer m.Shutdown()

	if _, _, err := m.GetOrCreateProcess(context.Background(), createSession(t, store, "sess-1")); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got := mock.startCalls[0].worktree; got != "feature-x" {
		t.Errorf("Worktree = %q, want feature-x", got)
	}
}

func TestManager_GetOrCreateProcess_ExistingSession(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	m := NewManager(mockRegistry(mock), "", "/tmp", "", "", store, idleOnly(10*time.Minute))
	defer m.Shutdown()

	proc1, _, _ := m.GetOrCreateProcess(context.Background(), createSession(t, store, "sess-1"))
	proc2, created, _ := m.GetOrCreateProcess(context.Background(), createSession(t, store, "sess-1"))

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
// a test; reaping is driven explicitly through reapLeasesAsOf instead.
const testIdleTimeout = 10 * time.Minute

// holdOf names what is holding this process, which is what the reaper reads
// before it decides anything: the lease's kind, from the same table.
func holdOf(p *Process) session.LeaseKind {
	return p.manager.budgets.LeaseFor(p.turnState(), p.getLastActive()).Kind
}

// idleOnly budgets only the idle wait, which is what a test that is not about
// the lease table wants: a process is collected when nothing holds it, and every
// other wait is held until the session itself moves on. Tests that do exercise a
// budget name it themselves.
func idleOnly(timeout time.Duration) session.LeaseBudgets {
	return session.LeaseBudgets{Idle: timeout}
}

// awaitTimeout bounds waits for something that must happen. It is not a tuning
// knob: overshooting it means the transition never came, not that the machine
// was slow.
const awaitTimeout = 10 * time.Second

func TestManager_LeaseReaper(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	m := NewManager(mockRegistry(mock), "", "/tmp", "", "", store, idleOnly(testIdleTimeout))
	defer m.Shutdown()

	_, _, _ = m.GetOrCreateProcess(context.Background(), createSession(t, store, "sess-1"))

	m.reapLeasesAsOf(time.Now().Add(2 * testIdleTimeout))

	if m.GetProcess("sess-1") != nil {
		t.Error("expected process to be reaped")
	}
	if !mock.session(t, "sess-1").isClosed() {
		t.Error("expected process to be closed")
	}
}

// A zero budget means "no budget", and saying so takes a guard: taken literally
// it means the opposite, since every wait is older than a zero budget the moment
// it starts — and a table with nothing budgeted panics time.NewTicker on the
// way, which the reaper's own recover would turn into a silently dead goroutine
// rather than a crash anyone notices.
func TestManager_LeaseReaper_ZeroBudgetsTurnReapingOff(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	m := NewManager(mockRegistry(mock), "", "/tmp", "", "", store, idleOnly(0))
	defer m.Shutdown()

	_, _, _ = m.GetOrCreateProcess(context.Background(), createSession(t, store, "sess-1"))

	m.reapLeasesAsOf(time.Now().Add(100 * testIdleTimeout))
	if m.GetProcess("sess-1") == nil {
		t.Error("process reaped although a zero timeout turns reaping off")
	}

	// Run the loop on this goroutine: its recover swallows the ticker panic, so
	// the log is the only place the crash would surface.
	logged := captureLogs(t, m.runLeaseReaper)
	if strings.Contains(logged, "lease reaper crashed") {
		t.Errorf("lease reaper crashed on a table with no budgets:\n%s", logged)
	}
}

// captureLogs runs fn with the default logger redirected, and returns what it
// wrote. The panic logger writes through slog, so this is how a test sees a
// panic that was recovered.
func captureLogs(t *testing.T, fn func()) string {
	t.Helper()
	var sink lockedBuffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&sink, nil)))
	defer slog.SetDefault(previous)
	fn()
	return sink.String()
}

// lockedBuffer is captureLogs' sink. Redirecting the default logger redirects
// every goroutine's logging, not just fn's — the manager's own background
// goroutines keep writing throughout — so the sink has to tolerate writers the
// test never started.
type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// A background wait produces no events for as long as it lasts, so the idle
// row's measure of liveness calls the process abandoned exactly when collecting
// it would destroy the work being waited for. Its own row is what spares it.
func TestManager_LeaseReaper_SparesABackgroundWait(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	m := NewManager(mockRegistry(mock), "", "/tmp", "", "", store, idleOnly(testIdleTimeout))
	defer m.Shutdown()

	proc, _, _ := m.GetOrCreateProcess(context.Background(), createSession(t, store, "sess-1"))
	sess := mock.session(t, "sess-1")

	_ = proc.SendMessage("go")
	sess.emit(t, agent.BackgroundWaitEvent{})
	waitUntil(t, "the turn to park on background work", func() bool {
		return holdOf(proc) == session.LeaseBackground
	})

	overdue := time.Now().Add(2 * testIdleTimeout)
	m.reapLeasesAsOf(overdue)
	if m.GetProcess("sess-1") == nil {
		t.Fatal("process reaped while it was waiting on background work")
	}

	// The exemption is not open-ended: once the turn ends, the process is reaped
	// on the same stale timestamp it was spared on.
	sess.emit(t, agent.DoneEvent{})
	waitUntil(t, "the turn to end", func() bool { return holdOf(proc) == session.LeaseIdle })
	m.reapLeasesAsOf(overdue)
	if m.GetProcess("sess-1") != nil {
		t.Error("expected process to be reaped once the wait was over")
	}
}

func TestManager_LeaseReaper_EmitsProcessStateEnded(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	m := NewManager(mockRegistry(mock), "", "/tmp", "", "", store, idleOnly(testIdleTimeout))
	defer m.Shutdown()

	ended := make(chan string, 8)
	m.SetOnStateChange(func(e StateChangeEvent) {
		if e.State == ProcessStateEnded {
			ended <- e.SessionID
		}
	})

	_, _, _ = m.GetOrCreateProcess(context.Background(), createSession(t, store, "sess-1"))

	m.reapLeasesAsOf(time.Now().Add(2 * testIdleTimeout))

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
	m := NewManager(mockRegistry(mock), "", "/tmp", "", "", store, idleOnly(testIdleTimeout))
	defer m.Shutdown()

	proc, _, _ := m.GetOrCreateProcess(context.Background(), createSession(t, store, "sess-1"))

	// Start out already overdue, so Touch has to actually move the process out
	// of reaping range. Touching a freshly created process proves nothing: it
	// would survive the check below whether Touch did anything or not.
	backdate(proc, 2*testIdleTimeout)

	m.Touch("sess-1")
	m.reapLeasesAsOf(time.Now().Add(testIdleTimeout / 2))

	if m.GetProcess("sess-1") == nil {
		t.Fatal("expected process to still exist after touch")
	}
	if mock.session(t, "sess-1").isClosed() {
		t.Error("expected process to not be closed")
	}

	// And once that touch goes stale the process must be reaped again.
	m.reapLeasesAsOf(time.Now().Add(2 * testIdleTimeout))
	if m.GetProcess("sess-1") != nil {
		t.Error("expected process to be reaped once the touch went stale")
	}
}

func TestManager_Shutdown_ClosesAllProcesses(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	m := NewManager(mockRegistry(mock), "", "/tmp", "", "", store, idleOnly(10*time.Minute))

	_, _, _ = m.GetOrCreateProcess(context.Background(), createSession(t, store, "sess-1"))
	_, _, _ = m.GetOrCreateProcess(context.Background(), createSession(t, store, "sess-2"))

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

// Shutdown is the point after which the caller is entitled to tear down the
// data directory, so nothing may still be writing to it. Two things are still
// running when it is called: the streaming goroutine, which writes session
// history and flips session state while it drains events already buffered when
// the session closed, and the ended state change it emits on its way out —
// SessionListWatcher writes needs_input and unread from that, on the stream's
// own goroutine rather than on Shutdown's. A caller that tears the data
// directory down the moment Shutdown returns — every test using t.TempDir() —
// races both.
func TestManager_Shutdown_WaitsForStreamingToFinish(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	m := NewManager(mockRegistry(mock), "", "/tmp", "", "", store, idleOnly(testIdleTimeout))

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

	proc, _, err := m.GetOrCreateProcess(context.Background(), createSession(t, store, "sess-1"))
	if err != nil {
		t.Fatalf("failed to create process: %v", err)
	}

	// Give the goroutine real work left to do at shutdown: a closed channel
	// still yields what was buffered before it closed.
	for i := 0; i < 3; i++ {
		mock.session(t, "sess-1").emit(t, agent.TextEvent{Content: "buffered"})
	}

	m.Shutdown()

	select {
	case <-proc.done:
	default:
		t.Error("Shutdown returned while the session was still streaming")
	}
	if !handled.Load() {
		t.Error("Shutdown returned while the ended state change was still running")
	}
}

// A manager that has been shut down has already stopped waiting for event
// streams, so it must not start another one.
func TestManager_GetOrCreateProcess_AfterShutdown(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	m := NewManager(mockRegistry(mock), "", "/tmp", "", "", store, idleOnly(10*time.Minute))
	m.Shutdown()

	_, _, err := m.GetOrCreateProcess(context.Background(), createSession(t, store, "sess-1"))
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
	m := NewManager(mockRegistry(mock), "", "/tmp", "", "", store, idleOnly(10*time.Minute))
	defer m.Shutdown()

	_, _, _ = m.GetOrCreateProcess(context.Background(), createSession(t, store, "sess-1"))
	_, _, _ = m.GetOrCreateProcess(context.Background(), createSession(t, store, "sess-2"))

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
	m := NewManager(mockRegistry(mock), "", "/tmp", "", "", store, idleOnly(10*time.Minute))
	defer m.Shutdown()

	// No process initially
	if m.HasProcess("sess-1") {
		t.Error("expected HasProcess to return false before process creation")
	}

	// Create process
	_, _, _ = m.GetOrCreateProcess(context.Background(), createSession(t, store, "sess-1"))

	if !m.HasProcess("sess-1") {
		t.Error("expected HasProcess to return true after process creation")
	}
}

func TestManager_StreamingEvents_PreventsReaping(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	m := NewManager(mockRegistry(mock), "", "/tmp", "", "", store, idleOnly(testIdleTimeout))
	defer m.Shutdown()

	// streamEvents emits to the listener after touching the process, so the
	// listener is the point at which the event is known to have been counted as
	// activity. Sleeping instead would only guess at when that happened.
	seen := make(chan struct{}, 8)
	m.SetMessageListener(listenerFunc(func(ChatMessage) { seen <- struct{}{} }))

	proc, _, _ := m.GetOrCreateProcess(context.Background(), createSession(t, store, "sess-1"))

	// Same reason as in the Touch test: unless the process starts out overdue,
	// it survives the check below whether or not the event counted as activity.
	backdate(proc, 2*testIdleTimeout)

	mock.session(t, "sess-1").emit(t, agent.TextEvent{Content: "test"})
	select {
	case <-seen:
	case <-time.After(awaitTimeout):
		t.Fatal("timed out waiting for the event to be streamed")
	}

	m.reapLeasesAsOf(time.Now().Add(testIdleTimeout / 2))

	if m.GetProcess("sess-1") == nil {
		t.Fatal("expected process to still exist while streaming events")
	}
	if mock.session(t, "sess-1").isClosed() {
		t.Error("expected process to not be closed while streaming events")
	}

	// And once the turn those events belonged to is over, the process must be
	// reaped again. Ending it is not incidental: a stream going quiet mid-turn
	// is a process still working, and the reaper leaves that alone.
	mock.session(t, "sess-1").emit(t, agent.DoneEvent{})
	waitUntil(t, "the turn to end", func() bool { return holdOf(proc) == session.LeaseIdle })

	m.reapLeasesAsOf(time.Now().Add(2 * testIdleTimeout))
	if m.GetProcess("sess-1") != nil {
		t.Error("expected process to be reaped once the stream went quiet")
	}
}

func TestProcess_ClosedFlagSuppressesStateChanges(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	m := NewManager(mockRegistry(mock), "", "/tmp", "", "", store, idleOnly(10*time.Minute))
	defer m.Shutdown()

	rec := &stateRecorder{}
	m.SetOnStateChange(rec.record)

	proc, _, _ := m.GetOrCreateProcess(context.Background(), createSession(t, store, "sess-1"))

	// Close sets the closed flag, preventing further state changes.
	m.Close("sess-1")

	// Wait for the streamEvents goroutine to exit and emit ended.
	rec.waitForCount(t, 2) // initial idle + ended
	rec.reset()

	// After Close, nothing the send path reports may move the session.
	proc.startTurn()
	proc.answerPrompt("req-1")

	if events := rec.snapshot(); len(events) != 0 {
		t.Errorf("expected no state changes after Close, got %v", events)
	}
}

// A state change is news, not a heartbeat: a listener that hears "still running"
// once per event cannot tell a turn from a token.
func TestProcess_EmitsOnlyRealTurnChanges(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	m := NewManager(mockRegistry(mock), "", "/tmp", "", "", store, idleOnly(10*time.Minute))
	defer m.Shutdown()

	rec := &stateRecorder{}
	m.SetOnStateChange(rec.record)

	proc, _, _ := m.GetOrCreateProcess(context.Background(), createSession(t, store, "sess-1"))
	sess := mock.session(t, "sess-1")

	rec.waitForCount(t, 1)
	if events := rec.snapshot(); events[0].State != ProcessStateIdle {
		t.Fatalf("expected the initial idle event, got %v", events)
	}
	rec.reset()

	proc.startTurn()
	rec.waitForCount(t, 1)
	if events := rec.snapshot(); events[0].State != ProcessStateRunning {
		t.Fatalf("expected a running event, got %v", events)
	}
	rec.reset()

	// Output during a running turn says nothing the prompt did not. The ending
	// behind it is what proves they were processed: events are reduced in order
	// on one goroutine, so the idle below cannot arrive before they have been.
	sess.emit(t, agent.TextEvent{Content: "working"})
	sess.emit(t, agent.TextEvent{Content: "still working"})
	sess.emit(t, agent.DoneEvent{})
	rec.waitForCount(t, 1)
	events := rec.snapshot()
	if len(events) != 1 {
		t.Fatalf("expected the ending to be the only state change, got %v", events)
	}
	if events[0].State != ProcessStateIdle {
		t.Errorf("expected an idle event for a completed turn, got %v", events)
	}
	if got := proc.turnState().LastOutcome; got != session.OutcomeCompleted {
		t.Errorf("last outcome = %q, want %q — a completed turn is not an abort", got, session.OutcomeCompleted)
	}
	rec.reset()

	// Codex announces the same ending twice; the second says nothing new.
	// Observed through history, which is written after the turn is reduced.
	sess.emit(t, agent.DoneEvent{})
	waitForHistory(t, store, "sess-1", 4)
	if events := rec.snapshot(); len(events) != 0 {
		t.Errorf("expected no state change for a repeated ending, got %v", events)
	}
}

// An interrupt is recorded as an abort on the turn, because a turn that was
// taken away must not be carried on from — that outcome is what the work engine
// reads to stop the work rather than nudge it.
func TestProcess_InterruptEndsTheTurnAsAborted(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	m := NewManager(mockRegistry(mock), "", "/tmp", "", "", store, idleOnly(10*time.Minute))
	defer m.Shutdown()

	rec := &stateRecorder{}
	m.SetOnStateChange(rec.record)

	proc, _, _ := m.GetOrCreateProcess(context.Background(), createSession(t, store, "sess-1"))
	sess := mock.session(t, "sess-1")

	proc.startTurn()
	rec.waitForCount(t, 2)
	rec.reset()

	sess.emit(t, agent.InterruptedEvent{})
	rec.waitForCount(t, 1)
	if events := rec.snapshot(); events[0].State != ProcessStateIdle {
		t.Errorf("expected an idle event, got %v", events)
	}
	if got := shapeOf(proc.turnState()); got != (turnShape{phase: session.PhaseIdle, outcome: session.OutcomeAborted}) {
		t.Errorf("turn = %+v, want an aborted, ended turn", got)
	}
}

func TestProcess_SendMessage_StartsTheTurn(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	m := NewManager(mockRegistry(mock), "", "/tmp", "", "", store, idleOnly(10*time.Minute))
	defer m.Shutdown()

	var events []StateChangeEvent
	m.SetOnStateChange(func(e StateChangeEvent) {
		events = append(events, e)
	})

	proc, _, _ := m.GetOrCreateProcess(context.Background(), createSession(t, store, "sess-1"))

	if proc.State() != ProcessStateIdle {
		t.Fatalf("expected initial state to be idle")
	}

	_ = proc.SendMessage("hello")

	if proc.State() != ProcessStateRunning {
		t.Errorf("expected state to be running after SendMessage")
	}
	if holdOf(proc) != session.LeaseTurn {
		t.Errorf("a turn that has started is a turn the reaper must not interrupt, got %q", holdOf(proc))
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

// TestProcess_ActivationFollowsAgentOutput covers what "activated" is supposed
// to mean. A first turn that dies before the agent says anything — expired
// login, provider outage — leaves a session that never really started; marking
// it activated would resume that non-existent conversation on the next message
// and lock the session to the agent type that just failed.
func TestProcess_ActivationFollowsAgentOutput(t *testing.T) {
	ctx := context.Background()
	store, _ := session.NewFileStore(t.TempDir())
	if _, err := store.Create(ctx, "sess-1", session.CreateSpec{AgentType: session.AgentTypeClaude, Mode: session.ModeDefault}); err != nil {
		t.Fatalf("failed to create session: %v", err)
	}

	mock := &mockAgent{}
	m := NewManager(mockRegistry(mock), "", "/tmp", "", "", store, idleOnly(10*time.Minute))
	defer m.Shutdown()

	if _, _, err := m.GetOrCreateProcess(ctx, createSession(t, store, "sess-1")); err != nil {
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

// TestForkAgentSession_AgentThatCannotFork: asked to fork an agent that
// implements no agent.SessionForker — a caller that skipped ForkSupport — the
// manager reports it rather than answering "carried nothing". Staying quiet would
// hand the user a fork whose agent was never consulted, told apart from one that
// was consulted and could not help by nothing at all.
func TestForkAgentSession_AgentThatCannotFork(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	registry := agent.NewRegistry()
	registry.Register(session.AgentTypeClaude, &mockAgent{})
	m := NewManager(registry, "", t.TempDir(), t.TempDir(), "", store, session.LeaseBudgets{Idle: time.Minute})
	defer m.Shutdown()

	carried, err := m.ForkAgentSession(context.Background(), session.AgentTypeClaude, agent.ForkOptions{})
	if err == nil {
		t.Fatal("a declaration with nothing behind it was accepted silently")
	}
	if carried {
		t.Error("carried = true on a failure")
	}
}

// TestManager_LeaseReaper_SparesATurnInProgress is the reaper's most expensive
// mistake to make. A turn can run for minutes without producing a single event —
// one Bash call around a build or a test suite is enough — and lastActive cannot
// tell that apart from a session nobody came back to. Collecting it kills the
// build and throws away the turn, so the turn has to report that it ended before
// the idle row is allowed to mean anything.
func TestManager_LeaseReaper_SparesATurnInProgress(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	m := NewManager(mockRegistry(mock), "", "/tmp", "", "", store, idleOnly(testIdleTimeout))
	defer m.Shutdown()

	proc, _, _ := m.GetOrCreateProcess(context.Background(), createSession(t, store, "sess-1"))
	sess := mock.session(t, "sess-1")

	if err := proc.SendMessage("run the build"); err != nil {
		t.Fatalf("failed to send the message that starts the turn: %v", err)
	}

	// No events at all from here on: that is exactly what a long tool call looks
	// like from outside, and how long it lasts is not the reaper's business.
	m.reapLeasesAsOf(time.Now().Add(100 * testIdleTimeout))
	if m.GetProcess("sess-1") == nil {
		t.Fatal("process reaped while its turn was still running")
	}

	// The turn ending is what hands the process back to the clock.
	sess.emit(t, agent.DoneEvent{})
	waitUntil(t, "the turn to end", func() bool { return holdOf(proc) == session.LeaseIdle })

	m.reapLeasesAsOf(time.Now().Add(2 * testIdleTimeout))
	if m.GetProcess("sess-1") != nil {
		t.Error("expected process to be reaped once the turn had ended and gone quiet")
	}
}

// TestManager_LeaseReaper_SparesAnUnansweredPrompt pins the two halves of
// "waiting for a person is not being idle": the pause survives any amount of
// elapsed time, and it ends when the person answers.
//
// One prompt type, because a permission request is the only thing left that
// holds a turn open waiting for a person. A question an agent posts does not:
// the agent went on working and the answer arrives as a message.
func TestManager_LeaseReaper_SparesAnUnansweredPrompt(t *testing.T) {
	prompts := map[string]agent.AgentEvent{
		"permission": agent.PermissionRequestEvent{RequestID: "req-1", ToolName: "Bash", ToolUseID: "tool-1"},
	}

	for name, prompt := range prompts {
		t.Run(name, func(t *testing.T) {
			store, _ := session.NewFileStore(t.TempDir())
			mock := &mockAgent{}
			m := NewManager(mockRegistry(mock), "", "/tmp", "", "", store, idleOnly(testIdleTimeout))
			defer m.Shutdown()

			proc, _, _ := m.GetOrCreateProcess(context.Background(), createSession(t, store, "sess-1"))
			sess := mock.session(t, "sess-1")

			// A prompt is something an agent raises mid-turn, so the turn has to
			// be under way for the pause to mean anything.
			if err := proc.SendMessage("do something"); err != nil {
				t.Fatalf("failed to send the message that starts the turn: %v", err)
			}
			sess.emit(t, prompt)
			waitUntil(t, "the turn to pause on the prompt", func() bool {
				return holdOf(proc) == session.LeaseAnswer
			})

			// However long the user takes: the prompt is on screen and still
			// answerable, so the process behind it has to still be there.
			m.reapLeasesAsOf(time.Now().Add(100 * testIdleTimeout))
			if m.GetProcess("sess-1") == nil {
				t.Fatal("process reaped while a prompt was waiting to be answered")
			}

			answer(t, proc, prompt)
			waitUntil(t, "the turn to resume", func() bool { return proc.State() == ProcessStateRunning })

			// Answering hands the process to the next hold, not to the clock:
			// the turn resumes, and a resumed turn is not reapable either. It
			// has to be that hold and not the prompt's, or the session goes on
			// reporting a wait on a person who has already answered.
			if hold := holdOf(proc); hold != session.LeaseTurn {
				t.Errorf("hold after answering = %q, want %q", hold, session.LeaseTurn)
			}

			// And with the prompt gone, nothing but the ordinary clock is left:
			// once the turn the answer resumed is over and has gone quiet, the
			// process is reaped like any other.
			sess.emit(t, agent.DoneEvent{})
			waitUntil(t, "the turn to end", func() bool { return holdOf(proc) == session.LeaseIdle })

			m.reapLeasesAsOf(time.Now().Add(2 * testIdleTimeout))
			if m.GetProcess("sess-1") != nil {
				t.Error("expected process to be reaped once the answered turn went quiet")
			}
		})
	}
}

// answer replies to a prompt the way chat.Client does, through the process
// method that matches it — including the Touch that counts the reply as
// activity.
func answer(t *testing.T, p *Process, prompt agent.AgentEvent) {
	t.Helper()
	p.manager.Touch(p.sessionID)
	var err error
	switch prompt.(type) {
	case agent.PermissionRequestEvent:
		err = p.SendPermissionResponse(agent.PermissionRequestData{RequestID: "req-1"}, agent.PermissionAllow)
	default:
		t.Fatalf("no answer for prompt %T", prompt)
	}
	if err != nil {
		t.Fatalf("failed to answer the prompt: %v", err)
	}
}

// TestManager_LeaseReaper_DropsThePromptHoldWhenNobodyCanAnswer covers the two
// ways a prompt stops waiting on the user without being answered. Neither may
// leave the hold behind: a process still on the answer lease for a prompt that
// no longer exists is waiting out a budget for nothing, and when that budget runs
// out it withdraws a request nobody is holding.
//
// The assertion is on the hold rather than on collection, because the two endings
// differ in what they leave behind and because every way of driving the reaper
// to a decision here — ending the turn — clears the same hold under test.
func TestManager_LeaseReaper_DropsThePromptHoldWhenNobodyCanAnswer(t *testing.T) {
	// Withdrawal is the case this exists for. The turn keeps running through it,
	// so no idle follows to end the wait, and the turn is what holds the process
	// afterwards. An interrupt ends the turn outright and leaves nothing.
	endings := map[string]struct {
		event     agent.AgentEvent
		holdAfter session.LeaseKind
	}{
		"the agent withdraws it": {agent.RequestCancelledEvent{RequestID: "req-1"}, session.LeaseTurn},
		"the user interrupts":    {agent.InterruptedEvent{}, session.LeaseIdle},
	}

	for name, ending := range endings {
		t.Run(name, func(t *testing.T) {
			store, _ := session.NewFileStore(t.TempDir())
			mock := &mockAgent{}
			m := NewManager(mockRegistry(mock), "", "/tmp", "", "", store, idleOnly(testIdleTimeout))
			defer m.Shutdown()

			proc, _, _ := m.GetOrCreateProcess(context.Background(), createSession(t, store, "sess-1"))
			sess := mock.session(t, "sess-1")

			if err := proc.SendMessage("do something"); err != nil {
				t.Fatalf("failed to send the message that starts the turn: %v", err)
			}
			sess.emit(t, agent.PermissionRequestEvent{RequestID: "req-1", ToolName: "Bash", ToolUseID: "tool-1"})
			waitUntil(t, "the turn to pause on the prompt", func() bool {
				return holdOf(proc) == session.LeaseAnswer
			})

			sess.emit(t, ending.event)
			waitUntil(t, "the prompt to stop holding the process", func() bool {
				return holdOf(proc) == ending.holdAfter
			})
		})
	}
}

// A second prompt raised while the turn is still paused says nothing new
// downstream, so the state change is suppressed — but the wait it creates is
// real. Reached by withdrawing the first prompt and asking for something else
// without the turn resuming in between.
func TestManager_LeaseReaper_SparesAPromptRaisedWhileAlreadyPaused(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	m := NewManager(mockRegistry(mock), "", "/tmp", "", "", store, idleOnly(testIdleTimeout))
	defer m.Shutdown()

	proc, _, _ := m.GetOrCreateProcess(context.Background(), createSession(t, store, "sess-1"))
	sess := mock.session(t, "sess-1")

	if err := proc.SendMessage("do something"); err != nil {
		t.Fatalf("failed to send the message that starts the turn: %v", err)
	}
	sess.emit(t, agent.PermissionRequestEvent{RequestID: "req-1", ToolName: "Bash", ToolUseID: "tool-1"})
	waitUntil(t, "the turn to pause on the first prompt", func() bool {
		return holdOf(proc) == session.LeaseAnswer
	})

	sess.emit(t, agent.RequestCancelledEvent{RequestID: "req-1"})
	waitUntil(t, "the first prompt to stop holding the process", func() bool {
		return holdOf(proc) != session.LeaseAnswer
	})

	sess.emit(t, agent.PermissionRequestEvent{RequestID: "req-2", ToolName: "Bash", ToolUseID: "tool-2"})
	waitUntil(t, "the turn to pause on the second prompt", func() bool {
		return holdOf(proc) == session.LeaseAnswer
	})

	m.reapLeasesAsOf(time.Now().Add(2 * testIdleTimeout))
	if m.GetProcess("sess-1") == nil {
		t.Error("process reaped while a second prompt was waiting to be answered")
	}
}

// A prompt does not always pause a turn: one raised after the turn has already
// reported its end leaves an answer outstanding with no turn behind it. That is
// the only state in which the prompt hold is the sole thing keeping the process
// alive — everywhere else the turn hold would cover for it — so it is the state
// that decides whether that hold is a real check or just a nicer log line.
func TestManager_LeaseReaper_SparesAPromptRaisedAfterTheTurnEnded(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	m := NewManager(mockRegistry(mock), "", "/tmp", "", "", store, idleOnly(testIdleTimeout))
	defer m.Shutdown()

	proc, _, _ := m.GetOrCreateProcess(context.Background(), createSession(t, store, "sess-1"))
	sess := mock.session(t, "sess-1")

	if err := proc.SendMessage("do something"); err != nil {
		t.Fatalf("failed to send the message that starts the turn: %v", err)
	}
	// The turn ends first, which is what makes this case different: from here on
	// nothing is in progress.
	sess.emit(t, agent.DoneEvent{})
	waitUntil(t, "the turn to end", func() bool { return holdOf(proc) == session.LeaseIdle })

	sess.emit(t, agent.PermissionRequestEvent{RequestID: "req-1", ToolName: "Bash", ToolUseID: "tool-1"})
	// Waited on through the flag rather than through reapHold, so that the
	// assertion below is what reports a missing hold. Waiting for the hold's
	// *name* would time out first and pin only the label, which is how the rest
	// of these tests miss the one consequence that costs a session.
	waitUntil(t, "the prompt to register", func() bool { return proc.turnState().AwaitingUserAnswer() })
	if proc.turnState().Phase == session.PhaseRunning {
		t.Fatal("precondition: no turn may be in progress, or the turn hold would cover for the prompt hold")
	}

	m.reapLeasesAsOf(time.Now().Add(100 * testIdleTimeout))
	if m.GetProcess("sess-1") == nil {
		t.Error("process reaped although a prompt was still waiting to be answered")
	}
}
