package watch

import (
	"log/slog"
	"sync/atomic"

	"github.com/pockode/server/session"
)

// SessionDetailWatcher notifies subscribers when one session's metadata changes.
// Subscriptions are keyed by session_id: a subscriber follows the single session
// it has open and receives the whole of SessionMeta, including the settings the
// list does not carry — agent type, model, effort, mode, activated.
//
// It deliberately carries no process state. Whether an agent is running is
// volatile state owned by process.Manager, and SessionListWatcher already
// pushes it (rpc.SessionListItem.State). Repeating it here would give one fact
// two independent sources, delivered in an order neither side controls, and a
// client no way to tell which of the two is current. So: persistent
// conversation metadata comes from here, run state comes from the list.
type SessionDetailWatcher struct {
	*BaseWatcher
	store   session.Store
	eventCh chan session.SessionChangeEvent
	dirty   atomic.Bool // set when an event is dropped; triggers full sync
}

func NewSessionDetailWatcher(store session.Store) *SessionDetailWatcher {
	w := &SessionDetailWatcher{
		BaseWatcher: NewBaseWatcher("sd"),
		store:       store,
		// Same source and same size as SessionListWatcher's channel: both are fed
		// by every session change in the worktree, so a burst one can absorb
		// without falling back to a full sync the other must absorb too.
		eventCh: make(chan session.SessionChangeEvent, 64),
	}
	store.AddOnChangeListener(w)
	return w
}

func (w *SessionDetailWatcher) Start() error {
	w.Go(w.eventLoop)
	slog.Info("SessionDetailWatcher started")
	return nil
}

func (w *SessionDetailWatcher) Stop() {
	w.CancelAndWait()
	slog.Info("SessionDetailWatcher stopped")
}

func (w *SessionDetailWatcher) eventLoop() {
	for {
		select {
		case <-w.Context().Done():
			return
		case event := <-w.eventCh:
			if w.dirty.Swap(false) {
				w.notifySyncAll()
			} else {
				w.notifyChange(event)
			}
		}
	}
}

// notifyChange sends the session carried by the event to its subscribers.
// The event's own copy is used rather than a store read: create and update
// events carry the full metadata as it was written, which is exactly the
// snapshot this notification is about.
func (w *SessionDetailWatcher) notifyChange(event session.SessionChangeEvent) {
	sessionID := event.Session.ID

	// This watcher sees every session change in the worktree, while detail
	// subscriptions normally exist only for the session a client has open.
	if !w.HasSubscriptionForKey(sessionID) {
		return
	}

	var meta *session.SessionMeta
	if event.Op != session.OperationDelete {
		meta = &event.Session
	}

	w.NotifyForKey(sessionID, "session.detail.changed", func(sub *Subscription) any {
		return newSessionDetailParams(sub.ID, meta)
	})
}

// notifySyncAll sends the current state of every subscribed session.
// Called after dropped events, where we no longer know which sessions changed —
// including whether one of them was the delete we missed, which is why a session
// the store no longer has is reported as deleted rather than skipped.
func (w *SessionDetailWatcher) notifySyncAll() {
	subs := w.GetAllSubscriptions()
	if len(subs) == 0 {
		return
	}

	// One store read per watched session, not one per subscriber.
	metas := make(map[string]*session.SessionMeta, len(subs))
	for _, sub := range subs {
		if _, done := metas[sub.Key]; done {
			continue
		}
		meta, found, err := w.store.Get(sub.Key)
		if err != nil {
			// Left out of the map, and so unreported: there is nothing truthful to
			// say about a session whose state could not be read.
			slog.Error("failed to get session for detail sync", "error", err, "sessionId", sub.Key)
			continue
		}
		if !found {
			metas[sub.Key] = nil
			continue
		}
		metas[sub.Key] = &meta
	}

	for key, meta := range metas {
		w.NotifyForKey(key, "session.detail.changed", func(sub *Subscription) any {
			return newSessionDetailParams(sub.ID, meta)
		})
	}

	slog.Info("sent full session detail sync to subscribers after event drop")
}

// Subscribe registers a subscriber for a single session's metadata and returns
// the current snapshot.
func (w *SessionDetailWatcher) Subscribe(sessionID string, notifier Notifier) (string, session.SessionMeta, error) {
	id := w.GenerateID()
	sub := &Subscription{
		ID:       id,
		Key:      sessionID,
		Notifier: notifier,
	}
	// Registered before the store read so a change landing between the two is
	// delivered rather than lost.
	w.AddSubscription(sub)

	meta, found, err := w.store.Get(sessionID)
	if err != nil {
		w.RemoveSubscription(id)
		return "", session.SessionMeta{}, err
	}
	if !found {
		w.RemoveSubscription(id)
		return "", session.SessionMeta{}, session.ErrSessionNotFound
	}

	return id, meta, nil
}

// sessionDetailChangedParams reports a session's new state, or its removal.
// Session is nil exactly when Deleted is true.
type sessionDetailChangedParams struct {
	ID      string               `json:"id"`
	Session *session.SessionMeta `json:"session,omitempty"`
	Deleted bool                 `json:"deleted,omitempty"`
}

// newSessionDetailParams keeps the "no session means deleted" invariant in one
// place, so the incremental and the full-sync path cannot disagree about it.
func newSessionDetailParams(subID string, meta *session.SessionMeta) sessionDetailChangedParams {
	return sessionDetailChangedParams{ID: subID, Session: meta, Deleted: meta == nil}
}

// OnSessionChange implements session.OnChangeListener.
// Called from the session store's mutex, so it must not block.
func (w *SessionDetailWatcher) OnSessionChange(event session.SessionChangeEvent) {
	if w.Context().Err() != nil {
		return
	}

	select {
	case w.eventCh <- event:
	default:
		w.dirty.Store(true)
		slog.Warn("session detail change event dropped, will sync on next event", "operation", event.Op)
	}
}
