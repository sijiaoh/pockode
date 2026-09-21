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

// StateChangeEvent is a session's turn narrowed to the one value anything
// outside this package still reads: is a process producing output or not.
//
// It used to carry three more facts — needs-input, interrupted, and whether this
// was a process's first idle — and all three were for the work layer, which read
// process states because it had nothing better. It reads the turn now (its
// activity) and a settled turn ending (its engine), so what is left here is the
// unread mark: a session goes unread when it falls idle and nobody is looking.
type StateChangeEvent struct {
	SessionID string
	State     ProcessState
	// IsInitial marks the idle a process emits on creation, which is the one
	// idle no turn produced. Nothing reads it today; it is kept because "should
	// merely starting a session mark it unread" is a product question, and
	// deleting the flag would answer it by accident.
	IsInitial bool
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
	// worktree is the name of the worktree this manager's sessions live in,
	// empty for the main one. Handed to every CLI it spawns, which reports it
	// back as the MCP caller's identity.
	worktree     string
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

// ErrRequestNotPending is returned when an answer names a prompt the session is
// no longer waiting on: it expired with the process that raised it, the agent
// withdrew it, or somebody else answered first.
//
// Refused rather than forwarded. A live process that is handed an answer to a
// request it has forgotten does nothing with it, while Pockode would have
// recorded a turn as started — leaving a session that claims to be running with
// nothing coming to end it. Saying so instead is what lets the client put the
// card back to Expired, where an unanswerable question can still be sent as an
// ordinary message (docs/lifecycle-ui.md §5.1, §8).
var ErrRequestNotPending = errors.New("this request is no longer waiting for an answer")

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
	// that would incorrectly interact with the work engine.
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
	// timedOut names the prompts this process's answer lease gave up on, which
	// is what tells their expiry apart from every other kind: the wait was not
	// abandoned by the agent or overtaken by the user, it ran out of time.
	//
	// By request id rather than a flag on the process, because the two are not
	// the same claim. A CLI can answer the interrupt by withdrawing the prompt
	// itself — Codex does exactly that — in which case nothing expires and a
	// flag would still be set when some later, unrelated prompt did. An id
	// cannot be misread that way: it names one prompt, and a prompt is answered
	// or expires once. Guarded by mu; see Manager.enforce and recordExpiries.
	timedOut map[string]struct{}
	// retiring is set when the work this session belongs to has closed: the
	// process may finish the turn it is in the middle of and nothing more. It is
	// cleared by the next prompt, because that is somebody coming back to a
	// session nobody was supposed to come back to. See Manager.RetireSession.
	retiring atomic.Bool
}

// NewManager creates a new manager whose processes live under the given lease
// budgets. worktree is the name of the worktree it serves (empty for the main
// one); dataDir is that worktree's own data dir (session-scoped agent state);
// mcpServerDir is where the server publishes server.json for the MCP proxy (the
// main data dir).
func NewManager(agents *agent.Registry, worktree, workDir, dataDir, mcpServerDir string, store session.Store, budgets session.LeaseBudgets) *Manager {
	ctx, cancel := context.WithCancel(context.Background())
	m := &Manager{
		agents:       agents,
		worktree:     worktree,
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

func (m *Manager) emitStateChange(sessionID string, state ProcessState) {
	if m.onStateChange != nil {
		m.onStateChange(StateChangeEvent{SessionID: sessionID, State: state})
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
		Worktree:     m.worktree,
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
			// Everything below speaks for the session, so a process that has
			// already been replaced says none of it. Its successor's
			// SignalProcessStarted has aborted whatever turn this one was
			// carrying and taken the session over; repeating that here would
			// abort the *successor's* turn instead — and with the work engine
			// stopping work on an aborted turn, that is a work stopped for a
			// process that died before it.
			if m.dropProcess(proc) {
				slog.Info("process ended after being replaced", "sessionId", sessionID)
				return
			}
			// Belt and braces for the turn state: the stream normally carries a
			// ProcessEndedEvent that reduces to the same thing, but an agent that
			// fails on the way up, or a panic in the loop above, closes the
			// channel without one. Reducing it twice changes nothing; not
			// reducing it at all leaves the session claiming a turn is running
			// with no process behind it. The announcement below is the process's
			// own, and is the one state the turn cannot express.
			endCtx := context.Background()
			endTransition := proc.applyTurn(endCtx,
				session.TurnInput{Signal: session.SignalProcessEnded})
			m.observeTurn(sessionID, endTransition)
			// The prompts this process was holding die with it here whenever the
			// agent never got to send a process_ended of its own — which is every
			// kill, the path that leaves a card on screen with nothing behind it.
			proc.recordExpiries(endCtx, slog.With("sessionId", sessionID),
				session.SignalProcessEnded, endTransition.Expired)
			m.emitStateChange(sessionID, ProcessStateEnded)
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

// dropProcess takes p out of the map and reports whether p has been *replaced* —
// whether some other process now answers for this session.
//
// The distinction is the whole point, because "gone from the map" covers two
// opposite cases. A process taken out by a deliberate close (Close, a lease, a
// retirement) is simply ending, and everything the ending announces still speaks
// for the session. A process whose successor is already in the map under the
// same id must announce nothing: a session outlives its processes, one is
// collected and the next message builds another moments later, so a predecessor
// that removed "the process for this session" would evict the live successor,
// and one that reduced `process_ended` would abort the successor's turn.
//
// The callback fires either way: a process did end, and what the listener does
// with that (worktree cleanup) re-checks the state itself.
func (m *Manager) dropProcess(p *Process) (replaced bool) {
	m.processesMu.Lock()
	current, present := m.processes[p.sessionID]
	replaced = present && current != p
	if present && !replaced {
		delete(m.processes, p.sessionID)
	}
	callback := m.onProcessEnd
	m.processesMu.Unlock()

	if callback != nil {
		go callback()
	}
	return replaced
}

// remove removes whatever process a session currently has and returns it.
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

// workCloseGrace is how long a session gets to finish what it was saying after
// the work above it closed.
//
// What it bounds is a sentence, not a task: the agent has already reported the
// work done, and the turn still open is the one it is signing off in. A turn
// that is still going a couple of minutes later is doing something the closed
// work no longer covers — and nothing is lost by ending it, because the session
// id and its transcript stay for Reopen.
const workCloseGrace = 2 * time.Minute

// RetireSession lets a session finish its current turn and then ends its
// process. It is what a work closing does to the session beneath it: the engine
// has let go, so there is no lease left, but the CLI may still be mid-sentence.
//
// Three things follow from "nobody is coming back to this session":
//
//   - Every permission request on screen is cancelled with ReasonWorkClosed, now
//     and for as long as the retirement lasts. One raised inside the grace would
//     otherwise hold a process open for a decision on work the user has finished
//     with. The *questions* of a closing session are withdrawn separately, by the
//     work layer that knows the work closed (worktree.Manager.RetireSession) —
//     they belong to the session rather than to this process, so they outlive it
//     and cannot be reached from here.
//   - A turn that ends inside the grace ends the process with it.
//   - The grace is a deadline, not a budget that activity extends: a background
//     task started on the way out does not buy the session another day.
//
// Calling it twice for the same session changes nothing — the work store
// reports a change for reasons that have nothing to do with the session (a
// retitle, an edit), and each of those must not restart the grace.
func (m *Manager) RetireSession(sessionID string) {
	p := m.GetProcess(sessionID)
	if p == nil {
		return
	}
	if p.retiring.Swap(true) {
		return
	}

	log := slog.With("sessionId", sessionID, "grace", workCloseGrace)
	log.Info("work closed, retiring its session")

	// Applied to what is on screen right now; everything raised later is caught
	// by the same call from handleEvent.
	p.enforceRetirement()

	time.AfterFunc(workCloseGrace, func() { m.endRetirement(p) })
}

// endRetirement ends the process the grace was armed for, and only that one.
//
// Identity rather than session id, and the case that needs it is ordinary: a
// work can be reopened inside the grace, and the message that follows builds a
// *new* process for the same session. Closing by name would kill that one — a
// turn the user had just started, ended by a timer armed for its predecessor.
//
// removeWhere rather than remove, for the reason closeProcess gives: the stream
// goroutine's defer announces the ending, and announcing it here as well would
// report one death twice.
func (m *Manager) endRetirement(p *Process) {
	if !p.retiring.Load() {
		return
	}
	if len(m.removeWhere(func(candidate *Process) bool { return candidate == p })) == 0 {
		return
	}
	p.closed.Store(true)
	p.agentSession.Close()
	slog.Info("close grace expired, ending the session of a closed work", "sessionId", p.sessionID)
}

// enforceRetirement is what "the work is closed" means for one turn state:
// withdraw every prompt nobody is coming back to answer, and end the process
// once the turn is over.
//
// The withdrawals go in as ordinary events, so a cancelled prompt is recorded,
// reduced and broadcast exactly like one the agent withdrew itself — the client
// needs no second way to learn that a card is dead. Each one clears its own
// blocker, so the recursion this produces is one level per prompt and ends.
//
// Two callers can read the same blocker at once — RetireSession and the stream
// goroutine reaching this at the end of the event that raised it — and then the
// same prompt is withdrawn twice. Left unlocked deliberately: the second
// withdrawal removes a blocker that is already gone, the client's own handling
// of a cancellation is idempotent, and the whole of the cost is one extra line
// in the transcript file. A lock here would have to be re-entrant, because the
// injection re-enters this function.
func (p *Process) enforceRetirement() {
	if !p.retiring.Load() {
		return
	}

	turn := p.turnState()
	for _, blocker := range turn.Blockers {
		if blocker.RequestID == "" {
			// A background wait: nobody raised it and nobody can answer it. It
			// ends with the process at the grace deadline.
			continue
		}
		p.inject(agent.RequestCancelledEvent{
			RequestID: blocker.RequestID,
			Reason:    agent.ReasonWorkClosed,
		})
		return // The injection re-enters here with the blocker already gone.
	}

	if p.turnState().InProgress() {
		return
	}
	// Asynchronously, and by identity: this runs on the process's own event
	// stream, which the close has to be able to finish without waiting for.
	go p.manager.endRetirement(p)
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
		// with a cancel before it stops the turn; Claude needs no equivalent —
		// its CLI acts on the interrupt while it is blocked on a control
		// request, withdrawing that request and ending the turn (measured on
		// claude-code 2.1.263; the shared integration suite's
		// InterruptWhileBlocked keeps it honest). The grace backstop in
		// requestStop stays for the CLI that is wedged rather than merely
		// blocked. Either way the wait ends.
		//
		// A permission request is the only thing this can expire, and expiring
		// one is final: a permission nobody granted is a denial. That is why the
		// budget is an hour rather than a day (session.DefaultAnswerBudget).
		//
		// Noted before the stop is asked for, because the stop is what ends the
		// prompts: whichever way the turn goes away from here, the cards it
		// leaves behind expired for want of an answer in time, and that is what
		// they say (recordExpiries).
		p.noteAnswerTimeout()
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
//
// A prompt also cancels a retirement, and that is not a special case bolted on:
// retirement means "nobody is coming back to this session", and somebody just
// did. It happens for real — a work closed and reopened inside the grace sends
// its restart message to this very process, and a user can type into a closed
// work's chat at any time. Without this, the turn they started would be ended by
// a timer armed before it existed. The work stays closed either way; what the
// session's process is worth from then on is the ordinary idle lease's business.
func (p *Process) SendMessage(prompt string) error {
	p.retiring.Store(false)
	p.startTurn()
	return p.agentSession.SendMessage(prompt)
}

// SendPermissionResponse answers a permission request, which clears the blocker
// that request raised and lets the turn carry on.
func (p *Process) SendPermissionResponse(data agent.PermissionRequestData, choice agent.PermissionChoice) error {
	if !p.turnState().AwaitingAnswerTo(data.RequestID) {
		return ErrRequestNotPending
	}
	p.answerPrompt(data.RequestID)
	return p.agentSession.SendPermissionResponse(data, choice)
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
	ctx := context.Background()
	in := session.TurnInput{Signal: sig, RequestID: requestID, At: time.Now()}
	transition := p.applyTurn(ctx, in)
	p.manager.emitTurn(p.sessionID, transition)
	p.recordExpiries(ctx, slog.With("sessionId", p.sessionID), in.Signal, transition.Expired)
}

// recordExpiries writes what became of each prompt this input ended without an
// answer, as an ordinary request_cancelled record carrying the reason.
//
// It is the only record of a blocker's fate, and Pockode's own: the CLI is
// killed with SIGKILL, so its transcript may not hold even the frame that raised
// the request, and a client that pages back through history would otherwise
// replay a card as still pending long after nothing could decide it.
//
// Written directly rather than injected, for two reasons. The blocker is
// already gone from the turn state, so there is nothing left to reduce — this
// is a record of something that happened, not a signal that it should. And a
// process on its way out is exactly when this has to be written, while inject
// deliberately refuses to speak for one.
func (p *Process) recordExpiries(ctx context.Context, log *slog.Logger, sig session.TurnSignal, expired []session.Blocker) {
	for _, blocker := range expired {
		if blocker.RequestID == "" {
			// A background wait: nobody raised it with the user and nobody was
			// going to answer it, so there is no card to settle.
			continue
		}
		reason := p.expiryReason(sig, blocker.RequestID)
		log.Info("blocker expired unanswered",
			"kind", blocker.Kind, "requestId", blocker.RequestID,
			"raisedAt", blocker.RaisedAt, "cause", sig, "reason", reason)

		event := agent.RequestCancelledEvent{RequestID: blocker.RequestID, Reason: reason}
		seq, err := p.sessionStore.AppendToHistory(ctx, p.sessionID, agent.NewEventRecord(event))
		if err != nil {
			// A deleted session is the ordinary case here: its process is torn
			// down asynchronously, so an expiry can outlive the session it
			// describes.
			log.Debug("failed to record an expired request", "requestId", blocker.RequestID, "error", err)
			continue
		}
		p.manager.EmitMessage(p.sessionID, event, seq)
	}
}

// expiryReason says why this prompt was never answered, in the two cases
// Pockode can tell apart from the outside.
//
// Everything else is left empty on purpose: a turn that simply ended, or a user
// who sent a message instead of answering, leaves a card that cannot be
// answered any more for a reason no one banner can state. The client says what
// is true of all of them rather than guessing (docs/lifecycle-ui.md §5).
//
// SignalProcessStarted is not here even though it expires blockers too: that is
// a successor clearing up after a process that died without saying so, and the
// session store has already written a process_ended record for exactly that
// case when it loaded the index (see abortTurnsTheLastRunLeftOpen).
func (p *Process) expiryReason(sig session.TurnSignal, requestID string) agent.CancelReason {
	if p.takeAnswerTimeout(requestID) {
		return agent.ReasonTimeout
	}
	if sig == session.SignalProcessEnded {
		return agent.ReasonProcessEnded
	}
	return ""
}

// noteAnswerTimeout marks every prompt currently on screen as one the answer
// lease gave up on, so that whichever way the turn ends from here, the cards it
// leaves behind say why.
func (p *Process) noteAnswerTimeout() {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, blocker := range p.turn.Blockers {
		if blocker.RequestID == "" {
			continue
		}
		if p.timedOut == nil {
			p.timedOut = make(map[string]struct{})
		}
		p.timedOut[blocker.RequestID] = struct{}{}
	}
}

// takeAnswerTimeout reports whether this prompt ran out of time, and forgets it
// either way: a prompt expires once, so the answer is wanted once.
//
// A mark whose prompt was resolved rather than expired — the CLI withdrew it on
// its own after the interrupt — is simply never taken. It cannot be misread by
// anything else, request ids being unique, and it goes with the process.
func (p *Process) takeAnswerTimeout(requestID string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	_, marked := p.timedOut[requestID]
	delete(p.timedOut, requestID)
	return marked
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

	// What became of an expired blocker is recorded by recordExpiries, which the
	// callers that can announce things reach after this returns. Not here:
	// process creation applies a turn under processesMu, and broadcasting from
	// under that lock would deadlock against the listeners that take it.
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

// TurnState is what this process's session is doing right now.
//
// Exported for the send path, which has to know what the agent is in the middle
// of before handing it anything: a CLI holding a permission request open is not
// reading its input at all (see chat.ErrTurnAwaitingAnswer). Everything else
// outside this package reads the turn off the session store, which is the same
// value — this is here so that a caller deciding whether to send does not have
// to re-read the store the send is about to write.
func (p *Process) TurnState() session.TurnState {
	return p.turnState()
}

// State is the session's turn seen through the two values a process has always
// had. It is a narrowing, not the state itself — see StateChangeEvent.
func (p *Process) State() ProcessState {
	return viewTurn(p.turnState())
}

// viewTurn narrows a TurnState down to "is this process producing output".
//
// Blocked on a person reads as idle: nothing is being produced, and that is what
// makes the session go unread — the one thing that still reads this. Blocked on
// background work reads as running, which is where the narrowing loses something
// real, and is why nothing but the unread mark is allowed to be written in terms
// of it.
func viewTurn(turn session.TurnState) ProcessState {
	if turn.AwaitingUserAnswer() {
		return ProcessStateIdle
	}
	if turn.InProgress() {
		return ProcessStateRunning
	}
	return ProcessStateIdle
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
	m.emitStateChange(sessionID, viewTurn(transition.State))
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

	if reduce && transition.Changed {
		// After the announcement, so that anything woken by the turn change sees
		// the same state this decides on.
		p.enforceRetirement()
	}

	if eventType.AwaitsUserInput() {
		if err := p.sessionStore.Touch(ctx, p.sessionID); err != nil {
			log.Error("failed to touch session", "error", err)
		}
	}

	// Emit to listener (ChatMessagesWatcher)
	p.manager.EmitMessage(p.sessionID, event, seq)

	// Last, and after this event's own broadcast, so a subscriber sees the
	// records in the order history holds them: the ending, then what that
	// ending did to the prompts on screen. Announcing them first would hand a
	// client a higher sequence number before the one below it.
	if reduce {
		p.recordExpiries(ctx, log, in.Signal, transition.Expired)
	}
}
