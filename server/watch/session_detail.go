package watch

import (
	"fmt"
	"log/slog"
	"sync/atomic"

	"github.com/pockode/server/rpc"
	"github.com/pockode/server/session"
	"github.com/pockode/server/work"
)

// sessionDetailEvent is a union of the two changes that alter a session's
// detail: the session itself, and a work item whose session lives in this
// worktree. Exactly one field is set per event.
type sessionDetailEvent struct {
	session *session.SessionChangeEvent
	work    *work.ChangeEvent
}

// SessionDetailWatcher notifies subscribers when one session's metadata changes.
// Subscriptions are keyed by session_id: a subscriber follows the single session
// it has open and receives the whole of SessionMeta, including the settings the
// list does not carry — agent type, model, effort, mode, activated — and the
// work item it runs, which is stored on neither side (rpc.SessionDetail).
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
	works   *sessionWorkIndex
	eventCh chan sessionDetailEvent
	dirty   atomic.Bool // set when an event is dropped; triggers full sync
}

func NewSessionDetailWatcher(store session.Store, works SessionWorkSource) *SessionDetailWatcher {
	w := &SessionDetailWatcher{
		BaseWatcher: NewBaseWatcher(),
		store:       store,
		works:       newSessionWorkIndex(works),
		// Same source and same size as SessionListWatcher's channel: both are fed
		// by every session change in the worktree, so a burst one can absorb
		// without falling back to a full sync the other must absorb too.
		eventCh: make(chan sessionDetailEvent, 64),
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
			switch {
			case w.dirty.Swap(false):
				w.notifySyncAll()
			case event.session != nil:
				w.notifyChange(*event.session)
			case event.work != nil:
				w.notifyWorkChange(*event.work)
			}
		}
	}
}

// notifyChange sends the session carried by the event to its subscribers.
// The event's own copy is used rather than a store read: create and update
// events carry the full metadata as it was written, which is exactly the
// snapshot this notification is about. The work item it runs is not on that
// copy and is resolved alongside it.
func (w *SessionDetailWatcher) notifyChange(event session.SessionChangeEvent) {
	sessionID := event.Session.ID

	// This watcher sees every session change in the worktree, while detail
	// subscriptions normally exist only for the session a client has open.
	if !w.HasSubscriptionForKey(sessionID) {
		return
	}

	if event.Op == session.OperationDelete {
		w.works.forget(sessionID)
		w.pushDetail(sessionID, nil)
		return
	}

	workID, ok := w.works.resolve(sessionID)
	if !ok {
		// Nothing truthful to say: the session is readable but the relation is
		// not, and a detail that omits the work item claims the session belongs
		// to none. The next change to either side resolves it again.
		return
	}
	detail := rpc.NewSessionDetail(event.Session, workID)
	w.works.remember(sessionID, workID)
	w.pushDetail(sessionID, &detail)
}

// notifyWorkChange re-sends the detail of the session a changed work item runs.
// Nothing about the session moves when the relation does, so without this the
// open session would keep saying what was true when it was last written.
//
// The relation is resolved from the store rather than read off the event: a
// delete carries the work as it was, and the detail has to say what it is now,
// which is gone.
//
// Most of these changes move nothing a subscriber holds — a work is written
// several times a turn, for a wait declared, a nudge counted, a step advanced —
// so an event that would repeat the work id already sent for this session stops
// here, before the store read.
func (w *SessionDetailWatcher) notifyWorkChange(event work.ChangeEvent) {
	// A work with no session names no session to re-resolve; what that covers,
	// and the one case it leaves behind, is on SessionListWatcher.notifyWorkChange.
	sessionID := event.Work.SessionID
	if sessionID == "" || !w.HasSubscriptionForKey(sessionID) {
		return
	}

	workID, ok := w.works.resolve(sessionID)
	if !ok {
		return
	}
	if w.works.alreadySent(sessionID, workID) {
		return
	}

	meta, found, err := w.store.Get(sessionID)
	if err != nil {
		slog.Error("failed to read the session of a changed work item", "sessionId", sessionID, "error", err)
		return
	}
	if !found {
		// A work is given its session id before that session exists (work.Claim,
		// then WorkStarter). The session's own create event carries the relation.
		return
	}

	detail := rpc.NewSessionDetail(meta, workID)
	w.works.remember(sessionID, workID)
	w.pushDetail(sessionID, &detail)
	slog.Debug("notified session detail of a work change", "workId", event.Work.ID, "sessionId", sessionID)
}

func (w *SessionDetailWatcher) pushDetail(sessionID string, detail *rpc.SessionDetail) {
	w.NotifyForKey(sessionID, "session.detail.changed", func(sub *Subscription) any {
		return newSessionDetailParams(sub.ID, detail)
	})
}

// notifySyncAll sends the current state of every subscribed session.
// Called after dropped events, where we no longer know which sessions changed —
// including whether one of them was the delete we missed, which is why a session
// the store no longer has is reported as deleted rather than skipped.
//
// A session this sync could not read is skipped and the dirty flag goes back up.
// The skip itself is the same rule the incremental path follows — there is
// nothing truthful to say about a session whose state could not be read — but
// here it cannot be left at that: this sync is the only thing that can replace
// the events that were dropped, so a session left out of it would keep whatever
// it was showing before the drop until some later event happens to touch it,
// which for a session whose agent has finished may be never.
func (w *SessionDetailWatcher) notifySyncAll() {
	subs := w.GetAllSubscriptions()
	if len(subs) == 0 {
		return
	}

	// One store read per watched session, not one per subscriber.
	details := make(map[string]*rpc.SessionDetail, len(subs))
	skipped := false
	for _, sub := range subs {
		if _, done := details[sub.Key]; done {
			continue
		}
		meta, found, err := w.store.Get(sub.Key)
		if err != nil {
			slog.Error("failed to get session for detail sync", "error", err, "sessionId", sub.Key)
			skipped = true
			continue
		}
		if !found {
			w.works.forget(sub.Key)
			details[sub.Key] = nil
			continue
		}
		workID, ok := w.works.resolve(sub.Key)
		if !ok {
			skipped = true
			continue
		}
		detail := rpc.NewSessionDetail(meta, workID)
		w.works.remember(sub.Key, workID)
		details[sub.Key] = &detail
	}

	// Raised before anything goes out, so that a subscriber which sees this sync
	// can rely on the retry having been scheduled already.
	if skipped {
		w.dirty.Store(true)
	}

	for key, detail := range details {
		w.pushDetail(key, detail)
	}

	slog.Info("sent full session detail sync to subscribers after event drop")
}

// Subscribe registers a subscriber for a single session's metadata under the
// client-chosen id and returns the current snapshot.
//
// The subscription is registered before the store read so that a change landing
// between the two is delivered rather than lost. That notification can reach the
// client before this call's reply does — the two are written by different
// goroutines — so the client must be able to take a change before it has taken
// the snapshot. See docs/code/subscription-system.md.
func (w *SessionDetailWatcher) Subscribe(id, sessionID string, notifier Notifier) (rpc.SessionDetail, error) {
	sub := &Subscription{
		ID:       id,
		Key:      sessionID,
		Notifier: notifier,
	}
	if err := w.AddSubscription(sub); err != nil {
		return rpc.SessionDetail{}, err
	}

	// The work id last sent for this session is dropped rather than replaced
	// with the one this snapshot carries. That record exists to skip a push that
	// would tell every subscriber of this session what they already hold, and it
	// is only sound while it names what all of them hold — which a new
	// subscriber's snapshot cannot establish, because a relation that changed
	// while nobody watched this session was never pushed to anyone. Forgetting
	// costs one redundant push after a subscribe; recording would cost a lost
	// one, and there is no later event to make it up.
	w.works.forget(sessionID)

	meta, found, err := w.store.Get(sessionID)
	if err != nil {
		w.RemoveSubscription(id)
		return rpc.SessionDetail{}, err
	}
	if !found {
		w.RemoveSubscription(id)
		return rpc.SessionDetail{}, session.ErrSessionNotFound
	}

	// Refused rather than answered without it, as the session list refuses a
	// snapshot it cannot resolve: a detail missing its work id is a session
	// claiming to belong to no work, and a subscriber has no reason to ask again.
	workID, err := w.works.resolveErr(sessionID)
	if err != nil {
		w.RemoveSubscription(id)
		return rpc.SessionDetail{}, fmt.Errorf("resolve the work of session %s: %w", sessionID, err)
	}
	return rpc.NewSessionDetail(meta, workID), nil
}

// sessionDetailChangedParams reports a session's new state, or its removal.
// Session is nil exactly when Deleted is true.
type sessionDetailChangedParams struct {
	ID      string             `json:"id"`
	Session *rpc.SessionDetail `json:"session,omitempty"`
	Deleted bool               `json:"deleted,omitempty"`
}

// newSessionDetailParams keeps the "no session means deleted" invariant in one
// place, so the incremental and the full-sync path cannot disagree about it.
func newSessionDetailParams(subID string, detail *rpc.SessionDetail) sessionDetailChangedParams {
	return sessionDetailChangedParams{ID: subID, Session: detail, Deleted: detail == nil}
}

// OnSessionChange implements session.OnChangeListener.
// Called from the session store's mutex, so it must not block.
func (w *SessionDetailWatcher) OnSessionChange(event session.SessionChangeEvent) {
	w.sendEvent(sessionDetailEvent{session: &event})
}

// HandleWorkChange is told that a work item changed in this worktree, because
// the open session names the work item it runs.
//
// Called by worktree.Manager rather than registered on the work store directly,
// for the reason given on SessionListWatcher.HandleWorkChange: that store keeps
// its listeners for the life of the process, and a worktree does not. Same mutex
// contract as OnSessionChange: queued, never handled here.
func (w *SessionDetailWatcher) HandleWorkChange(event work.ChangeEvent) {
	w.sendEvent(sessionDetailEvent{work: &event})
}

func (w *SessionDetailWatcher) sendEvent(event sessionDetailEvent) {
	if w.Context().Err() != nil {
		return
	}

	select {
	case w.eventCh <- event:
	default:
		w.dirty.Store(true)
		slog.Warn("session detail change event dropped, will sync on next event")
	}
}
