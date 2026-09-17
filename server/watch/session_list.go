package watch

import (
	"context"
	"log/slog"
	"sync/atomic"

	"github.com/pockode/server/process"
	"github.com/pockode/server/rpc"
	"github.com/pockode/server/session"
)

// ViewingChecker checks whether any client has an active subscription to a session.
type ViewingChecker interface {
	IsViewing(sessionID string) bool
}

type SessionListWatcher struct {
	*BaseWatcher
	store          session.Store
	viewingChecker ViewingChecker
	eventCh        chan session.SessionChangeEvent
	dirty          atomic.Bool // set when an event is dropped; triggers full sync
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

func (w *SessionListWatcher) SetViewingChecker(vc ViewingChecker) {
	w.viewingChecker = vc
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
			item := rpc.NewSessionListItem(event.Session)
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
		items[i] = rpc.NewSessionListItem(sess)
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
		items[i] = rpc.NewSessionListItem(sess)
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

// HandleProcessStateChange marks a session unread. That and nothing else.
//
// It notifies no subscriber. The process writes the session's turn before it
// sends this event (process.Manager.emitTurn), so the store's own change
// notification is already on its way — and the turn is the whole of what a row
// draws. The manual push that used to sit at the end of this function was there
// for the volatile process state the row no longer carries, and the three places
// that used to set and clear a needs_input flag, each with its own rule for
// when, are gone along with that flag.
//
// The work item is not touched from here at all any more. Every rule that used
// to read a process state turned out to be a rule about a turn ending, which the
// work engine hears directly and settled (session.TurnSettler).
func (w *SessionListWatcher) HandleProcessStateChange(e process.StateChangeEvent) {
	if e.State != process.ProcessStateIdle {
		return
	}
	if w.viewingChecker != nil && w.viewingChecker.IsViewing(e.SessionID) {
		return
	}
	if err := w.store.SetUnread(context.Background(), e.SessionID, true); err != nil {
		slog.Warn("failed to set unread", "sessionId", e.SessionID, "error", err)
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
