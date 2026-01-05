package process

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/rpc"
	"github.com/pockode/server/session"
	"github.com/sourcegraph/jsonrpc2"
)

// Manager manages agent processes and JSON-RPC subscriptions.
// Processes and subscriptions have independent lifecycles.
type Manager struct {
	agent        agent.Agent
	workDir      string
	sessionStore session.Store
	idleTimeout  time.Duration

	// Process management: sessionID -> running process
	processesMu sync.Mutex
	processes   map[string]*Process

	// Subscription management: sessionID -> subscribed JSON-RPC connections
	subsMu sync.Mutex
	subs   map[string][]*jsonrpc2.Conn

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
}

// NewManager creates a new manager with the given idle timeout.
func NewManager(ag agent.Agent, workDir string, store session.Store, idleTimeout time.Duration) *Manager {
	ctx, cancel := context.WithCancel(context.Background())
	m := &Manager{
		agent:        ag,
		workDir:      workDir,
		sessionStore: store,
		idleTimeout:  idleTimeout,
		processes:    make(map[string]*Process),
		subs:         make(map[string][]*jsonrpc2.Conn),
		ctx:          ctx,
		cancel:       cancel,
	}
	go m.runIdleReaper()
	return m
}

// GetOrCreateProcess returns an existing process or creates a new one.
func (m *Manager) GetOrCreateProcess(ctx context.Context, sessionID string, resume bool) (*Process, bool, error) {
	m.processesMu.Lock()
	defer m.processesMu.Unlock()

	if proc, exists := m.processes[sessionID]; exists {
		proc.touch()
		return proc, false, nil
	}

	// Use manager's context for process lifecycle, not request context
	sess, err := m.agent.Start(m.ctx, m.workDir, sessionID, resume)
	if err != nil {
		return nil, false, err
	}

	proc := &Process{
		sessionID:    sessionID,
		agentSession: sess,
		sessionStore: m.sessionStore,
		manager:      m,
		lastActive:   time.Now(),
	}
	m.processes[sessionID] = proc

	go func() {
		proc.streamEvents(m.ctx)
		m.remove(sessionID)
		slog.Info("process ended", "sessionId", sessionID)
	}()

	slog.Info("process created", "sessionId", sessionID, "resume", resume)
	return proc, true, nil
}

// GetProcess returns an existing process or nil.
// Use this to check if a process is running without creating one.
func (m *Manager) GetProcess(sessionID string) *Process {
	m.processesMu.Lock()
	defer m.processesMu.Unlock()
	return m.processes[sessionID]
}

// HasProcess returns whether a process is running for the given session.
func (m *Manager) HasProcess(sessionID string) bool {
	return m.GetProcess(sessionID) != nil
}

// Touch updates the process's last active time.
func (m *Manager) Touch(sessionID string) {
	m.processesMu.Lock()
	defer m.processesMu.Unlock()
	if proc, exists := m.processes[sessionID]; exists {
		proc.touch()
	}
}

// SubscribeRPC adds a JSON-RPC connection to receive events for a session.
// The connection will receive events from any process started for this session.
// Returns true if this is a new subscription (not already subscribed).
func (m *Manager) SubscribeRPC(sessionID string, conn *jsonrpc2.Conn) bool {
	m.subsMu.Lock()
	defer m.subsMu.Unlock()

	// Check if already subscribed
	for _, c := range m.subs[sessionID] {
		if c == conn {
			return false
		}
	}

	m.subs[sessionID] = append(m.subs[sessionID], conn)
	slog.Debug("subscribed to session", "sessionId", sessionID, "totalSubs", len(m.subs[sessionID]))
	return true
}

// UnsubscribeRPC removes a JSON-RPC connection from receiving events.
func (m *Manager) UnsubscribeRPC(sessionID string, conn *jsonrpc2.Conn) {
	m.subsMu.Lock()
	defer m.subsMu.Unlock()

	conns := m.subs[sessionID]
	newConns := make([]*jsonrpc2.Conn, 0, len(conns))
	for _, c := range conns {
		if c != conn {
			newConns = append(newConns, c)
		}
	}

	if len(newConns) == 0 {
		delete(m.subs, sessionID)
	} else {
		m.subs[sessionID] = newConns
	}
	slog.Debug("unsubscribed from session", "sessionId", sessionID, "totalSubs", len(newConns))
}

// GetSubscribers returns a copy of the subscribers for a session.
func (m *Manager) GetSubscribers(sessionID string) []*jsonrpc2.Conn {
	m.subsMu.Lock()
	defer m.subsMu.Unlock()
	conns := make([]*jsonrpc2.Conn, len(m.subs[sessionID]))
	copy(conns, m.subs[sessionID])
	return conns
}

// Notify sends a JSON-RPC notification to all subscribers of a session.
func (m *Manager) Notify(ctx context.Context, sessionID string, method string, params interface{}) {
	conns := m.GetSubscribers(sessionID)

	for _, conn := range conns {
		if err := conn.Notify(ctx, method, params); err != nil {
			slog.Debug("notify failed", "error", err, "method", method)
		}
	}
}

// remove removes a process from the manager and returns it.
func (m *Manager) remove(sessionID string) *Process {
	m.processesMu.Lock()
	defer m.processesMu.Unlock()
	proc := m.processes[sessionID]
	delete(m.processes, sessionID)
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

// AgentSession returns the underlying agent session.
func (p *Process) AgentSession() agent.Session {
	return p.agentSession
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

// streamEvents routes events to history and broadcasts to all subscribed connections.
func (p *Process) streamEvents(ctx context.Context) {
	log := slog.With("sessionId", p.sessionID)

	for event := range p.agentSession.Events() {
		eventType := event.EventType()
		log.Debug("streaming event", "type", eventType)

		// Persist event to history (with type field for replay)
		if err := p.sessionStore.AppendToHistory(ctx, p.sessionID, agent.NewHistoryRecord(event)); err != nil {
			log.Error("failed to append to history", "error", err)
		}

		// Send as JSON-RPC notification
		params := rpc.NewNotifyParams(p.sessionID, event)
		p.manager.Notify(ctx, p.sessionID, "chat."+string(eventType), params)
	}

	log.Info("event stream ended")
}
