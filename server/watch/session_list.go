package watch

import (
	"context"
	"log/slog"
	"sync/atomic"

	"github.com/pockode/server/process"
	"github.com/pockode/server/rpc"
	"github.com/pockode/server/session"
)

type ProcessStateGetter interface {
	GetProcessState(sessionID string) string
}

// ViewingChecker checks whether any client has an active subscription to a session.
type ViewingChecker interface {
	IsViewing(sessionID string) bool
}

// WorkStatusSyncer moves a work item's status in response to session events.
type WorkStatusSyncer interface {
	HandlePromptRaised(ctx context.Context, sessionID string)
	HandleUserAction(ctx context.Context, sessionID string)
}

// SessionListWatcher notifies subscribers when the session list changes.
// Uses a channel-based async notification pattern to avoid blocking the session
// store's mutex during network I/O.
type SessionListWatcher struct {
	*BaseWatcher
	store              session.Store
	processStateGetter ProcessStateGetter
	viewingChecker     ViewingChecker
	workStatusSyncer   WorkStatusSyncer
	eventCh            chan session.SessionChangeEvent
	dirty              atomic.Bool // set when an event is dropped; triggers full sync
}

func NewSessionListWatcher(store session.Store) *SessionListWatcher {
	w := &SessionListWatcher{
		BaseWatcher: NewBaseWatcher(),
		store:       store,
		eventCh:     make(chan session.SessionChangeEvent, 64), // Buffer to avoid blocking
	}
	store.AddOnChangeListener(w)
	return w
}

func (w *SessionListWatcher) SetProcessStateGetter(psg ProcessStateGetter) {
	w.processStateGetter = psg
}

func (w *SessionListWatcher) SetViewingChecker(vc ViewingChecker) {
	w.viewingChecker = vc
}

func (w *SessionListWatcher) SetWorkStatusSyncer(s WorkStatusSyncer) {
	w.workStatusSyncer = s
}

func (w *SessionListWatcher) Start() error {
	w.Go(w.eventLoop)
	slog.Info("SessionListWatcher started")
	return nil
}

func (w *SessionListWatcher) Stop() {
	w.CancelAndWait()
	slog.Info("SessionListWatcher stopped")
}

// eventLoop processes session change events asynchronously.
func (w *SessionListWatcher) eventLoop() {
	for {
		select {
		case <-w.Context().Done():
			return
		case event := <-w.eventCh:
			if w.dirty.Swap(false) {
				w.notifySync()
			} else {
				w.notifyChange(event)
			}
		}
	}
}

func (w *SessionListWatcher) buildItem(meta session.SessionMeta) rpc.SessionListItem {
	return rpc.NewSessionListItem(meta, w.processStateGetter.GetProcessState(meta.ID))
}

// notifyChange sends notifications to all subscribers.
func (w *SessionListWatcher) notifyChange(event session.SessionChangeEvent) {
	if !w.HasSubscriptions() {
		return
	}

	w.NotifyAll("session.list.changed", func(sub *Subscription) any {
		params := sessionListChangedParams{
			ID:        sub.ID,
			Operation: string(event.Op),
		}
		if event.Op == session.OperationDelete {
			params.SessionID = event.Session.ID
		} else {
			item := w.buildItem(event.Session)
			params.Session = &item
		}
		return params
	})

	slog.Debug("notified session list change", "operation", event.Op)
}

// notifySync sends the full session list to all subscribers after dropped events.
func (w *SessionListWatcher) notifySync() {
	if !w.HasSubscriptions() {
		return
	}

	sessions, err := w.store.List()
	if err != nil {
		slog.Error("failed to list sessions for sync", "error", err)
		return
	}

	items := make([]rpc.SessionListItem, len(sessions))
	for i, sess := range sessions {
		items[i] = w.buildItem(sess)
	}

	w.NotifyAll("session.list.changed", func(sub *Subscription) any {
		return sessionListSyncParams{
			ID:        sub.ID,
			Operation: "sync",
			Sessions:  items,
		}
	})

	slog.Info("sent full sync to subscribers after event drop")
}

// Subscribe registers a subscriber under the client-chosen id and returns the
// current session list enriched with runtime state.
//
// Registered before the list is read, so a change landing between the two is
// notified rather than lost; see BaseWatcher.AddSubscription.
func (w *SessionListWatcher) Subscribe(id string, notifier Notifier) ([]rpc.SessionListItem, error) {
	sub := &Subscription{
		ID:       id,
		Notifier: notifier,
	}
	if err := w.AddSubscription(sub); err != nil {
		return nil, err
	}

	sessions, err := w.store.List()
	if err != nil {
		w.RemoveSubscription(id)
		return nil, err
	}

	items := make([]rpc.SessionListItem, len(sessions))
	for i, sess := range sessions {
		items[i] = w.buildItem(sess)
	}

	return items, nil
}

type sessionListChangedParams struct {
	ID        string               `json:"id"`
	Operation string               `json:"operation"`
	Session   *rpc.SessionListItem `json:"session,omitempty"`
	SessionID string               `json:"sessionId,omitempty"`
}

type sessionListSyncParams struct {
	ID        string                `json:"id"`
	Operation string                `json:"operation"`
	Sessions  []rpc.SessionListItem `json:"sessions"`
}

// HandleProcessStateChange updates NeedsInput/Unread in the store and notifies subscribers.
// Store updates trigger OnSessionChange → notifyChange automatically.
// The manual notification at the end covers the volatile ProcessState change.
func (w *SessionListWatcher) HandleProcessStateChange(e process.StateChangeEvent) {
	ctx := context.Background()

	switch e.State {
	case process.ProcessStateIdle:
		if err := w.store.SetNeedsInput(ctx, e.SessionID, e.NeedsInput); err != nil {
			slog.Warn("failed to set needs input", "sessionId", e.SessionID, "error", err)
		}
		if w.viewingChecker == nil || !w.viewingChecker.IsViewing(e.SessionID) {
			if err := w.store.SetUnread(ctx, e.SessionID, true); err != nil {
				slog.Warn("failed to set unread", "sessionId", e.SessionID, "error", err)
			}
		}
		if e.NeedsInput && w.workStatusSyncer != nil {
			w.workStatusSyncer.HandlePromptRaised(w.Context(), e.SessionID)
		}
	case process.ProcessStateRunning:
		// needs_input is NOT cleared here — it is cleared by user events
		// (message, permission response, question response) via HandleUserAction.
	case process.ProcessStateEnded:
		// The session's own flag is cleared: the process that raised the prompt
		// is gone, so the session is no longer holding one open. The work item
		// is deliberately left alone — a dead process is no evidence that the
		// user answered, and waking the work here would hand the AutoResumer's
		// process-ended stop an in_progress work to stop, which is how every
		// paused work used to end up stopped. Work leaves needs_input/waiting
		// on a user action instead (HandleUserAction).
		if err := w.store.SetNeedsInput(ctx, e.SessionID, false); err != nil {
			slog.Warn("failed to clear needs input on process end", "sessionId", e.SessionID, "error", err)
		}
	}

	// Notify ProcessState change (volatile, not covered by Store's OnSessionChange)
	if !w.HasSubscriptions() {
		return
	}

	meta, found, err := w.store.Get(e.SessionID)
	if err != nil || !found {
		return
	}

	// Use e.State directly — the event already carries the authoritative state,
	// so re-querying via GetProcessState would be redundant.
	item := rpc.NewSessionListItem(meta, string(e.State))
	w.NotifyAll("session.list.changed", func(sub *Subscription) any {
		return sessionListChangedParams{
			ID:        sub.ID,
			Operation: "update",
			Session:   &item,
		}
	})
}

// HandleUserAction records that the user just acted on this session.
//
// Two things follow from that one event, at two different layers: the prompt the
// session was holding up has been dealt with, so its needs_input flag drops; and
// a work paused on that prompt — or on child work — has the attention it was
// paused for, so it resumes (work.StatusSyncer.HandleUserAction).
//
// What counts is "the user handed this session something to go on": a message, a
// permission answer, a question answer. Interrupt does not, even though a user
// pressed it — it takes the turn away rather than handing something over, and
// the interrupted state change it produces stops in_progress work, so resuming a
// paused work here would only walk it into stopped (docs/code/work-system.md,
// Trigger A). The session's flag still drops, because that state change is an
// idle one and HandleProcessStateChange clears the flag there.
//
// Two more paths are deliberately not this event. Deleting the session removes
// the place an answer would go, so it stops the work instead of resuming it, and
// lives where it happens (ws.rpcMethodHandler.stopWorkForDeletedSession). The
// system-driven senders (restart, kickoff, step advance, reopen, child closure)
// do put a message into a session, but the flag says a human has to look at this
// session and they fire whether or not one is there — a work restarted through
// the MCP API by another agent is the plain case. For them the flag comes down
// where it always could: when the process reports the prompt is gone.
func (w *SessionListWatcher) HandleUserAction(sessionID string) {
	ctx := context.Background()
	if err := w.store.SetNeedsInput(ctx, sessionID, false); err != nil {
		slog.Warn("failed to clear needs input", "sessionId", sessionID, "error", err)
	}
	if w.workStatusSyncer != nil {
		w.workStatusSyncer.HandleUserAction(ctx, sessionID)
	}
}

func (w *SessionListWatcher) MarkRead(sessionID string) {
	meta, found, err := w.store.Get(sessionID)
	if err != nil || !found || !meta.Unread {
		return
	}
	if err := w.store.SetUnread(context.Background(), sessionID, false); err != nil {
		slog.Warn("failed to mark read", "sessionId", sessionID, "error", err)
	}
}

// OnSessionChange implements session.OnChangeListener.
// This method is called from the session store's mutex, so it must not block.
// Events are queued to the channel for async processing.
func (w *SessionListWatcher) OnSessionChange(event session.SessionChangeEvent) {
	// Skip if watcher is stopped
	if w.Context().Err() != nil {
		return
	}

	select {
	case w.eventCh <- event:
	default:
		w.dirty.Store(true)
		slog.Warn("session list change event dropped, will sync on next event", "operation", event.Op)
	}
}
