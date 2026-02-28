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
type AutoResumer struct {
	workStore    Store
	sender       atomic.Pointer[MessageSender]
	startHandler atomic.Pointer[WorkStartHandler]
	ctx          context.Context
	cancel       context.CancelFunc
	retryMu      sync.Mutex
	retries      map[string]int  // sessionID → retry count
	continuing   map[string]bool // sessionID → auto-continuation pending
	maxRetries   int
	settleDelay  time.Duration // delay before checking work status after process stop
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

// StopOrphanedWork transitions all in_progress and needs_input work items to stopped.
// Call this at server startup before any sessions are created, so that work
// items left running from a previous server run are properly marked.
func (r *AutoResumer) StopOrphanedWork() {
	works, err := r.workStore.List()
	if err != nil {
		slog.Warn("failed to list works for orphan detection", "error", err)
		return
	}

	for _, w := range works {
		if w.Status != StatusInProgress && w.Status != StatusNeedsInput {
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

// handleProcessEnded transitions in_progress work to stopped when its process terminates.
// This catches cases like user interrupt or unexpected process exit.
func (r *AutoResumer) handleProcessEnded(sessionID string) {
	// Use the same settle delay as auto-continuation to allow work_done to propagate.
	select {
	case <-time.After(r.settleDelay):
	case <-r.ctx.Done():
		return
	}

	w := r.findWorkBySessionID(sessionID, StatusInProgress, StatusNeedsInput)
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

	msg := BuildAutoContinuationMessage(*w)
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
	// Clean up retries on delete
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
	if event.Work.Status == StatusDone || event.Work.Status == StatusClosed || event.Work.Status == StatusStopped {
		if event.Work.SessionID != "" {
			r.retryMu.Lock()
			delete(r.retries, event.Work.SessionID)
			r.retryMu.Unlock()
		}
	}

	// Trigger C: external work start (e.g. MCP work_start).
	// Only fires for External events (fsnotify) to avoid conflicting with
	// in-process transitions like Trigger B's parent reactivation.
	if event.External && event.Work.Status == StatusInProgress && event.Work.SessionID != "" {
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

func (r *AutoResumer) handleParentReactivation(child Work, sender MessageSender) {
	parent, found, err := r.workStore.Get(child.ParentID)
	if err != nil {
		slog.Warn("failed to get parent work for reactivation", "parentId", child.ParentID, "error", err)
		return
	}
	if !found {
		return
	}

	// Only trigger when the parent is done (waiting for children).
	if parent.Status != StatusDone || parent.SessionID == "" {
		return
	}

	// Transition parent back to in_progress so the agent can work and
	// call work_done again (done→done would be an invalid transition).
	if err := r.workStore.Reactivate(r.ctx, parent.ID); err != nil {
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
