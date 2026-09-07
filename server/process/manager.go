package process

import (
	"context"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/logger"
	"github.com/pockode/server/session"
)

type ProcessState string

const (
	ProcessStateIdle    ProcessState = "idle"    // Process alive, waiting for user input
	ProcessStateRunning ProcessState = "running" // AI is generating a response
	ProcessStateEnded   ProcessState = "ended"   // Process has ended (not in map)
)

type StateChangeEvent struct {
	SessionID   string
	State       ProcessState
	NeedsInput  bool
	IsInitial   bool // true only for the initial idle emitted on process creation
	Interrupted bool // true when idle is caused by user interrupt
}

// Manager manages agent processes.
type Manager struct {
	agents  *agent.Registry
	workDir string
	// dataDir is this worktree's own data dir; agent session-scoped state (resume
	// mapping, history) lives here, alongside sessionStore.
	dataDir string
	// mcpServerDir is where the running server publishes server.json for the MCP
	// proxy to discover. Single server per process, so this is always the main
	// data dir, even for a named worktree whose dataDir differs.
	mcpServerDir string
	sessionStore session.Store
	idleTimeout  time.Duration

	processesMu sync.Mutex
	processes   map[string]*Process

	// Message listener (ChatMessagesWatcher)
	messageListener ChatMessageListener

	// Called when a process ends (for cleanup coordination)
	onProcessEnd func()

	// Called when process running state changes
	onStateChange func(StateChangeEvent)

	ctx    context.Context
	cancel context.CancelFunc
}

// Process holds a running agent process. Do not cache references.
type Process struct {
	sessionID    string
	agentSession agent.Session
	sessionStore session.Store
	manager      *Manager // back-reference for broadcasting to subscribers

	mu         sync.Mutex
	lastActive time.Time
	state      ProcessState
	// turnEnded says whether the last idle this process reported ended a turn,
	// as opposed to pausing it for a permission or question answer. Only
	// meaningful while state is idle. Guarded by mu; see setIdle.
	turnEnded bool
	// closed is set when the process is explicitly terminated (Close/Shutdown/reap).
	// Prevents stale buffered events from emitting state changes (e.g. running/idle)
	// that would incorrectly interact with the AutoResumer.
	closed atomic.Bool
	// activated mirrors the session's Activated flag so the store is written once,
	// on the transition, rather than on every event the agent produces.
	activated atomic.Bool
}

// NewManager creates a new manager with the given idle timeout. dataDir is this
// worktree's own data dir (session-scoped agent state); mcpServerDir is where the
// server publishes server.json for the MCP proxy (the main data dir).
func NewManager(agents *agent.Registry, workDir, dataDir, mcpServerDir string, store session.Store, idleTimeout time.Duration) *Manager {
	ctx, cancel := context.WithCancel(context.Background())
	m := &Manager{
		agents:       agents,
		workDir:      workDir,
		dataDir:      dataDir,
		mcpServerDir: mcpServerDir,
		sessionStore: store,
		idleTimeout:  idleTimeout,
		processes:    make(map[string]*Process),
		ctx:          ctx,
		cancel:       cancel,
	}
	go m.runIdleReaper()
	return m
}

// SetMessageListener sets the listener for chat messages.
func (m *Manager) SetMessageListener(l ChatMessageListener) {
	m.messageListener = l
}

func (m *Manager) SetOnStateChange(fn func(StateChangeEvent)) {
	m.onStateChange = fn
}

func (m *Manager) emitStateChange(sessionID string, state ProcessState, needsInput bool) {
	if m.onStateChange != nil {
		m.onStateChange(StateChangeEvent{SessionID: sessionID, State: state, NeedsInput: needsInput})
	}
}

func (m *Manager) emitStateChangeEvent(e StateChangeEvent) {
	if m.onStateChange != nil {
		m.onStateChange(e)
	}
}

// EmitMessage sends a message to the listener.
func (m *Manager) EmitMessage(sessionID string, event agent.AgentEvent) {
	if m.messageListener != nil {
		m.messageListener.OnChatMessage(ChatMessage{
			SessionID: sessionID,
			Event:     event,
		})
	}
}

// GetOrCreateProcess returns an existing process or creates a new one.
func (m *Manager) GetOrCreateProcess(ctx context.Context, sessionID string, resume bool, agentType session.AgentType, mode session.Mode) (*Process, bool, error) {
	m.processesMu.Lock()

	if proc, exists := m.processes[sessionID]; exists {
		proc.touch()
		m.processesMu.Unlock()
		return proc, false, nil
	}

	ag, err := m.agents.Get(agentType)
	if err != nil {
		m.processesMu.Unlock()
		return nil, false, err
	}

	// Use manager's context for process lifecycle, not request context
	opts := agent.StartOptions{
		WorkDir:      m.workDir,
		DataDir:      m.dataDir,
		MCPServerDir: m.mcpServerDir,
		SessionID:    sessionID,
		Resume:       resume,
		Mode:         mode,
	}
	sess, err := ag.Start(m.ctx, opts)
	if err != nil {
		m.processesMu.Unlock()
		return nil, false, err
	}

	proc := &Process{
		sessionID:    sessionID,
		agentSession: sess,
		sessionStore: m.sessionStore,
		manager:      m,
		lastActive:   time.Now(),
		state:        ProcessStateIdle,
		turnEnded:    true, // no turn has started yet
	}
	// resume is the session's Activated flag, so an already activated session
	// starts out knowing it has nothing to record.
	proc.activated.Store(resume)
	m.processes[sessionID] = proc

	go func() {
		defer func() {
			if r := recover(); r != nil {
				logger.LogPanic(r, "session crashed", "sessionId", sessionID)
			}
			m.remove(sessionID)
			m.emitStateChange(sessionID, ProcessStateEnded, false)
			slog.Info("process ended", "sessionId", sessionID)
		}()
		proc.streamEvents(m.ctx)
	}()

	m.processesMu.Unlock()

	// Emit after releasing processesMu — callbacks may acquire it.
	if m.onStateChange != nil {
		m.onStateChange(StateChangeEvent{SessionID: sessionID, State: ProcessStateIdle, IsInitial: true})
	}
	slog.Info("process created", "sessionId", sessionID, "resume", resume, "agentType", agentType, "mode", mode)
	return proc, true, nil
}

// GetProcess returns an existing process or nil.
// Use this to check if a process is running without creating one.
func (m *Manager) GetProcess(sessionID string) *Process {
	m.processesMu.Lock()
	defer m.processesMu.Unlock()
	return m.processes[sessionID]
}

// HasProcess returns whether a process exists for the given session.
func (m *Manager) HasProcess(sessionID string) bool {
	return m.GetProcess(sessionID) != nil
}

// GetProcessState returns the state of a process for the given session.
// Returns "ended" if no process exists.
func (m *Manager) GetProcessState(sessionID string) string {
	proc := m.GetProcess(sessionID)
	if proc == nil {
		return string(ProcessStateEnded)
	}
	return string(proc.State())
}

// ProcessCount returns the number of running processes.
func (m *Manager) ProcessCount() int {
	m.processesMu.Lock()
	defer m.processesMu.Unlock()
	return len(m.processes)
}

// SetOnProcessEnd sets a callback to be called when any process ends.
func (m *Manager) SetOnProcessEnd(callback func()) {
	m.processesMu.Lock()
	defer m.processesMu.Unlock()
	m.onProcessEnd = callback
}

// Touch updates the process's last active time.
func (m *Manager) Touch(sessionID string) {
	m.processesMu.Lock()
	defer m.processesMu.Unlock()
	if proc, exists := m.processes[sessionID]; exists {
		proc.touch()
	}
}

// remove removes a process from the manager and returns it.
// The onProcessEnd callback is invoked asynchronously after removal.
func (m *Manager) remove(sessionID string) *Process {
	m.processesMu.Lock()
	proc := m.processes[sessionID]
	delete(m.processes, sessionID)
	callback := m.onProcessEnd
	m.processesMu.Unlock()

	if callback != nil {
		go callback()
	}
	return proc
}

// removeWhere removes processes matching the predicate and returns them.
func (m *Manager) removeWhere(predicate func(*Process) bool) []*Process {
	m.processesMu.Lock()
	defer m.processesMu.Unlock()

	var removed []*Process
	for sessionID, proc := range m.processes {
		if predicate(proc) {
			removed = append(removed, proc)
			delete(m.processes, sessionID)
		}
	}
	return removed
}

// Close terminates a specific process.
func (m *Manager) Close(sessionID string) {
	if proc := m.remove(sessionID); proc != nil {
		proc.closed.Store(true)
		proc.agentSession.Close()
		slog.Info("process closed", "sessionId", sessionID)
	}
}

// Shutdown closes all processes gracefully.
func (m *Manager) Shutdown() {
	m.cancel()
	procs := m.removeWhere(func(*Process) bool { return true })
	for _, p := range procs {
		p.closed.Store(true)
		p.agentSession.Close()
	}
	slog.Info("manager shutdown complete", "processesClosed", len(procs))
}

func (m *Manager) runIdleReaper() {
	defer func() {
		if r := recover(); r != nil {
			logger.LogPanic(r, "idle reaper crashed")
		}
	}()

	ticker := time.NewTicker(m.idleTimeout / 4)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			m.reapIdle()
		case <-m.ctx.Done():
			return
		}
	}
}

func (m *Manager) reapIdle() {
	now := time.Now()
	procs := m.removeWhere(func(p *Process) bool {
		if now.Sub(p.getLastActive()) <= m.idleTimeout {
			return false
		}
		// A process waiting on background work looks exactly like an abandoned
		// one — that is the whole problem, since the wait produces no events to
		// refresh lastActive. Reaping it would kill the background tasks the
		// session is waiting for, so it is spared until the agent gives up on
		// them (see agent.BackgroundWaiter).
		if p.waitingForBackgroundWork() {
			slog.Debug("idle process spared, waiting on background work", "sessionId", p.sessionID)
			return false
		}
		return true
	})
	for _, proc := range procs {
		proc.closed.Store(true)
		proc.agentSession.Close()
		// ProcessStateEnded is emitted by the streamEvents goroutine's defer
		// when the events channel closes — no need to emit here.
		slog.Info("idle process reaped", "sessionId", proc.sessionID)
	}
}

// SendMessage sends a message to the agent and sets running state.
func (p *Process) SendMessage(prompt string) error {
	p.SetRunning()
	return p.agentSession.SendMessage(prompt)
}

// SendPermissionResponse sends a permission response and sets running state.
func (p *Process) SendPermissionResponse(data agent.PermissionRequestData, choice agent.PermissionChoice) error {
	p.SetRunning()
	return p.agentSession.SendPermissionResponse(data, choice)
}

// SendQuestionResponse sends a question response and sets running state.
func (p *Process) SendQuestionResponse(data agent.QuestionRequestData, answers map[string]string) error {
	p.SetRunning()
	return p.agentSession.SendQuestionResponse(data, answers)
}

// SendInterrupt sends an interrupt signal to the agent.
func (p *Process) SendInterrupt() error {
	return p.agentSession.SendInterrupt()
}

func (p *Process) waitingForBackgroundWork() bool {
	waiter, ok := p.agentSession.(agent.BackgroundWaiter)
	return ok && waiter.WaitingForBackgroundWork()
}

func (p *Process) touch() {
	p.mu.Lock()
	p.lastActive = time.Now()
	p.mu.Unlock()
}

func (p *Process) getLastActive() time.Time {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.lastActive
}

func (p *Process) State() ProcessState {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.state
}

// SetRunning transitions the process to running state and notifies subscribers.
func (p *Process) SetRunning() {
	if p.closed.Load() {
		return
	}

	p.mu.Lock()
	if p.state == ProcessStateRunning {
		p.mu.Unlock()
		return
	}
	p.state = ProcessStateRunning
	p.mu.Unlock()

	p.manager.emitStateChange(p.sessionID, ProcessStateRunning, false)
}

// SetIdle transitions the process to idle state and notifies subscribers.
// needsInput indicates whether the AI is waiting for user input (permission/question).
func (p *Process) SetIdle(needsInput bool) {
	p.setIdle(needsInput, false)
}

// SetIdleInterrupted transitions to idle due to a user interrupt.
func (p *Process) SetIdleInterrupted() {
	p.setIdle(false, true)
}

// setIdle emits a state change unless this idle says nothing the last one didn't.
//
// Being idle already is not enough to skip it: a turn that paused for a
// permission answer is idle, and the interrupt or error that then ends it has to
// be reported, or the session stays marked as waiting for an answer that no
// longer exists and work.AutoResumer never hears the turn stopped.
//
// The end of a turn is reported once. Agents can announce it twice — Codex
// answers an aborted call itself while Pockode synthesizes a response for the
// same call — and a second idle reads downstream as a second stop.
func (p *Process) setIdle(needsInput, interrupted bool) {
	if p.closed.Load() {
		return
	}

	p.mu.Lock()
	if p.state == ProcessStateIdle && (p.turnEnded || needsInput) {
		p.mu.Unlock()
		return
	}
	p.state = ProcessStateIdle
	p.turnEnded = !needsInput
	p.mu.Unlock()

	p.manager.emitStateChangeEvent(StateChangeEvent{
		SessionID:   p.sessionID,
		State:       ProcessStateIdle,
		NeedsInput:  needsInput,
		Interrupted: interrupted,
	})
}

// markActivated records that the agent has contributed to this session.
//
// Activation is deliberately tied to agent output rather than to process
// creation: spawning the CLI proves nothing about the session behind it. A first
// message that dies before the agent says anything — expired login, provider
// outage — leaves a session that never really started, and it should still be
// possible to point it at a different agent type instead of retrying the broken
// one forever. See EventType.ActivatesSession for why "says anything" is
// narrower than "a turn is under way".
func (p *Process) markActivated(ctx context.Context, log *slog.Logger) {
	if p.activated.Swap(true) {
		return
	}
	if err := p.sessionStore.Activate(ctx, p.sessionID); err != nil {
		log.Error("failed to activate session", "error", err)
	}
}

// streamEvents routes events to history and emits to the event listener.
func (p *Process) streamEvents(ctx context.Context) {
	log := slog.With("sessionId", p.sessionID)

	for event := range p.agentSession.Events() {
		p.touch()

		eventType := event.EventType()
		log.Debug("streaming event", "type", eventType)

		// Agent output means a turn is under way even if nothing on the send path
		// said so — output queued behind an interrupt resumes on its own.
		if eventType.IndicatesAgentActivity() {
			p.SetRunning()
		}
		if eventType.ActivatesSession() {
			p.markActivated(ctx, log)
		}

		// Persist to history
		if err := p.sessionStore.AppendToHistory(ctx, p.sessionID, agent.NewEventRecord(event)); err != nil {
			log.Error("failed to append to history", "error", err)
		}

		if eventType.AwaitsUserInput() {
			if eventType == agent.EventTypeInterrupted {
				p.SetIdleInterrupted()
			} else {
				needsInput := eventType == agent.EventTypePermissionRequest ||
					eventType == agent.EventTypeAskUserQuestion
				p.SetIdle(needsInput)
			}
			if err := p.sessionStore.Touch(ctx, p.sessionID); err != nil {
				log.Error("failed to touch session", "error", err)
			}
		}

		// Emit to listener (ChatMessagesWatcher)
		p.manager.EmitMessage(p.sessionID, event)
	}

	log.Info("event stream ended")
}
