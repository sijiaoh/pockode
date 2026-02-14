package watch

import (
	"log/slog"

	"github.com/pockode/server/rpc"
	"github.com/pockode/server/session"
)

type ProcessStateGetter interface {
	GetProcessState(sessionID string) string
}

// SessionListWatcher notifies subscribers when the session list changes.
// Uses a channel-based async notification pattern to avoid blocking the session
// store's mutex during network I/O.
type SessionListWatcher struct {
	*BaseWatcher
	store              session.Store
	processStateGetter ProcessStateGetter
	eventCh            chan session.SessionChangeEvent
}

func NewSessionListWatcher(store session.Store) *SessionListWatcher {
	w := &SessionListWatcher{
		BaseWatcher: NewBaseWatcher("sl"),
		store:       store,
		eventCh:     make(chan session.SessionChangeEvent, 64), // Buffer to avoid blocking
	}
	store.SetOnChangeListener(w)
	return w
}

func (w *SessionListWatcher) SetProcessStateGetter(psg ProcessStateGetter) {
	w.processStateGetter = psg
}

func (w *SessionListWatcher) Start() error {
	go w.eventLoop()
	slog.Info("SessionListWatcher started")
	return nil
}

func (w *SessionListWatcher) Stop() {
	w.Cancel()
	slog.Info("SessionListWatcher stopped")
}

// eventLoop processes session change events asynchronously.
func (w *SessionListWatcher) eventLoop() {
	for {
		select {
		case <-w.Context().Done():
			return
		case event := <-w.eventCh:
			w.notifyChange(event)
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
			params.Session = &rpc.SessionListItem{
				SessionMeta: event.Session,
				State:       w.processStateGetter.GetProcessState(event.Session.ID),
			}
		}
		return params
	})

	slog.Debug("notified session list change", "operation", event.Op)
}

// Subscribe registers a subscriber and returns the subscription ID along with
// the current session list enriched with runtime state.
func (w *SessionListWatcher) Subscribe(notifier Notifier) (string, []rpc.SessionListItem, error) {
	id := w.GenerateID()
	sub := &Subscription{
		ID:       id,
		Notifier: notifier,
	}
	// Add subscription BEFORE getting the list to avoid missing events
	// that occur between List() and AddSubscription().
	w.AddSubscription(sub)

	sessions, err := w.store.List()
	if err != nil {
		w.RemoveSubscription(id)
		return "", nil, err
	}

	items := make([]rpc.SessionListItem, len(sessions))
	for i, sess := range sessions {
		items[i] = rpc.SessionListItem{
			SessionMeta: sess,
			State:       w.processStateGetter.GetProcessState(sess.ID),
		}
	}

	return id, items, nil
}

type sessionListChangedParams struct {
	ID        string               `json:"id"`
	Operation string               `json:"operation"`
	Session   *rpc.SessionListItem `json:"session,omitempty"`
	SessionID string               `json:"sessionId,omitempty"`
}

func (w *SessionListWatcher) NotifyProcessStateChange(sessionID string, state string) {
	if !w.HasSubscriptions() {
		return
	}

	meta, found, err := w.store.Get(sessionID)
	if err != nil || !found {
		slog.Warn("failed to get session for state change", "sessionId", sessionID, "error", err)
		return
	}

	w.NotifyAll("session.list.changed", func(sub *Subscription) any {
		return sessionListChangedParams{
			ID:        sub.ID,
			Operation: "update",
			Session: &rpc.SessionListItem{
				SessionMeta: meta,
				State:       state,
			},
		}
	})

	slog.Debug("notified process state change", "sessionId", sessionID, "state", state)
}

// OnSessionChange implements session.OnChangeListener.
// This method is called from the session store's mutex, so it must not block.
// Events are queued to the channel for async processing.
func (w *SessionListWatcher) OnSessionChange(event session.SessionChangeEvent) {
	// Skip if watcher is stopped
	if w.Context().Err() != nil {
		return
	}

	// Non-blocking send: if buffer is full, drop the event
	// This should be rare with a reasonable buffer size
	// TODO: If buffer overflows, disconnect all subscribers to force re-sync.
	// Dropping events silently can cause clients to have stale data.
	select {
	case w.eventCh <- event:
	default:
		slog.Warn("session list change event dropped (buffer full)", "operation", event.Op)
	}
}
