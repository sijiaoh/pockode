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

// AutoResumer handles two automatic triggers for Work sessions:
//
// Trigger A: When an agent process stops while Work is in_progress,
// send a continuation message to resume work.
//
// Trigger B: When a child Work closes, reactivate the parent Work's
// agent to review and continue.
type AutoResumer struct {
	workStore   Store
	sender      atomic.Pointer[MessageSender]
	ctx         context.Context
	cancel      context.CancelFunc
	retryMu     sync.Mutex
	retries     map[string]int // sessionID → retry count
	maxRetries  int
	settleDelay time.Duration // delay before checking work status after process stop
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
		maxRetries:  maxRetries,
		settleDelay: defaultSettleDelay,
	}
}

// Stop cancels all pending goroutines (settle delays and in-flight sends).
func (r *AutoResumer) Stop() {
	r.cancel()
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

// HandleProcessStateChange implements trigger A: auto-continuation when agent stops.
// Parameters are extracted from process.StateChangeEvent to avoid importing the process package.
func (r *AutoResumer) HandleProcessStateChange(sessionID, state string, needsInput, isInitial bool) {
	sender := r.getSender()
	if sender == nil {
		return
	}

	// Only trigger on idle without NeedsInput (normal stop or error).
	// Ignore the initial idle emitted on process creation — the agent hasn't started yet.
	if state != "idle" || needsInput || isInitial {
		return
	}

	go r.handleAutoContinuation(sessionID, sender)
}

func (r *AutoResumer) handleAutoContinuation(sessionID string, sender MessageSender) {
	// Wait for MCP work_done writes to propagate via fsnotify.
	// Use select so we abort immediately on shutdown.
	select {
	case <-time.After(r.settleDelay):
	case <-r.ctx.Done():
		return
	}

	w := r.findInProgressWorkBySessionID(sessionID)
	if w == nil {
		return
	}

	r.retryMu.Lock()
	count := r.retries[sessionID]
	if count >= r.maxRetries {
		r.retryMu.Unlock()
		slog.Info("auto-resume retry limit reached", "sessionId", sessionID, "workId", w.ID)
		return
	}
	r.retries[sessionID] = count + 1
	r.retryMu.Unlock()

	msg := BuildAutoContinuationMessage(w.Type)
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

	// Reset retries when work completes
	if event.Work.Status == StatusDone || event.Work.Status == StatusClosed {
		if event.Work.SessionID != "" {
			r.retryMu.Lock()
			delete(r.retries, event.Work.SessionID)
			r.retryMu.Unlock()
		}
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

func (r *AutoResumer) handleParentReactivation(child Work, sender MessageSender) {
	parent, found, err := r.workStore.Get(child.ParentID)
	if err != nil {
		slog.Warn("failed to get parent work for reactivation", "parentId", child.ParentID, "error", err)
		return
	}
	if !found {
		return
	}

	// Only reactivate if parent is done (waiting for children) and has a session
	if parent.Status != StatusDone || parent.SessionID == "" {
		return
	}

	// Reactivate: done → in_progress
	status := StatusInProgress
	if err := r.workStore.Update(r.ctx, parent.ID, UpdateFields{Status: &status}); err != nil {
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

	msg := BuildParentReactivationMessage(child.Title)
	if err := sender.SendMessage(r.ctx, parent.SessionID, msg); err != nil {
		if r.ctx.Err() != nil {
			return
		}
		slog.Warn("failed to send parent reactivation message", "parentId", parent.ID, "error", err)
	} else {
		slog.Info("parent reactivation sent", "parentId", parent.ID, "childId", child.ID)
	}
}

func (r *AutoResumer) findInProgressWorkBySessionID(sessionID string) *Work {
	works, err := r.workStore.List()
	if err != nil {
		slog.Warn("failed to list works for auto-resume check", "sessionId", sessionID, "error", err)
		return nil
	}
	for i := range works {
		if works[i].SessionID == sessionID && works[i].Status == StatusInProgress {
			return &works[i]
		}
	}
	return nil
}
