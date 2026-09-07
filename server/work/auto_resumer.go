package work

import (
	"context"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pockode/server/agent"
)

// MessageSender sends system-driven automatic messages to agent sessions.
// Satisfied by *chat.Client.
type MessageSender interface {
	SendSystemMessage(ctx context.Context, sessionID, content, subtype string, meta *agent.MessageMeta) error
}

// SenderResolver resolves the MessageSender for a given worktree so that a
// work's automatic follow-up messages reach the worktree the work actually runs
// in. It returns a release func the caller MUST invoke once the send completes
// (worktrees are reference-counted). Satisfied by the worktree Manager.
type SenderResolver interface {
	ResolveSender(worktree string) (sender MessageSender, release func(), err error)
}

// staticResolver routes every worktree to a single sender. Used by SetSender
// for tests and callers that don't need per-worktree routing.
type staticResolver struct{ sender MessageSender }

func (s staticResolver) ResolveSender(string) (MessageSender, func(), error) {
	return s.sender, func() {}, nil
}

// StepProvider provides step information for agent roles.
// The work package uses this interface to avoid importing agentrole.
type StepProvider interface {
	GetSteps(agentRoleID string) ([]string, error)
}

// AutoResumer handles automatic triggers for Work sessions:
//
// Process lifecycle sync:
//   - idle → send a continuation message to resume in_progress work.
//   - running → transition stopped work back to in_progress.
//   - ended → transition in_progress/needs_input work to stopped.
//
// Child closure: When a child Work closes, notify its parent. Waiting parents
// transition to in_progress; other active parents (in_progress, needs_input,
// stopped) receive the message without state change. Open and closed parents
// are skipped.
//
// Step advance / reopen follow-ups: NotifyStepDone and NotifyReopen send the
// next-step and reopen prompts after the MCP API mutates a work item in-process.
//
// None of the message-driven senders (step advance, reopen, child closure) check
// whether the session is holding a turn open for background work; they send
// immediately, exactly as a user typing during that wait would. That is a
// deliberate trade-off, not an oversight — see docs/code/work-system.md,
// "Follow-ups During a Background Wait".
type AutoResumer struct {
	workStore    Store
	resolver     atomic.Pointer[SenderResolver]
	stepProvider atomic.Pointer[StepProvider]
	ctx          context.Context
	cancel       context.CancelFunc
	retryMu      sync.Mutex
	retries      map[string]int    // sessionID → retry count
	continuing   map[string]bool   // sessionID → auto-continuation pending
	activations  map[string]uint64 // sessionID → sequence number of the session's latest start
	// Numbers activations globally rather than per session, so that an entry
	// dropped by forgetSession is never re-created with a number some pending
	// follow-up captured before the drop — that would make a stale event look
	// current and stop work the session is running right now.
	activationSeq uint64
	maxRetries    int
	settleDelay   time.Duration // delay before checking work status after process stop
}

// defaultSettleDelay is the time to wait after a process goes idle/ends before
// deciding whether its work still needs attention. An agent typically calls
// step_done (via the MCP API) right before its turn ends; the delay lets that
// in-process transition's retry reset land before handleAutoContinuation reads
// the retry count, keeping the stop-after-N accounting correct. 2s is generous.
const defaultSettleDelay = 2 * time.Second

func NewAutoResumer(workStore Store, maxRetries int) *AutoResumer {
	ctx, cancel := context.WithCancel(context.Background())
	return &AutoResumer{
		workStore:   workStore,
		ctx:         ctx,
		cancel:      cancel,
		retries:     make(map[string]int),
		continuing:  make(map[string]bool),
		activations: make(map[string]uint64),
		maxRetries:  maxRetries,
		settleDelay: defaultSettleDelay,
	}
}

// Stop cancels all pending goroutines (settle delays and in-flight sends).
func (r *AutoResumer) Stop() {
	r.cancel()
}

// orphanedWorkComment explains a stop nobody asked for. Background tasks are
// called out because they are the part a user is least likely to expect to have
// died: they were started to outlive a turn, and they do — but not the process.
const orphanedWorkComment = "Stopped automatically: the Pockode server restarted while this work was still open. " +
	"No agent process survives a restart, so anything that was running for this work — including background tasks — " +
	"is gone and no result is coming from it. Reopen the work to continue it."

// StopOrphanedWork transitions all in_progress, needs_input, and waiting work items to stopped.
// Call this at server startup before any sessions are created, so that work
// items left running from a previous server run are properly marked.
func (r *AutoResumer) StopOrphanedWork() {
	works, err := r.workStore.List()
	if err != nil {
		slog.Warn("failed to list works for orphan detection", "error", err)
		return
	}

	for _, w := range works {
		if w.Status != StatusInProgress && w.Status != StatusNeedsInput && w.Status != StatusWaiting {
			continue
		}
		if err := r.stopWork(w.ID); err != nil {
			slog.Warn("failed to stop orphaned work", "workId", w.ID, "error", err)
			continue
		}
		slog.Info("stopped orphaned work on startup", "workId", w.ID, "sessionId", w.SessionID)
		// Say why, or the work is simply found stopped with no explanation and
		// no hint that whatever the agent had running is gone too.
		if _, err := r.workStore.AddComment(r.ctx, w.ID, orphanedWorkComment); err != nil {
			slog.Warn("failed to explain why orphaned work was stopped", "workId", w.ID, "error", err)
		}
	}
}

// SetSenderResolver installs the per-worktree sender resolver. Production wires
// the worktree Manager here so each work's automatic messages route to its own
// worktree's chat client.
func (r *AutoResumer) SetSenderResolver(resolver SenderResolver) {
	r.resolver.Store(&resolver)
}

// SetSender installs a single sender used for every worktree. Convenience for
// tests and callers that don't need per-worktree routing.
func (r *AutoResumer) SetSender(sender MessageSender) {
	r.SetSenderResolver(staticResolver{sender: sender})
}

func (r *AutoResumer) getResolver() SenderResolver {
	if p := r.resolver.Load(); p != nil {
		return *p
	}
	return nil
}

// resolveSender resolves the sender for the given worktree. Returns ok=false
// when no resolver is installed or resolution fails. When ok is true the caller
// MUST invoke the returned release once the send completes.
func (r *AutoResumer) resolveSender(worktree string) (sender MessageSender, release func(), ok bool) {
	resolver := r.getResolver()
	if resolver == nil {
		return nil, nil, false
	}
	sender, release, err := resolver.ResolveSender(worktree)
	if err != nil {
		if r.ctx.Err() == nil {
			slog.Warn("failed to resolve message sender", "worktree", worktree, "error", err)
		}
		return nil, nil, false
	}
	if sender == nil {
		if release != nil {
			release()
		}
		return nil, nil, false
	}
	if release == nil {
		release = func() {}
	}
	return sender, release, true
}

// SetStepProvider sets the provider for agent role step information.
func (r *AutoResumer) SetStepProvider(sp StepProvider) {
	r.stepProvider.Store(&sp)
}

func (r *AutoResumer) getStepProvider() StepProvider {
	if p := r.stepProvider.Load(); p != nil {
		return *p
	}
	return nil
}

// stepCount is the number of steps the work's role defines, or 0 when that is
// unknown. Unknown and stepless are deliberately the same answer: both mean
// "no step context to report", and a missing provider must not block a message.
func (r *AutoResumer) stepCount(w Work) int {
	sp := r.getStepProvider()
	if sp == nil {
		return 0
	}
	steps, err := sp.GetSteps(w.AgentRoleID)
	if err != nil {
		slog.Warn("failed to get steps for message meta", "agentRoleId", w.AgentRoleID, "error", err)
		return 0
	}
	return len(steps)
}

// HandleProcessStateChange syncs work status with process lifecycle:
//   - running → reactivate stopped work to in_progress.
//   - idle → send auto-continuation message for in_progress work.
//   - idle (interrupted) → stop work without auto-continuation.
//   - ended → transition in_progress/needs_input work to stopped.
//
// Parameters are extracted from process.StateChangeEvent to avoid importing the process package.
func (r *AutoResumer) HandleProcessStateChange(sessionID, state string, needsInput, isInitial, interrupted bool) {
	// Process ended: transition in_progress work to stopped,
	// but only if auto-continuation isn't already handling this session.
	if state == "ended" {
		r.retryMu.Lock()
		pending := r.continuing[sessionID]
		activation := r.activations[sessionID]
		r.retryMu.Unlock()
		if !pending {
			go r.handleProcessEnded(sessionID, activation)
		}
		return
	}

	// Process running: sync stopped work back to in_progress.
	// This covers the case where a user sends a message to a session
	// whose work was stopped (e.g. after process exit), bypassing work_start.
	if state == "running" {
		r.retryMu.Lock()
		r.activationSeq++
		r.activations[sessionID] = r.activationSeq
		r.retryMu.Unlock()
		r.handleProcessRunning(sessionID)
		return
	}

	// The turn was aborted rather than finished — a user interrupt, a denied
	// permission, a turn replaced by the next one. Stop the work instead of
	// nudging the agent to carry on with something it was told to abandon.
	if interrupted {
		r.retryMu.Lock()
		activation := r.activations[sessionID]
		r.retryMu.Unlock()
		go r.handleProcessEnded(sessionID, activation)
		return
	}

	if r.getResolver() == nil {
		return
	}

	// Only trigger on idle without NeedsInput (normal stop or error).
	// Ignore the initial idle emitted on process creation — the agent hasn't started yet.
	if state != "idle" || needsInput || isInitial {
		return
	}

	r.retryMu.Lock()
	r.continuing[sessionID] = true
	activation := r.activations[sessionID]
	r.retryMu.Unlock()

	go r.handleAutoContinuation(sessionID, activation)
}

// settled waits out the settle delay and reports whether the lifecycle event
// that started the wait still describes the session.
//
// Both delayed handlers decide what to do about a session that stopped, and a
// session can start running again inside the delay: an aborted turn is followed
// immediately by its replacement, and a user can answer a dead session's prompt,
// which builds a new process. Acting on the older event would then stop or nudge
// work that is running right now. activation is the number read when the event
// arrived; HandleProcessStateChange assigns a new one on every running, so any
// change — including the entry being dropped — means the event is stale.
func (r *AutoResumer) settled(sessionID string, activation uint64) bool {
	select {
	case <-time.After(r.settleDelay):
	case <-r.ctx.Done():
		return false
	}

	r.retryMu.Lock()
	current := r.activations[sessionID]
	r.retryMu.Unlock()

	if current != activation {
		slog.Info("session active again, skipping stale lifecycle follow-up", "sessionId", sessionID)
		return false
	}
	return true
}

// handleProcessEnded transitions in_progress/needs_input/waiting work to stopped when its process terminates.
// This catches cases like user interrupt or unexpected process exit.
func (r *AutoResumer) handleProcessEnded(sessionID string, activation uint64) {
	// Use the same settle delay as auto-continuation to allow step_done to propagate.
	if !r.settled(sessionID, activation) {
		return
	}

	// The session stopped and never came back within the settle window, so nothing
	// is left to follow up on. This is the only cleanup a session without a work
	// item ever gets — OnWorkChange never fires for one.
	defer r.forgetSession(sessionID)

	w := r.findWorkBySessionID(sessionID, StatusInProgress, StatusNeedsInput, StatusWaiting)
	if w == nil {
		return
	}

	if err := r.stopWork(w.ID); err != nil {
		if r.ctx.Err() == nil {
			slog.Warn("failed to stop work after process ended", "workId", w.ID, "error", err)
		}
	} else {
		slog.Info("work stopped after process ended", "workId", w.ID, "sessionId", sessionID)
	}
}

// forgetSession drops all per-session tracking once nothing is following up on
// the session. Safe to call while a follow-up is still in flight: the dropped
// activation reads back as 0, which that follow-up sees as a mismatch and skips.
func (r *AutoResumer) forgetSession(sessionID string) {
	r.retryMu.Lock()
	delete(r.retries, sessionID)
	delete(r.activations, sessionID)
	r.retryMu.Unlock()
}

// handleProcessRunning transitions stopped work back to in_progress when its
// process starts running. This handles the case where a user sends a message
// directly to a session (bypassing work_start), reactivating the process.
func (r *AutoResumer) handleProcessRunning(sessionID string) {
	w := r.findWorkBySessionID(sessionID, StatusStopped)
	if w == nil {
		return
	}

	if err := r.workStore.MarkRunning(r.ctx, w.ID); err != nil {
		if r.ctx.Err() == nil {
			slog.Warn("failed to reactivate stopped work on process running", "workId", w.ID, "error", err)
		}
		return
	}

	// Reset retry count — fresh activity context
	r.retryMu.Lock()
	delete(r.retries, sessionID)
	r.retryMu.Unlock()

	slog.Info("stopped work reactivated by process running", "workId", w.ID, "sessionId", sessionID)
}

func (r *AutoResumer) handleAutoContinuation(sessionID string, activation uint64) {
	defer func() {
		r.retryMu.Lock()
		delete(r.continuing, sessionID)
		r.retryMu.Unlock()
	}()

	// Let an in-flight step_done's in-process retry reset land before we read
	// the retry count below.
	if !r.settled(sessionID, activation) {
		return
	}

	w := r.findWorkBySessionID(sessionID, StatusInProgress)
	if w == nil {
		return
	}

	r.retryMu.Lock()
	count := r.retries[sessionID]
	if count >= r.maxRetries {
		r.retryMu.Unlock()
		slog.Info("auto-resume retry limit reached, stopping work", "sessionId", sessionID, "workId", w.ID)
		if err := r.stopWork(w.ID); err != nil {
			if r.ctx.Err() == nil {
				slog.Warn("failed to stop work after retry limit", "workId", w.ID, "error", err)
			}
		}
		return
	}
	r.retries[sessionID] = count + 1
	r.retryMu.Unlock()

	sender, release, ok := r.resolveSender(w.Worktree)
	if !ok {
		return
	}
	defer release()

	// Build message with step context if available.
	var msg string
	totalSteps := 0
	if sp := r.getStepProvider(); sp != nil {
		if steps, err := sp.GetSteps(w.AgentRoleID); err == nil && len(steps) > 0 {
			msg = BuildAutoContinuationMessageWithSteps(*w, steps, w.CurrentStep)
			totalSteps = len(steps)
		}
	}
	if msg == "" {
		msg = BuildAutoContinuationMessage(*w)
	}
	meta := NewMessageMeta(*w, w.CurrentStep+1, totalSteps)

	if err := sender.SendSystemMessage(r.ctx, sessionID, msg, MessageSubtypeAutoContinue, meta); err != nil {
		if r.ctx.Err() != nil {
			return // shutting down, don't log
		}
		slog.Warn("failed to send auto-continuation message", "sessionId", sessionID, "error", err)
	} else {
		slog.Info("auto-continuation sent", "sessionId", sessionID, "workId", w.ID, "retry", count+1)
	}
}

// OnWorkChange implements OnChangeListener.
func (r *AutoResumer) OnWorkChange(event ChangeEvent) {
	// Clean up tracking state on delete
	if event.Op == OperationDelete {
		if event.Work.SessionID != "" {
			r.forgetSession(event.Work.SessionID)
		}
		return
	}

	if event.Op != OperationUpdate {
		return
	}

	// Drop tracking when work completes or stops; a later turn on the same session
	// starts from a clean retry count and a fresh activation number.
	if event.Work.Status == StatusClosed || event.Work.Status == StatusStopped {
		if event.Work.SessionID != "" {
			r.forgetSession(event.Work.SessionID)
		}
	}

	// Child closed → parent reactivation
	if r.getResolver() == nil {
		return
	}
	if event.Work.Status != StatusClosed || event.Work.ParentID == "" {
		return
	}

	go r.handleParentReactivation(event.Work)
}

// NotifyStepDone sends the next-step prompt after an in-process step advance.
// The MCP step_done tool mutates the store via the local API, so the API path
// requests this follow-up message explicitly. Safe to call when the work has
// closed: sendStepAdvance bounds-checks the step index.
func (r *AutoResumer) NotifyStepDone(w Work) {
	sp := r.getStepProvider()
	// Only prompt the next step when the work is still running: a concurrent
	// transition (e.g. process-ended → stopped, or work_needs_input) may land
	// between the caller's StepDone and its re-read.
	if r.getResolver() == nil || sp == nil || w.SessionID == "" || w.Status != StatusInProgress {
		return
	}
	go r.sendStepAdvance(w, sp)
}

// NotifyReopen sends the reopen message after an in-process work_reopen.
func (r *AutoResumer) NotifyReopen(w Work) {
	if r.getResolver() == nil || w.SessionID == "" {
		return
	}
	go r.sendReopen(w)
}

// sendStepAdvance sends the next-step prompt to the agent session after a step
// advance.
func (r *AutoResumer) sendStepAdvance(w Work, sp StepProvider) {
	steps, err := sp.GetSteps(w.AgentRoleID)
	if err != nil {
		if r.ctx.Err() == nil {
			slog.Warn("failed to get steps for step advance", "agentRoleId", w.AgentRoleID, "error", err)
		}
		return
	}

	// CurrentStep is already advanced; validate bounds
	if len(steps) == 0 || w.CurrentStep >= len(steps) {
		return
	}

	sender, release, ok := r.resolveSender(w.Worktree)
	if !ok {
		return
	}
	defer release()

	// Reset retry count (new step context)
	r.retryMu.Lock()
	delete(r.retries, w.SessionID)
	r.retryMu.Unlock()

	msg := BuildStepAdvanceMessage(w, steps[w.CurrentStep], w.CurrentStep+1, len(steps))
	meta := NewMessageMeta(w, w.CurrentStep+1, len(steps))
	if err := sender.SendSystemMessage(r.ctx, w.SessionID, msg, MessageSubtypeStepAdvance, meta); err != nil {
		if r.ctx.Err() != nil {
			return
		}
		slog.Warn("failed to send step advance message", "workId", w.ID, "step", w.CurrentStep, "error", err)
	} else {
		slog.Info("step advance message sent", "workId", w.ID, "sessionId", w.SessionID, "step", w.CurrentStep+1, "totalSteps", len(steps))
	}
}

// sendReopen sends the reopen message to the agent session.
func (r *AutoResumer) sendReopen(w Work) {
	sender, release, ok := r.resolveSender(w.Worktree)
	if !ok {
		return
	}
	defer release()

	// Reset retry count (new activity context)
	r.retryMu.Lock()
	delete(r.retries, w.SessionID)
	r.retryMu.Unlock()

	msg := BuildReopenMessage(w)
	meta := NewMessageMeta(w, w.CurrentStep+1, r.stepCount(w))
	if err := sender.SendSystemMessage(r.ctx, w.SessionID, msg, MessageSubtypeReopen, meta); err != nil {
		if r.ctx.Err() != nil {
			return
		}
		slog.Warn("failed to send reopen message", "workId", w.ID, "error", err)
	} else {
		slog.Info("reopen message sent", "workId", w.ID, "sessionId", w.SessionID)
	}
}

func (r *AutoResumer) handleParentReactivation(child Work) {
	parent, found, err := r.workStore.Get(child.ParentID)
	if err != nil {
		slog.Warn("failed to get parent work for reactivation", "parentId", child.ParentID, "error", err)
		return
	}
	if !found {
		return
	}

	if parent.SessionID == "" {
		return
	}

	// StatusOpen and StatusClosed parents don't receive child completion messages.
	// Open: no agent session started yet.
	// Closed: parent was explicitly closed and should stay closed.
	if parent.Status == StatusOpen || parent.Status == StatusClosed {
		return
	}

	// Resolve the sender before mutating state so a resolve failure doesn't leave
	// a waiting parent resumed but un-nudged. Route to the parent's own worktree
	// (children share it, but the parent is authoritative for its session).
	sender, release, ok := r.resolveSender(parent.Worktree)
	if !ok {
		return
	}
	defer release()

	// Handle waiting parent: transition to in_progress
	if parent.Status == StatusWaiting {
		if err := r.workStore.MarkRunning(r.ctx, parent.ID); err != nil {
			if r.ctx.Err() != nil {
				return
			}
			slog.Warn("failed to resume waiting parent work", "parentId", parent.ID, "error", err)
			return
		}

		// Reset retry count (new activity context)
		r.retryMu.Lock()
		delete(r.retries, parent.SessionID)
		r.retryMu.Unlock()
	}

	// Send child completion message to parent (StatusInProgress, StatusNeedsInput, StatusWaiting->InProgress, StatusStopped)
	msg := BuildChildCompletionMessage(parent, child.Title, child.ID)
	// Addressed to the parent's session, so the meta describes the parent; the
	// child rides along in its own field.
	meta := NewMessageMeta(parent, parent.CurrentStep+1, r.stepCount(parent))
	meta.Child = &agent.ChildInfo{ID: child.ID, Title: child.Title}
	if err := sender.SendSystemMessage(r.ctx, parent.SessionID, msg, MessageSubtypeChildDone, meta); err != nil {
		if r.ctx.Err() != nil {
			return
		}
		slog.Warn("failed to send child completion message to parent", "parentId", parent.ID, "childId", child.ID, "error", err)
	} else {
		slog.Info("child completion message sent to parent", "parentId", parent.ID, "childId", child.ID, "parentStatus", parent.Status)
	}
}

func (r *AutoResumer) stopWork(workID string) error {
	return r.workStore.Stop(r.ctx, workID)
}

func (r *AutoResumer) findWorkBySessionID(sessionID string, statuses ...WorkStatus) *Work {
	w, found, err := r.workStore.FindBySessionID(sessionID)
	if err != nil {
		slog.Warn("failed to find work by session ID", "sessionId", sessionID, "error", err)
		return nil
	}
	if !found {
		return nil
	}
	for _, s := range statuses {
		if w.Status == s {
			return &w
		}
	}
	return nil
}
