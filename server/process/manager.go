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
	// budgets is how long a session may hold its process in each kind of wait.
	// The whole of this manager's lifecycle policy; see runLeaseReaper.
	budgets session.LeaseBudgets

	processesMu sync.Mutex
	processes   map[string]*Process

	// Message listener (ChatMessagesWatcher)
	messageListener ChatMessageListener

	// Called when a process ends (for cleanup coordination)
	onProcessEnd func()

	// Called when process running state changes
	onStateChange func(StateChangeEvent)

	// settler holds a turn's ending back until the session has stayed ended.
	// It is the session layer's, not the manager's, so that the one heuristic in
	// the lifecycle exists once — see session.TurnSettler.
	settler *session.TurnSettler

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
	// turn is the session's turn state as of this process's last write to the
	// store, kept here so the reaper can read it without a store lookup per
	// process per tick. The store owns it; this is a copy, and the only writer is
	// applyTurn. Guarded by mu.
	//
	// It replaces the three flags this process used to keep — running/idle, "the
	// turn ended", "a prompt is pending" — each of which had its own rule for
	// when it was cleared. There is one rule now, and it is session.ReduceTurn.
	turn session.TurnState
	// closed is set when the process is explicitly terminated (Close/Shutdown/reap).
	// Prevents stale buffered events from emitting state changes (e.g. running/idle)
	// that would incorrectly interact with the AutoResumer.
	closed atomic.Bool
	// activated mirrors the session's Activated flag so the store is written once,
	// on the transition, rather than on every event the agent produces.
	activated atomic.Bool
	// leaseAskedFor and leaseAskedAt remember the expired lease this process has
	// already been asked to give up, so one expiry sends one interrupt and the
	// grace period after it is measurable. Guarded by mu; see Manager.requestStop.
	leaseAskedFor time.Time
	leaseAskedAt  time.Time
	// toolActivity is what the calls still in flight are doing, for a client that
	// subscribes after they said so. Its own lock; see toolActivity.
	toolActivity toolActivity
}

// NewManager creates a new manager whose processes live under the given lease
// budgets. dataDir is this worktree's own data dir (session-scoped agent state);
// mcpServerDir is where the server publishes server.json for the MCP proxy (the
// main data dir).
func NewManager(agents *agent.Registry, workDir, dataDir, mcpServerDir string, store session.Store, budgets session.LeaseBudgets) *Manager {
	ctx, cancel := context.WithCancel(context.Background())
	m := &Manager{
		agents:       agents,
		workDir:      workDir,
		dataDir:      dataDir,
		mcpServerDir: mcpServerDir,
		sessionStore: store,
		budgets:      budgets,
		processes:    make(map[string]*Process),
		settler:      session.NewTurnSettler(session.DefaultSettleDelay),
		ctx:          ctx,
		cancel:       cancel,
	}
	// A deleted session's pending ending is dropped through this, whichever of
	// the several deletion paths took it away.
	store.AddOnChangeListener(m.settler)
	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		m.runLeaseReaper()
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

// SetOnTurnEnded names what to tell once a session's turn has ended and stayed
// ended. Unlike SetOnStateChange this is the settled answer, not the raw one:
// see session.TurnSettler for why anything acting on a turn ending needs it.
func (m *Manager) SetOnTurnEnded(fn func(session.TurnEnd)) {
	m.settler.SetListener(fn)
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
		OnUsage:      m.usageRecorder(sessionID),
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
		done:         make(chan struct{}),
	}
	// A new incarnation owns nothing the last one left behind. Normally there is
	// nothing to clear — the previous process reported its own end — and this is
	// what covers the session whose process died without getting to say so.
	// Written here, under processesMu, so the state is correct before the event
	// stream below can reduce anything into it; announced after the unlock,
	// because the callbacks take that lock.
	startTransition := proc.applyTurn(ctx, session.TurnInput{Signal: session.SignalProcessStarted})
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
			// Belt and braces for the turn state: the stream normally carries a
			// ProcessEndedEvent that reduces to the same thing, but an agent that
			// fails on the way up, or a panic in the loop above, closes the
			// channel without one. Reducing it twice changes nothing; not
			// reducing it at all leaves the session claiming a turn is running
			// with no process behind it. The announcement below is the process's
			// own, and is the one state the turn cannot express.
			m.observeTurn(sessionID, proc.applyTurn(context.Background(),
				session.TurnInput{Signal: session.SignalProcessEnded}))
			m.emitStateChange(sessionID, ProcessStateEnded, false)
			slog.Info("process ended", "sessionId", sessionID)
		}()
		proc.streamEvents(m.ctx)
	}()

	m.processesMu.Unlock()

	// Emit after releasing processesMu — callbacks may acquire it.
	m.emitTurn(sessionID, startTransition)
	if m.onStateChange != nil {
		m.onStateChange(StateChangeEvent{SessionID: sessionID, State: ProcessStateIdle, IsInitial: true})
	}
	slog.Info("process created", "sessionId", sessionID, "resume", meta.Activated,
		"agentType", meta.AgentType, "mode", meta.Mode, "model", meta.Model, "effort", meta.Effort)
	return proc, true, nil
}

// usageRecorder builds the callback the agent reports consumption through.
//
// It is bound to the session rather than to the Process because the agent is
// started before the Process exists, and it writes straight to the store: usage
// is not part of the event stream, so it does not pass through streamEvents (see
// agent.StartOptions.OnUsage).
//
// The manager's context, not a request's: reports keep arriving for as long as
// the process lives.
func (m *Manager) usageRecorder(sessionID string) func(session.UsageReport) {
	return func(report session.UsageReport) {
		err := m.sessionStore.AddUsage(m.ctx, sessionID, report)
		switch {
		case err == nil:
		case errors.Is(err, session.ErrSessionNotFound), errors.Is(err, context.Canceled):
			// A session deleted while its last turn was still being metered, or a
			// server shutting down. Neither is a problem worth an error line.
			slog.Debug("dropped usage report", "sessionId", sessionID, "reason", err)
		default:
			slog.Error("failed to record session usage", "error", err, "sessionId", sessionID)
		}
	}
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

// GetToolActivity returns what each tool call still in flight last reported
// doing, by tool_use_id. Nil when no process exists or nothing is in flight.
func (m *Manager) GetToolActivity(sessionID string) map[string]string {
	proc := m.GetProcess(sessionID)
	if proc == nil {
		return nil
	}
	return proc.toolActivity.snapshot()
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
	// The streams are done; this is the lease reaper, which stops on m.cancel.
	m.wg.Wait()

	// Nothing is left to act on a turn ending, and the endings the shutdown
	// itself produced describe processes the server killed on its way out.
	m.settler.Stop()

	slog.Info("manager shutdown complete", "processesClosed", len(procs))
}

// runLeaseReaper is the whole of the process lifecycle policy: a process lives
// for as long as the session holding it has a lease it has not used up.
//
// What a lease is, and the four kinds, belong to the session layer
// (session.Lease) because they are read off the turn state and nothing else.
// What is here is the acting on one.
func (m *Manager) runLeaseReaper() {
	defer func() {
		if r := recover(); r != nil {
			logger.LogPanic(r, "lease reaper crashed")
		}
	}()

	tick := m.budgets.TickInterval()
	if tick <= 0 {
		slog.Info("lease reaper disabled, no budget is set", "budgets", m.budgets)
		return
	}

	ticker := time.NewTicker(tick)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			m.reapLeases()
		case <-m.ctx.Done():
			return
		}
	}
}

func (m *Manager) reapLeases() {
	m.reapLeasesAsOf(time.Now())
}

// reapLeasesAsOf runs one pass of the lease table against the given instant.
//
// The instant is a parameter so the rule can be exercised without racing the
// wall clock: driving it with a synthetic "now" states the elapsed time outright
// instead of hoping a sleep outlasts a budget. It is the only way the table's
// day-scale entries are testable at all.
func (m *Manager) reapLeasesAsOf(now time.Time) {
	for _, p := range m.liveProcesses() {
		lease := m.budgets.LeaseFor(p.turnState(), p.getLastActive())
		if !lease.Expired(now) {
			continue
		}
		m.enforce(p, lease, now)
	}
}

// liveProcesses is a snapshot to iterate outside processesMu, which enforcing a
// lease has to be: every action below either writes the session store or closes
// a process, and both run listeners that take that lock.
func (m *Manager) liveProcesses() []*Process {
	m.processesMu.Lock()
	defer m.processesMu.Unlock()

	procs := make([]*Process, 0, len(m.processes))
	for _, p := range m.processes {
		procs = append(procs, p)
	}
	return procs
}

// leaseGrace is how long an expiry that has to ask the CLI to end a turn waits
// for it to happen before ending the process instead.
//
// Two of the four expiries are requests, not decisions: an interrupt is a
// message to the CLI, and the turn only ends when the CLI says so. A CLI that
// ignores it — wedged, or holding a tool call that does not come back — would
// otherwise leave a lease permanently expired and a process nothing collects,
// which is the exact failure the lease table exists to remove. Long enough that
// a CLI winding down a turn is never cut off, short enough that nobody waits on
// a dead one.
const leaseGrace = 30 * time.Second

// enforce carries out one expired lease.
//
// Every one of the four ends in the session being idle and its process being
// collected by the idle lease on a later pass. None of them writes turn state
// directly: an expiry produces the same signal the equivalent real event would
// (an interrupt, an ending), and session.ReduceTurn decides what that means, so
// the reaper cannot invent a state the rest of the model does not know about.
func (m *Manager) enforce(p *Process, lease session.Lease, now time.Time) {
	log := slog.With("sessionId", p.sessionID, "waitingOn", lease.Kind, "waited", lease.Waited(now))

	switch lease.Kind {
	case session.LeaseIdle:
		// Nothing is waiting on this process and nothing is lost by ending it;
		// the next message starts a new one, resumed. The turn state is left
		// exactly as it is — idle before, idle after.
		m.closeProcess(p, now, "idle process collected", log)

	case session.LeaseTurn:
		// The stop is asked for, not taken: the InterruptedEvent that comes back
		// is what ends the turn, so a CLI that is winding down finishes properly
		// and the abort is recorded once, by the same path a user's Stop uses.
		m.requestStop(p, lease, now, log,
			"This turn ran for %s without ending, so Pockode stopped it.", turnTimeoutCode)

	case session.LeaseAnswer:
		// Withdrawing on the user's behalf is what an interrupt already is, and
		// it is the only withdrawal available: answering the prompt properly
		// needs the request data, which lives on the card in the client and not
		// in anything the server keeps. Codex answers its outstanding approval
		// with a cancel before it stops the turn; Claude has no equivalent, and
		// whether its interrupt releases a control request it is blocking on has
		// not been measured — which is precisely what the grace backstop in
		// requestStop is for. Either way the wait ends.
		//
		// The answer is not lost with it. A question that expired can still be
		// sent as an ordinary message afterwards, which is why an hour is a
		// budget worth having (session.DefaultAnswerBudget); only a permission
		// request is final, because a permission that expires is a denial.
		m.requestStop(p, lease, now, log,
			"No answer for %s, so Pockode withdrew the request and stopped waiting.", answerTimeoutCode)

	case session.LeaseBackground:
		// Nobody to ask: the CLI is not listening, it is waiting on work of its
		// own. The ending is delivered on its behalf and everything downstream
		// falls back to what it did before background waits existed — idle, then
		// the usual auto-continue. Tasks still running die with the process when
		// the idle lease collects it, and are reported on the next start by the
		// adapter's own loss record.
		m.endBackgroundWait(p, lease, now, log)
	}
}

// The codes on the warnings an expiry writes into the transcript. A lease
// running out is never silent: it changes what the session is doing, and the
// user has to be able to see why from the transcript alone.
const (
	turnTimeoutCode       = "turn_timeout"
	answerTimeoutCode     = "answer_timeout"
	backgroundTimeoutCode = "background_wait_timeout"
)

// backgroundTimeoutNote is the agent's copy of the news, handed to it with the
// next prompt Pockode sends. Without it the agent is nudged to continue with no
// idea that Pockode stopped waiting for its background task.
const backgroundTimeoutNote = "Pockode saw no output for %s while waiting on your background task(s) and then ended " +
	"that turn, because it cannot wait forever. Any task you started may still be running: check before assuming its " +
	"result, and say so if you were still waiting on it."

// backgroundTimeoutWarning says what Pockode observed — silence — rather than
// that the task produced nothing, which it has no way of knowing: a task can
// finish without the CLI resuming, and a message asserting otherwise would be
// plainly wrong to the one user who checks.
const backgroundTimeoutWarning = "No output for %s while waiting on background work, so this response is being treated as finished."

// requestStop is the expiry that has to ask: warn in the transcript, send the
// interrupt, and end the process instead if the turn is still there a grace
// period later.
func (m *Manager) requestStop(p *Process, lease session.Lease, now time.Time, log *slog.Logger, warning, code string) {
	// Equal, not ==: a time.Time carries a monotonic reading and a location, and
	// neither is part of "is this the same lease".
	if asked, at := p.leaseAsk(); asked.Equal(lease.Since) {
		if now.Sub(at) <= leaseGrace {
			return
		}
		// The CLI was asked and did not answer. Ending the process is the one
		// stop that does not need its cooperation; the turn is aborted by
		// SignalProcessEnded, the same as any other process death.
		m.closeProcess(p, now, "lease expired and the interrupt went unanswered", log)
		return
	}
	p.noteLeaseAsk(lease.Since, now)

	log.Warn("lease expired, stopping the turn")
	p.inject(agent.WarningEvent{Message: fmt.Sprintf(warning, lease.Waited(now)), Code: code})
	if err := p.SendInterrupt(); err != nil {
		log.Error("failed to interrupt a turn whose lease expired", "error", err)
	}
}

// endBackgroundWait delivers the ending the CLI was never going to send.
//
// Both halves of "it must not be silent" are here: the warning the user reads in
// the transcript, and the note the agent is handed on its next prompt.
func (m *Manager) endBackgroundWait(p *Process, lease session.Lease, now time.Time, log *slog.Logger) {
	waited := lease.Waited(now)
	log.Warn("background wait budget exhausted, ending the parked turn")

	p.noteAgent(fmt.Sprintf(backgroundTimeoutNote, waited))
	p.inject(
		agent.WarningEvent{Message: fmt.Sprintf(backgroundTimeoutWarning, waited), Code: backgroundTimeoutCode},
		agent.DoneEvent{},
	)
}

// closeProcess ends a process: take it out of the map first so nothing new is
// handed to it, then close the agent session. ProcessStateEnded and the turn's
// abort are emitted by the streamEvents goroutine's defer when the events
// channel closes, and so is the onProcessEnd callback — which is why the
// removal here goes through removeWhere rather than remove.
//
// The lease is re-read inside the lock, and that is the whole reason this is not
// a plain delete. Everything the reaper decided was decided outside processesMu,
// and the paths that hand a process work — GetOrCreateProcess, Touch — hold it:
// without the re-check, a message sent between the snapshot and here would be
// given to a process about to be killed, and the user's turn would vanish. A
// message moves lastActive or the turn state, so the lease it was condemned on
// is no longer expired and it is spared instead.
func (m *Manager) closeProcess(p *Process, now time.Time, reason string, log *slog.Logger) {
	removed := m.removeWhere(func(candidate *Process) bool {
		return candidate == p && m.budgets.LeaseFor(p.turnState(), p.getLastActive()).Expired(now)
	})
	if len(removed) == 0 {
		return
	}
	p.closed.Store(true)
	p.agentSession.Close()
	log.Info(reason)
}

// leaseAsk reports the lease this process has already been asked to give up and
// when the asking happened, so one expiry produces one interrupt rather than one
// per tick. Keyed on the lease's start, which is the phase it belongs to: a new
// turn is a new lease and gets its own ask.
func (p *Process) leaseAsk() (since time.Time, at time.Time) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.leaseAskedFor, p.leaseAskedAt
}

func (p *Process) noteLeaseAsk(since, at time.Time) {
	p.mu.Lock()
	p.leaseAskedFor, p.leaseAskedAt = since, at
	p.mu.Unlock()
}

// noteAgent leaves an explanation for the agent, delivered with the next prompt
// Pockode sends it. Agents that cannot carry one simply do not implement it —
// there is nowhere to put the note, and the user has the warning either way.
func (p *Process) noteAgent(note string) {
	if notifier, ok := p.agentSession.(agent.SessionNotifier); ok {
		notifier.QueueNote(note)
	}
}

// SendMessage sends a message to the agent and starts a turn.
func (p *Process) SendMessage(prompt string) error {
	p.startTurn()
	return p.agentSession.SendMessage(prompt)
}

// SendPermissionResponse answers a permission request, which clears the blocker
// that request raised and lets the turn carry on.
func (p *Process) SendPermissionResponse(data agent.PermissionRequestData, choice agent.PermissionChoice) error {
	p.answerPrompt(data.RequestID)
	return p.agentSession.SendPermissionResponse(data, choice)
}

// SendQuestionResponse answers a question, clearing that question's blocker.
func (p *Process) SendQuestionResponse(data agent.QuestionRequestData, answers map[string]string) error {
	p.answerPrompt(data.RequestID)
	return p.agentSession.SendQuestionResponse(data, answers)
}

// SendInterrupt sends an interrupt signal to the agent. The turn is not ended
// here: the InterruptedEvent that comes back on the stream is what ends it, and
// a stop the CLI never acts on must not leave the session claiming otherwise.
func (p *Process) SendInterrupt() error {
	return p.agentSession.SendInterrupt()
}

// startTurn records that a prompt has been handed to the agent.
func (p *Process) startTurn() {
	p.signal(session.SignalPrompt, "")
}

// answerPrompt records that the user has answered the prompt with this id.
func (p *Process) answerPrompt(requestID string) {
	p.signal(session.SignalAnswered, requestID)
}

// signal is the send path's way into the reducer, for the things that happen to
// a session without an agent event to carry them: a prompt going out, an answer
// going back.
func (p *Process) signal(sig session.TurnSignal, requestID string) {
	if p.closed.Load() {
		return
	}
	in := session.TurnInput{Signal: sig, RequestID: requestID, At: time.Now()}
	p.manager.emitTurn(p.sessionID, p.applyTurn(context.Background(), in))
}

// applyTurn folds one input into the session's stored turn state and caches the
// result for the reaper to read without a store lookup per process per tick. It
// does not announce anything; emitTurn does.
//
// Two callers need them apart. Process creation writes the state under
// processesMu — so the event stream it is about to start cannot reduce anything
// into a state that is still wrong — and announces after releasing it, because
// the listeners take that lock. streamEvents writes before the event's own
// history record and announces after it (see there).
func (p *Process) applyTurn(ctx context.Context, in session.TurnInput) session.TurnTransition {
	if in.At.IsZero() {
		in.At = time.Now()
	}

	transition, err := p.sessionStore.ApplyTurn(ctx, p.sessionID, in)
	if err != nil {
		// A deleted session is the ordinary case and not worth shouting about:
		// its process is torn down asynchronously, so events can still arrive
		// with nowhere left to record them.
		if errors.Is(err, session.ErrSessionNotFound) {
			slog.Debug("turn state dropped, session is gone", "sessionId", p.sessionID, "signal", in.Signal)
		} else {
			slog.Error("failed to apply turn state", "sessionId", p.sessionID, "signal", in.Signal, "error", err)
		}
		return session.TurnTransition{}
	}

	p.mu.Lock()
	p.turn = transition.State
	p.mu.Unlock()

	for _, blocker := range transition.Expired {
		// The only record of what happened to a blocker that was never answered.
		// The CLI's transcript cannot supply one: it is killed with SIGKILL, so
		// it may not hold so much as the message that raised the question.
		slog.Info("blocker expired unanswered",
			"sessionId", p.sessionID, "kind", blocker.Kind,
			"requestId", blocker.RequestID, "raisedAt", blocker.RaisedAt, "cause", in.Signal)
	}
	return transition
}

// turnState is this process's copy of what the session is doing.
//
// A copy, so that the reaper does not take the store's lock once per process per
// tick. Two applies racing — a send and an event arriving together — reduce in
// whatever order the store serialized them, and the loser can leave this one
// transition behind; the next apply corrects it, and a hold read one tick late
// only ever spares a process that the following tick collects.
func (p *Process) turnState() session.TurnState {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.turn
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

// State is the session's turn seen through the three values the wire has always
// used. It is a narrowing, not the state itself — see StateChangeEvent.
func (p *Process) State() ProcessState {
	state, _ := viewTurn(p.turnState())
	return state
}

// viewTurn narrows a TurnState down to the pair the session list and the chat
// panel have always been sent: a process state and a "needs input" flag.
//
// Blocked on a person reads as idle-and-waiting, which is what it was before
// this model existed. Blocked on background work reads as running, which is also
// what it was — and is the one place this narrowing loses something real, since
// the whole point of the new blocker is that the two are not the same. The wire
// keeps the old shape until the client is changed to read the turn state
// directly; nothing above this line is written in terms of these two values.
func viewTurn(turn session.TurnState) (ProcessState, bool) {
	if turn.AwaitingUserAnswer() {
		return ProcessStateIdle, true
	}
	if turn.InProgress() {
		return ProcessStateRunning, false
	}
	return ProcessStateIdle, false
}

// observeTurn hands a transition to the settler, which is what decides whether
// the turn has really stopped (see session.TurnSettler).
//
// A transition that changed nothing is passed on to nobody: most of a turn's
// events say exactly what the one before them said, and a listener that hears
// "still running" forty times is one that cannot tell a turn from a token.
func (m *Manager) observeTurn(sessionID string, transition session.TurnTransition) {
	if !transition.Changed {
		return
	}
	m.settler.Observe(sessionID, transition)
}

// emitTurn is observeTurn plus the state change the wire has always carried.
// The process-ended path uses observeTurn alone: a session whose process is gone
// still has a turn that ended, but the ending of the *process* is announced by
// the goroutine that owns its stream.
//
// The narrowing means a few real turn changes come out as the value the last one
// already carried — a turn parking on background work and coming back off it are
// both "running". Those are sent anyway rather than deduplicated: a listener has
// to tolerate a repeat regardless (the session list already sends one per usage
// report), and a filter here would be a second place that decides what counts as
// news.
//
// Must not be called with processesMu held; the listeners take it.
func (m *Manager) emitTurn(sessionID string, transition session.TurnTransition) {
	if !transition.Changed {
		return
	}
	m.observeTurn(sessionID, transition)
	state, needsInput := viewTurn(transition.State)
	m.emitStateChangeEvent(StateChangeEvent{
		SessionID:  sessionID,
		State:      state,
		NeedsInput: needsInput,
		// Only an ending can be an abort, and only an abort means the turn was
		// taken away rather than finished — a user interrupt, or a process that
		// died carrying it. Downstream this is what says "do not carry on".
		Interrupted: transition.Ended && transition.State.LastOutcome == session.OutcomeAborted,
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

// acceptsTurnInput rejects what a process that is already being torn down has
// left in its buffer. Those events were true when the agent produced them and
// are no longer: a "running" reduced out of one would mark a session as busy
// with a process that is being killed. The end of the process is the exception,
// because that is the one thing still true about it.
func (p *Process) acceptsTurnInput(in session.TurnInput) bool {
	return !p.closed.Load() || in.Signal == session.SignalProcessEnded
}

// turnInputFor translates one agent event into the reducer's vocabulary, and is
// the whole of the translation: every other part of the server reads turn state
// rather than events.
//
// The events that map to nothing are the ones that say nothing about a turn. A
// warning is a session-level problem and can arrive before the first message
// ever goes out — the startup warning Codex emits for a thread it cannot resume
// once marked a session as running with nothing running. A message event is the
// broadcast of a prompt whose turn the send path already started. The rest are
// only ever replayed from history.
//
// The fall-through is deliberately the inert one: a type nobody named here and
// nobody put in IndicatesAgentActivity moves no turn at all. That is the right
// default for an event that only describes something, and the wrong one for an
// event that ends or blocks a turn — such a type has to be named in the switch
// below, because no predicate will pick it up.
func turnInputFor(event agent.AgentEvent) (session.TurnInput, bool) {
	in := session.TurnInput{At: time.Now()}

	switch e := event.(type) {
	case agent.PermissionRequestEvent:
		in.Signal, in.RequestID = session.SignalPermissionRaised, e.RequestID
	case agent.AskUserQuestionEvent:
		in.Signal, in.RequestID = session.SignalQuestionRaised, e.RequestID
	case agent.RequestCancelledEvent:
		in.Signal, in.RequestID = session.SignalRequestCancelled, e.RequestID
	case agent.BackgroundWaitEvent:
		in.Signal = session.SignalBackgroundParked
	case agent.DoneEvent:
		in.Signal = session.SignalDone
	case agent.ErrorEvent:
		in.Signal = session.SignalFailed
	case agent.InterruptedEvent:
		in.Signal = session.SignalInterrupted
	case agent.ProcessEndedEvent:
		in.Signal = session.SignalProcessEnded
	default:
		switch {
		// Content is the one thing that ends a background wait: it is the proof
		// that the CLI resumed by itself. ActivatesSession is exactly that set —
		// what the agent put into the conversation, as opposed to what it said
		// about it.
		case event.EventType().ActivatesSession():
			in.Signal = session.SignalOutput
		// Everything else that only arrives mid-turn shows the turn is alive
		// without proving the CLI came back: a `system` frame, a live progress
		// line. The background task list changing is a `system` frame, so
		// counting these as a resumption would make a task *finishing* look like
		// the turn returning.
		case event.EventType().IndicatesAgentActivity():
			in.Signal = session.SignalNoise
		default:
			return session.TurnInput{}, false
		}
	}
	return in, true
}

// streamEvents routes events to history and emits to the event listener.
func (p *Process) streamEvents(ctx context.Context) {
	log := slog.With("sessionId", p.sessionID)

	for event := range p.agentSession.Events() {
		p.touch()
		p.handleEvent(ctx, log, event)
	}

	log.Info("event stream ended")
}

// inject puts events the agent never sent through the same path its own take.
//
// The reaper is the caller: a lease running out on a background wait has to
// deliver the ending the CLI was never going to send. Routed through handleEvent
// rather than written separately so that a synthesized ending is recorded,
// reduced and broadcast exactly like a real one — there is one definition of
// what an event does to a session, and an expiry that took a shortcut past it
// would be a second.
//
// context.Background rather than the manager's: the events an expiry produces
// are the ones that still have to land when the server is on its way out, and
// Shutdown already waits for this goroutine's caller.
//
// It deliberately does not touch lastActive, which streamEvents does for every
// event it hands over. That timestamp answers "when did anything last happen to
// this session", and Pockode explaining its own decision is not something
// happening to the session: a background wait that has just used up a day of
// budget should fall straight to the idle lease, not be granted a fresh five
// minutes because of the ending Pockode itself wrote.
func (p *Process) inject(events ...agent.AgentEvent) {
	// Two ways this process may already be over, and neither is rare enough to
	// skip: it was closed on purpose (the flag), or its CLI exited on its own and
	// the stream goroutine has finished recording everything it ever will (the
	// channel). Writing after either one puts an explanation into the transcript
	// of a session that has already said its last word.
	if p.closed.Load() {
		return
	}
	select {
	case <-p.done:
		return
	default:
	}
	log := slog.With("sessionId", p.sessionID, "injected", true)
	for _, event := range events {
		p.handleEvent(context.Background(), log, event)
	}
}

// handleEvent is what one event does to a session: it may start the session, it
// may move the turn, it is usually recorded, and it is always broadcast.
func (p *Process) handleEvent(ctx context.Context, log *slog.Logger, event agent.AgentEvent) {
	eventType := event.EventType()
	log.Debug("streaming event", "type", eventType)

	if eventType.ActivatesSession() {
		p.markActivated(ctx, log)
	}

	p.toolActivity.observe(event)

	// The turn state is decided before the record is written and announced
	// after it, which is two separate promises. Deciding first means anything
	// that sees the record sees the state it caused, already settled — which
	// is also what lets a test use the record as its signal that an event has
	// been processed. Announcing after means a listener woken by the change
	// cannot go looking for a record that is not there yet.
	in, reduce := turnInputFor(event)
	reduce = reduce && p.acceptsTurnInput(in)
	var transition session.TurnTransition
	if reduce {
		transition = p.applyTurn(ctx, in)
	}

	// Persist to history. An event that reports a latest value rather than a
	// settled fact is broadcast and never stored, so it reaches subscribers
	// with no sequence number — see agent.EventType.Persisted.
	seq := session.NoHistorySeq
	if eventType.Persisted() {
		var err error
		seq, err = p.sessionStore.AppendToHistory(ctx, p.sessionID, agent.NewEventRecord(event))
		if err != nil {
			log.Error("failed to append to history", "error", err)
		}
	}

	if reduce {
		// process_ended has its own announcement, made by the goroutine that
		// owns this stream once the channel closes; it is the one state the
		// turn cannot express, because the session outlives the process. The
		// turn it aborted still has to settle, though, so the settler hears it
		// either way.
		if in.Signal == session.SignalProcessEnded {
			p.manager.observeTurn(p.sessionID, transition)
		} else {
			p.manager.emitTurn(p.sessionID, transition)
		}
	}

	if eventType.AwaitsUserInput() {
		if err := p.sessionStore.Touch(ctx, p.sessionID); err != nil {
			log.Error("failed to touch session", "error", err)
		}
	}

	// Emit to listener (ChatMessagesWatcher)
	p.manager.EmitMessage(p.sessionID, event, seq)
}
