package process

import (
	"context"
	"errors"
	"fmt"
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

// shutdownDrainTimeout caps how long Shutdown waits for sessions to stop
// streaming. Generous enough that a session closing normally is never cut off,
// short enough that a stuck agent cannot hold the server open.
const shutdownDrainTimeout = 10 * time.Second

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
	// Tracks the reaper and every event stream, so Shutdown can return only once
	// nothing is still writing to the session store.
	wg sync.WaitGroup
}

// ErrManagerClosed is returned when a process is requested after shutdown.
var ErrManagerClosed = errors.New("process manager is shut down")

// Process holds a running agent process. Do not cache references.
type Process struct {
	sessionID    string
	agentSession agent.Session
	sessionStore session.Store
	manager      *Manager // back-reference for broadcasting to subscribers
	// Closed when the event stream goroutine has returned, i.e. when the process
	// has finished persisting everything it will ever persist.
	done chan struct{}

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
	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		m.runIdleReaper()
	}()
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

// EmitMessage sends a message to the listener. seq is where the event was
// persisted in the session's history, or session.NoHistorySeq if it was not.
func (m *Manager) EmitMessage(sessionID string, event agent.AgentEvent, seq session.HistorySeq) {
	if m.messageListener != nil {
		m.messageListener.OnChatMessage(ChatMessage{
			SessionID: sessionID,
			Event:     event,
			Seq:       seq,
		})
	}
}

// GetOrCreateProcess launches the CLI described by meta, or returns the process
// already running for meta.ID. A session that has been activated is resumed.
func (m *Manager) GetOrCreateProcess(ctx context.Context, meta session.SessionMeta) (*Process, bool, error) {
	sessionID := meta.ID
	m.processesMu.Lock()

	// Checked under processesMu, which Shutdown also holds while cancelling, so a
	// process can never be registered after Shutdown stopped waiting for it.
	if m.ctx.Err() != nil {
		m.processesMu.Unlock()
		return nil, false, ErrManagerClosed
	}

	if proc, exists := m.processes[sessionID]; exists {
		proc.touch()
		m.processesMu.Unlock()
		return proc, false, nil
	}

	ag, err := m.agents.Get(meta.AgentType)
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
		Resume:       meta.Activated,
		Mode:         meta.Mode,
		Model:        meta.Model,
		Effort:       meta.Effort,
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
		done:         make(chan struct{}),
	}
	// An already activated session starts out knowing it has nothing to record.
	proc.activated.Store(meta.Activated)
	m.processes[sessionID] = proc

	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		defer close(proc.done)
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
	slog.Info("process created", "sessionId", sessionID, "resume", meta.Activated,
		"agentType", meta.AgentType, "mode", meta.Mode, "model", meta.Model, "effort", meta.Effort)
	return proc, true, nil
}

// ForkSupport returns what the agent behind agentType says about being forked,
// which is the only thing anyone outside that agent's package needs to know to
// decide whether and how a session of it can be forked.
func (m *Manager) ForkSupport(agentType session.AgentType) (agent.ForkSupport, error) {
	ag, err := m.agents.Get(agentType)
	if err != nil {
		return agent.ForkUnsupported, err
	}
	return agent.ForkSupportOf(ag), nil
}

// ForkAgentSession asks the agent behind agentType to carry its own context into
// an already-created forked session, filling in the directories the manager owns.
//
// It reports whether the agent will remember the conversation in the new session.
// False without an error is the ordinary answer for a fork the agent could not
// follow: the fork stands and the caller has to tell the user.
func (m *Manager) ForkAgentSession(ctx context.Context, agentType session.AgentType, opts agent.ForkOptions) (bool, error) {
	ag, err := m.agents.Get(agentType)
	if err != nil {
		return false, err
	}

	forker, ok := ag.(agent.SessionForker)
	if !ok {
		// Callers ask ForkSupport before getting here, so this is a caller that
		// forked a session whose agent had already said it cannot be. Reported
		// rather than shrugged off as "carried nothing": staying silent would hand
		// the user a fork whose agent was never consulted, which is
		// indistinguishable from one it consulted and could not serve.
		return false, fmt.Errorf("agent %q cannot fork sessions", agentType)
	}

	opts.WorkDir = m.workDir
	opts.DataDir = m.dataDir
	return forker.ForkSession(ctx, opts)
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

// Close terminates a specific process and waits for its event stream to drain.
// Waiting is what makes closing safe to build on: callers close a process
// precisely because they are about to invalidate what it writes to (deleting the
// session, tearing down the data directory), and a stream still running would
// race them.
func (m *Manager) Close(sessionID string) {
	if proc := m.remove(sessionID); proc != nil {
		proc.closed.Store(true)
		proc.agentSession.Close()
		<-proc.done
		slog.Info("process closed", "sessionId", sessionID)
	}
}

// Shutdown closes all processes gracefully and returns once their streaming
// goroutines have finished. Waiting matters because those goroutines still write
// session history and flip session state: returning early would leave writes
// landing in a data directory the caller already considers closed.
func (m *Manager) Shutdown() {
	m.processesMu.Lock()
	m.cancel()
	procs := make([]*Process, 0, len(m.processes))
	for sessionID, p := range m.processes {
		procs = append(procs, p)
		delete(m.processes, sessionID)
	}
	m.processesMu.Unlock()

	for _, p := range procs {
		p.closed.Store(true)
		p.agentSession.Close()
	}
	// Waited on only after every agent session is closed: a stream ends when its
	// events channel does, and that channel closes with the agent behind it.
	//
	// Bounded: a session whose agent refuses to let go of its output must not be
	// able to stall the whole server's shutdown. Report it rather than hang.
	deadline := time.After(shutdownDrainTimeout)
	for _, p := range procs {
		select {
		case <-p.done:
		case <-deadline:
			slog.Warn("shutdown timed out waiting for sessions to stop streaming",
				"sessionId", p.sessionID, "timeout", shutdownDrainTimeout)
			return
		}
	}
	// The streams are done; this is the idle reaper, which stops on m.cancel.
	m.wg.Wait()

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
	m.reapIdleAsOf(time.Now())
}

// reapIdleAsOf closes every process whose last activity is older than the idle
// timeout, measured against the given instant. The instant is a parameter so
// the reaping rule can be exercised without racing the wall clock: driving it
// with a synthetic "now" states the elapsed time outright instead of hoping a
// sleep outlasts a timeout.
func (m *Manager) reapIdleAsOf(now time.Time) {
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
		seq, err := p.sessionStore.AppendToHistory(ctx, p.sessionID, agent.NewEventRecord(event))
		if err != nil {
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
		p.manager.EmitMessage(p.sessionID, event, seq)
	}

	log.Info("event stream ended")
}
