package work

import (
	"context"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"
)

// MessageSender sends messages to agent sessions.
// Satisfied by *chat.Client.
type MessageSender interface {
	SendMessage(ctx context.Context, sessionID, content string) error
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
type AutoResumer struct {
	workStore    Store
	sender       atomic.Pointer[MessageSender]
	stepProvider atomic.Pointer[StepProvider]
	ctx          context.Context
	cancel       context.CancelFunc
	retryMu      sync.Mutex
	retries      map[string]int  // sessionID → retry count
	continuing   map[string]bool // sessionID → auto-continuation pending
	maxRetries   int
	settleDelay  time.Duration // delay before checking work status after process stop
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
		maxRetries:  maxRetries,
		settleDelay: defaultSettleDelay,
	}
}

// Stop cancels all pending goroutines (settle delays and in-flight sends).
func (r *AutoResumer) Stop() {
	r.cancel()
}

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
		} else {
			slog.Info("stopped orphaned work on startup", "workId", w.ID, "sessionId", w.SessionID)
		}
	}
}

// SetSender sets the message sender. Called when the main worktree is initialized.
func (r *AutoResumer) SetSender(sender MessageSender) {
	r.sender.Store(&sender)
}

func (r *AutoResumer) getSender() MessageSender {
	if p := r.sender.Load(); p != nil {
		return *p
	}
	return nil
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
		r.retryMu.Unlock()
		if !pending {
			go r.handleProcessEnded(sessionID)
		}
		return
	}

	// Process running: sync stopped work back to in_progress.
	// This covers the case where a user sends a message to a session
	// whose work was stopped (e.g. after process exit), bypassing work_start.
	if state == "running" {
		r.handleProcessRunning(sessionID)
		return
	}

	// User-initiated interrupt: stop work without auto-continuation.
	if interrupted {
		go r.handleProcessEnded(sessionID)
		return
	}

	sender := r.getSender()
	if sender == nil {
		return
	}

	// Only trigger on idle without NeedsInput (normal stop or error).
	// Ignore the initial idle emitted on process creation — the agent hasn't started yet.
	if state != "idle" || needsInput || isInitial {
		return
	}

	r.retryMu.Lock()
	r.continuing[sessionID] = true
	r.retryMu.Unlock()

	go r.handleAutoContinuation(sessionID, sender)
}

// handleProcessEnded transitions in_progress/needs_input/waiting work to stopped when its process terminates.
// This catches cases like user interrupt or unexpected process exit.
func (r *AutoResumer) handleProcessEnded(sessionID string) {
	// Use the same settle delay as auto-continuation to allow step_done to propagate.
	select {
	case <-time.After(r.settleDelay):
	case <-r.ctx.Done():
		return
	}

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

	// Clean up retry tracking
	r.retryMu.Lock()
	delete(r.retries, sessionID)
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

	if err := r.workStore.Reactivate(r.ctx, w.ID); err != nil {
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

func (r *AutoResumer) handleAutoContinuation(sessionID string, sender MessageSender) {
	defer func() {
		r.retryMu.Lock()
		delete(r.continuing, sessionID)
		r.retryMu.Unlock()
	}()

	// Let an in-flight step_done's in-process retry reset land before we read
	// the retry count below. Use select so we abort immediately on shutdown.
	select {
	case <-time.After(r.settleDelay):
	case <-r.ctx.Done():
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

	// Build message with step context if available.
	var msg string
	if sp := r.getStepProvider(); sp != nil {
		if steps, err := sp.GetSteps(w.AgentRoleID); err == nil && len(steps) > 0 {
			msg = BuildAutoContinuationMessageWithSteps(*w, steps, w.CurrentStep)
		}
	}
	if msg == "" {
		msg = BuildAutoContinuationMessage(*w)
	}

	if err := sender.SendMessage(r.ctx, sessionID, msg); err != nil {
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
			r.retryMu.Lock()
			delete(r.retries, event.Work.SessionID)
			r.retryMu.Unlock()
		}
		return
	}

	if event.Op != OperationUpdate {
		return
	}

	// Reset retries when work completes or stops
	if event.Work.Status == StatusClosed || event.Work.Status == StatusStopped {
		if event.Work.SessionID != "" {
			r.retryMu.Lock()
			delete(r.retries, event.Work.SessionID)
			r.retryMu.Unlock()
		}
	}

	// Child closed → parent reactivation
	sender := r.getSender()
	if sender == nil {
		return
	}
	if event.Work.Status != StatusClosed || event.Work.ParentID == "" {
		return
	}

	go r.handleParentReactivation(event.Work, sender)
}

// NotifyStepDone sends the next-step prompt after an in-process step advance.
// The MCP step_done tool mutates the store via the local API, so the API path
// requests this follow-up message explicitly. Safe to call when the work has
// closed: sendStepAdvance bounds-checks the step index.
func (r *AutoResumer) NotifyStepDone(w Work) {
	sender := r.getSender()
	sp := r.getStepProvider()
	// Only prompt the next step when the work is still running: a concurrent
	// transition (e.g. process-ended → stopped, or work_needs_input) may land
	// between the caller's StepDone and its re-read.
	if sender == nil || sp == nil || w.SessionID == "" || w.Status != StatusInProgress {
		return
	}
	go r.sendStepAdvance(w, sender, sp)
}

// NotifyReopen sends the reopen message after an in-process work_reopen.
func (r *AutoResumer) NotifyReopen(w Work) {
	sender := r.getSender()
	if sender == nil || w.SessionID == "" {
		return
	}
	go r.sendReopen(w, sender)
}

// sendStepAdvance sends the next-step prompt to the agent session after a step
// advance.
func (r *AutoResumer) sendStepAdvance(w Work, sender MessageSender, sp StepProvider) {
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

	// Reset retry count (new step context)
	r.retryMu.Lock()
	delete(r.retries, w.SessionID)
	r.retryMu.Unlock()

	msg := BuildStepAdvanceMessage(w, steps[w.CurrentStep], w.CurrentStep+1, len(steps))
	if err := sender.SendMessage(r.ctx, w.SessionID, msg); err != nil {
		if r.ctx.Err() != nil {
			return
		}
		slog.Warn("failed to send step advance message", "workId", w.ID, "step", w.CurrentStep, "error", err)
	} else {
		slog.Info("step advance message sent", "workId", w.ID, "sessionId", w.SessionID, "step", w.CurrentStep+1, "totalSteps", len(steps))
	}
}

// sendReopen sends the reopen message to the agent session.
func (r *AutoResumer) sendReopen(w Work, sender MessageSender) {
	// Reset retry count (new activity context)
	r.retryMu.Lock()
	delete(r.retries, w.SessionID)
	r.retryMu.Unlock()

	msg := BuildReopenMessage(w)
	if err := sender.SendMessage(r.ctx, w.SessionID, msg); err != nil {
		if r.ctx.Err() != nil {
			return
		}
		slog.Warn("failed to send reopen message", "workId", w.ID, "error", err)
	} else {
		slog.Info("reopen message sent", "workId", w.ID, "sessionId", w.SessionID)
	}
}

func (r *AutoResumer) handleParentReactivation(child Work, sender MessageSender) {
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

	// Handle waiting parent: transition to in_progress
	if parent.Status == StatusWaiting {
		if err := r.workStore.ResumeFromWaiting(r.ctx, parent.ID); err != nil {
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
	if err := sender.SendMessage(r.ctx, parent.SessionID, msg); err != nil {
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
