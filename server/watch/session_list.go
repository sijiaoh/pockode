package watch

import (
	"log/slog"

	"github.com/pockode/server/session"
	"github.com/sourcegraph/jsonrpc2"
)

// SessionListWatcher notifies subscribers when the session list changes.
// Uses a channel-based async notification pattern to avoid blocking the session
// store's mutex during network I/O.
type SessionListWatcher struct {
	*BaseWatcher
	store   session.Store
	eventCh chan session.SessionChangeEvent
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
			params.Session = &event.Session
		}
		return params
	})

	slog.Debug("notified session list change", "operation", event.Op)
}

// Subscribe registers a subscriber and returns the subscription ID along with
// the current session list.
func (w *SessionListWatcher) Subscribe(conn *jsonrpc2.Conn, connID string) (string, []session.SessionMeta, error) {
	id := w.GenerateID()
	sub := &Subscription{
		ID:     id,
		ConnID: connID,
		Conn:   conn,
	}
	// Add subscription BEFORE getting the list to avoid missing events
	// that occur between List() and AddSubscription().
	w.AddSubscription(sub)

	sessions, err := w.store.List()
	if err != nil {
		w.RemoveSubscription(id)
		return "", nil, err
	}

	return id, sessions, nil
}

type sessionListChangedParams struct {
	ID        string               `json:"id"`
	Operation string               `json:"operation"`
	Session   *session.SessionMeta `json:"session,omitempty"`
	SessionID string               `json:"sessionId,omitempty"`
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
