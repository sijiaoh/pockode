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

// WorkStartHandler handles the full lifecycle of starting a work session
// (create session, set title, send kickoff message).
// For restarts (reused sessionID), the implementation should detect the
// existing session and send a restart message instead.
// Satisfied by worktree integration code in the main server.
type WorkStartHandler interface {
	HandleWorkStart(ctx context.Context, w Work) error
}

// AutoResumer handles automatic triggers for Work sessions:
//
// Process lifecycle sync:
//   - idle → send a continuation message to resume in_progress work.
//   - running → transition stopped work back to in_progress.
//   - ended → transition in_progress/needs_input work to stopped.
//
// Trigger B: When a child Work closes, transition the parent from done to
// in_progress and send a message so the agent can review and call work_done.
//
// Trigger C: When a work item is started externally (e.g. via MCP),
// create the session and send the kickoff message.
//
// Trigger D: Reserved (removed — step advance is now handled by Trigger E).
//
// Trigger E: When a work item's CurrentStep is advanced externally (via MCP step_done),
// send the next step prompt to continue the task.
type AutoResumer struct {
	workStore     Store
	sender        atomic.Pointer[MessageSender]
	startHandler  atomic.Pointer[WorkStartHandler]
	stepProvider  atomic.Pointer[StepProvider]
	ctx           context.Context
	cancel        context.CancelFunc
	retryMu       sync.Mutex
	retries       map[string]int        // sessionID → retry count
	continuing    map[string]bool       // sessionID → auto-continuation pending
	knownSteps    map[string]int        // workID → last known CurrentStep (for detecting step_done)
	knownStatuses map[string]WorkStatus // workID → last known Status (for detecting reopen)
	maxRetries    int
	settleDelay   time.Duration // delay before checking work status after process stop
}

// defaultSettleDelay is the time to wait after a process stops before checking
// whether its work is still in_progress. This allows MCP work_done writes to
// propagate: agent calls work_done → MCP writes to disk → fsnotify fires
// (debounced 100ms) → store reloads → OnWorkChange resets retries.
// The agent typically calls work_done before its result event triggers idle,
// so 2s is generous. If the write hasn't propagated in time, the worst case
// is a single spurious continuation message.
const defaultSettleDelay = 2 * time.Second

func NewAutoResumer(workStore Store, maxRetries int) *AutoResumer {
	ctx, cancel := context.WithCancel(context.Background())
	return &AutoResumer{
		workStore:     workStore,
		ctx:           ctx,
		cancel:        cancel,
		retries:       make(map[string]int),
		continuing:    make(map[string]bool),
		knownSteps:    make(map[string]int),
		knownStatuses: make(map[string]WorkStatus),
		maxRetries:    maxRetries,
		settleDelay:   defaultSettleDelay,
	}
}

// Stop cancels all pending goroutines (settle delays and in-flight sends).
func (r *AutoResumer) Stop() {
	r.cancel()
}

// StopOrphanedWork transitions all in_progress, needs_input, and waiting work items to stopped.
// Call this at server startup before any sessions are created, so that work
// items left running from a previous server run are properly marked.
// It also initializes knownStatuses to enable proper reopen detection.
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

	// Initialize knownStatuses after stopping orphans.
	// Re-read works to capture the updated status (stopped).
	works, err = r.workStore.List()
	if err != nil {
		slog.Warn("failed to re-read works for status tracking", "error", err)
		return
	}
	r.retryMu.Lock()
	for _, w := range works {
		r.knownStatuses[w.ID] = w.Status
	}
	r.retryMu.Unlock()
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

// SetStartHandler sets the handler for external work starts (Trigger C).
func (r *AutoResumer) SetStartHandler(h WorkStartHandler) {
	r.startHandler.Store(&h)
}

func (r *AutoResumer) getStartHandler() WorkStartHandler {
	if p := r.startHandler.Load(); p != nil {
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
	// Use the same settle delay as auto-continuation to allow work_done to propagate.
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

	// Wait for MCP work_done writes to propagate via fsnotify.
	// Use select so we abort immediately on shutdown.
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

	// Build message with step context if available (for tasks only)
	var msg string
	if w.Type == WorkTypeTask {
		if sp := r.getStepProvider(); sp != nil {
			if steps, err := sp.GetSteps(w.AgentRoleID); err == nil && len(steps) > 0 {
				msg = BuildAutoContinuationMessageWithSteps(*w, steps, w.CurrentStep)
			}
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
		r.retryMu.Lock()
		if event.Work.SessionID != "" {
			delete(r.retries, event.Work.SessionID)
		}
		delete(r.knownSteps, event.Work.ID)
		delete(r.knownStatuses, event.Work.ID)
		r.retryMu.Unlock()
		return
	}

	if event.Op != OperationUpdate {
		return
	}

	// Detect step and status changes by comparing with known state
	r.retryMu.Lock()
	prevStep, hadPrevStep := r.knownSteps[event.Work.ID]
	r.knownSteps[event.Work.ID] = event.Work.CurrentStep
	stepAdvanced := hadPrevStep && event.Work.CurrentStep > prevStep

	prevStatus, hadPrevStatus := r.knownStatuses[event.Work.ID]
	r.knownStatuses[event.Work.ID] = event.Work.Status
	wasReopened := hadPrevStatus && prevStatus == StatusClosed && event.Work.Status == StatusInProgress
	r.retryMu.Unlock()

	// Reset retries when work completes or stops
	if event.Work.Status == StatusDone || event.Work.Status == StatusClosed || event.Work.Status == StatusStopped {
		if event.Work.SessionID != "" {
			r.retryMu.Lock()
			delete(r.retries, event.Work.SessionID)
			r.retryMu.Unlock()
		}
	}

	// Trigger E: external step_done (via MCP step_done tool).
	// When step is advanced externally and work is still in_progress, send the next step prompt.
	if event.External && stepAdvanced && event.Work.Status == StatusInProgress && event.Work.SessionID != "" {
		sender := r.getSender()
		sp := r.getStepProvider()
		if sender != nil && sp != nil {
			go r.handleExternalStepDone(event.Work, sender, sp)
		}
		return
	}

	// Trigger F: external work reopen (via MCP work_reopen tool).
	// When a closed work is reopened externally, send the reopen message.
	if event.External && wasReopened && event.Work.SessionID != "" {
		sender := r.getSender()
		if sender != nil {
			go r.handleExternalReopen(event.Work, sender)
		}
		return
	}

	// Trigger C: external work start (e.g. MCP work_start).
	// Only fires for External events (fsnotify) to avoid conflicting with
	// in-process transitions like Trigger B's parent reactivation.
	// Skip if this is a step advance (handled by Trigger E above) or reopen (handled by Trigger F).
	if event.External && event.Work.Status == StatusInProgress && event.Work.SessionID != "" && !stepAdvanced && !wasReopened {
		if h := r.getStartHandler(); h != nil {
			go r.handleExternalWorkStart(event.Work, h)
		}
		return
	}

	// Trigger B: child closed → parent reactivation
	sender := r.getSender()
	if sender == nil {
		return
	}
	if event.Work.Status != StatusClosed || event.Work.ParentID == "" {
		return
	}

	go r.handleParentReactivation(event.Work, sender)
}

func (r *AutoResumer) handleExternalWorkStart(w Work, h WorkStartHandler) {
	if err := h.HandleWorkStart(r.ctx, w); err != nil {
		if r.ctx.Err() != nil {
			return
		}
		slog.Error("external work start failed, rolling back", "workId", w.ID, "error", err)
		if rbErr := r.workStore.RollbackStart(r.ctx, w.ID, false); rbErr != nil {
			slog.Error("failed to rollback external work start", "workId", w.ID, "error", rbErr)
		}
		return
	}
	slog.Info("external work start completed", "workId", w.ID, "sessionId", w.SessionID)
}

// handleExternalStepDone handles step advancement triggered by MCP step_done tool.
// It sends the next step prompt to the agent session.
func (r *AutoResumer) handleExternalStepDone(w Work, sender MessageSender, sp StepProvider) {
	steps, err := sp.GetSteps(w.AgentRoleID)
	if err != nil {
		if r.ctx.Err() == nil {
			slog.Warn("failed to get steps for external step_done", "agentRoleId", w.AgentRoleID, "error", err)
		}
		return
	}

	// CurrentStep is already advanced by MCP; validate bounds
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
		slog.Warn("failed to send step advance message for external step_done", "workId", w.ID, "step", w.CurrentStep, "error", err)
	} else {
		slog.Info("external step_done message sent", "workId", w.ID, "sessionId", w.SessionID, "step", w.CurrentStep+1, "totalSteps", len(steps))
	}
}

// handleExternalReopen handles work reopen triggered by MCP work_reopen tool.
// It sends the reopen message to the agent session.
func (r *AutoResumer) handleExternalReopen(w Work, sender MessageSender) {
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

	// Handle waiting parent: wake up when child closes
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

		msg := BuildChildCompletionMessage(parent, child.Title, child.ID)
		if err := sender.SendMessage(r.ctx, parent.SessionID, msg); err != nil {
			if r.ctx.Err() != nil {
				return
			}
			slog.Warn("failed to send child completion message to waiting parent", "parentId", parent.ID, "error", err)
		} else {
			slog.Info("waiting parent resumed on child close", "parentId", parent.ID, "childId", child.ID)
		}
		return
	}

	// Handle done parent: reactivate when child closes (existing behavior)
	if parent.Status != StatusDone {
		return
	}

	// Transition parent back to in_progress so the agent can work and
	// call work_done again (done→done would be an invalid transition).
	if err := r.workStore.ReactivateParent(r.ctx, parent.ID); err != nil {
		if r.ctx.Err() != nil {
			return
		}
		slog.Warn("failed to reactivate parent work", "parentId", parent.ID, "error", err)
		return
	}

	// Reset retry count (new activity context)
	r.retryMu.Lock()
	delete(r.retries, parent.SessionID)
	r.retryMu.Unlock()

	msg := BuildParentReactivationMessage(parent, child.Title, child.ID)
	if err := sender.SendMessage(r.ctx, parent.SessionID, msg); err != nil {
		if r.ctx.Err() != nil {
			return
		}
		slog.Warn("failed to send parent reactivation message", "parentId", parent.ID, "error", err)
	} else {
		slog.Info("parent reactivation sent", "parentId", parent.ID, "childId", child.ID)
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
