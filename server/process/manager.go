package process

import (
	"context"
	"log/slog"
	"sync"
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
	SessionID string
	State     ProcessState
}

// Manager manages agent processes.
type Manager struct {
	agent        agent.Agent
	workDir      string
	dataDir      string // Data directory for MCP tools
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
}

// NewManager creates a new manager with the given idle timeout.
func NewManager(ag agent.Agent, workDir string, store session.Store, idleTimeout time.Duration, dataDir string) *Manager {
	ctx, cancel := context.WithCancel(context.Background())
	m := &Manager{
		agent:        ag,
		workDir:      workDir,
		dataDir:      dataDir,
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

func (m *Manager) emitStateChange(sessionID string, state ProcessState) {
	if m.onStateChange != nil {
		m.onStateChange(StateChangeEvent{SessionID: sessionID, State: state})
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

// ProcessOptions contains options for creating a new process.
type ProcessOptions struct {
	Resume       bool
	Mode         session.Mode
	SystemPrompt string
}

// GetOrCreateProcess returns an existing process or creates a new one.
func (m *Manager) GetOrCreateProcess(ctx context.Context, sessionID string, resume bool, mode session.Mode) (*Process, bool, error) {
	return m.GetOrCreateProcessWithOptions(ctx, sessionID, ProcessOptions{Resume: resume, Mode: mode})
}

// GetOrCreateProcessWithOptions returns an existing process or creates a new one with full options.
func (m *Manager) GetOrCreateProcessWithOptions(ctx context.Context, sessionID string, procOpts ProcessOptions) (*Process, bool, error) {
	m.processesMu.Lock()
	defer m.processesMu.Unlock()

	if proc, exists := m.processes[sessionID]; exists {
		proc.touch()
		return proc, false, nil
	}

	// Use manager's context for process lifecycle, not request context
	opts := agent.StartOptions{
		WorkDir:      m.workDir,
		SessionID:    sessionID,
		Resume:       procOpts.Resume,
		Mode:         procOpts.Mode,
		SystemPrompt: procOpts.SystemPrompt,
		MCPDataDir:   m.dataDir,
	}
	sess, err := m.agent.Start(m.ctx, opts)
	if err != nil {
		return nil, false, err
	}

	proc := &Process{
		sessionID:    sessionID,
		agentSession: sess,
		sessionStore: m.sessionStore,
		manager:      m,
		lastActive:   time.Now(),
		state:        ProcessStateIdle,
	}
	m.processes[sessionID] = proc

	go func() {
		defer func() {
			if r := recover(); r != nil {
				logger.LogPanic(r, "session crashed", "sessionId", sessionID)
			}
			m.remove(sessionID)
			m.emitStateChange(sessionID, ProcessStateEnded)
			slog.Info("process ended", "sessionId", sessionID)
		}()
		proc.streamEvents(m.ctx)
	}()

	m.emitStateChange(sessionID, ProcessStateIdle)
	slog.Info("process created", "sessionId", sessionID, "resume", procOpts.Resume, "mode", procOpts.Mode)
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
		proc.agentSession.Close()
		slog.Info("process closed", "sessionId", sessionID)
	}
}

// Shutdown closes all processes gracefully.
func (m *Manager) Shutdown() {
	m.cancel()
	procs := m.removeWhere(func(*Process) bool { return true })
	for _, p := range procs {
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
		return now.Sub(p.getLastActive()) > m.idleTimeout
	})
	for _, proc := range procs {
		proc.agentSession.Close()
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

func (p *Process) setState(state ProcessState) {
	p.mu.Lock()
	p.state = state
	p.mu.Unlock()
}

// SetRunning transitions the process to running state and notifies subscribers.
func (p *Process) SetRunning() {
	if p.State() == ProcessStateRunning {
		return
	}
	p.setState(ProcessStateRunning)
	p.manager.emitStateChange(p.sessionID, ProcessStateRunning)
}

// SetIdle transitions the process to idle state and notifies subscribers.
func (p *Process) SetIdle() {
	if p.State() == ProcessStateIdle {
		return
	}
	p.setState(ProcessStateIdle)
	p.manager.emitStateChange(p.sessionID, ProcessStateIdle)
}

// streamEvents routes events to history and emits to the event listener.
func (p *Process) streamEvents(ctx context.Context) {
	log := slog.With("sessionId", p.sessionID)

	for event := range p.agentSession.Events() {
		p.touch()

		eventType := event.EventType()
		log.Debug("streaming event", "type", eventType)

		// Ensure running state on event (handles edge cases like resumed sessions)
		p.SetRunning()

		// Persist to history
		if err := p.sessionStore.AppendToHistory(ctx, p.sessionID, agent.NewEventRecord(event)); err != nil {
			log.Error("failed to append to history", "error", err)
		}

		if eventType.AwaitsUserInput() {
			p.SetIdle()
			if err := p.sessionStore.Touch(ctx, p.sessionID); err != nil {
				log.Error("failed to touch session", "error", err)
			}
		}

		// Emit to listener (ChatMessagesWatcher)
		p.manager.EmitMessage(p.sessionID, event)
	}

	log.Info("event stream ended")
}
