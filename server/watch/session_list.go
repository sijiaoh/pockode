package watch

import (
	"context"
	"log/slog"
	"sync/atomic"

	"github.com/pockode/server/process"
	"github.com/pockode/server/rpc"
	"github.com/pockode/server/session"
	"github.com/pockode/server/work"
)

// ViewingChecker checks whether any client has an active subscription to a session.
type ViewingChecker interface {
	IsViewing(sessionID string) bool
}

// SessionListFilter is the narrowing a subscriber asked for, held for the life
// of its subscription so that its snapshot and its notifications cannot
// disagree about what belongs in the list.
type SessionListFilter struct {
	// ExcludeWorkSessions drops every session that belongs to a work item.
	//
	// The filter is the server's because a client cannot do it: deciding it
	// client-side means holding the whole work list, which makes the session
	// list wrong for as long as that list is incomplete.
	ExcludeWorkSessions bool
}

func (f SessionListFilter) keeps(item rpc.SessionListItem) bool {
	return item.WorkID == "" || !f.ExcludeWorkSessions
}

// filterOf reads back the filter a subscription was registered with. A
// subscription from anywhere else — a test notifying directly — filters nothing,
// which is what the list did before there was a filter at all.
func filterOf(sub *Subscription) SessionListFilter {
	f, _ := sub.Filter.(SessionListFilter)
	return f
}

// sessionListEvent is a union of the two changes that alter a row: the session
// itself, and a work item whose session lives in this worktree. Exactly one
// field is set per event.
type sessionListEvent struct {
	session *session.SessionChangeEvent
	work    *work.ChangeEvent
}

type SessionListWatcher struct {
	*BaseWatcher
	store          session.Store
	works          *sessionWorkIndex
	viewingChecker ViewingChecker
	eventCh        chan sessionListEvent
	dirty          atomic.Bool // set when an event is dropped; triggers full sync
}

func NewSessionListWatcher(store session.Store, works SessionWorkSource) *SessionListWatcher {
	w := &SessionListWatcher{
		BaseWatcher: NewBaseWatcher(),
		store:       store,
		works:       newSessionWorkIndex(works),
		eventCh:     make(chan sessionListEvent, 64), // Buffer to avoid blocking
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
			switch {
			case w.dirty.Swap(false):
				w.notifySync()
			case event.session != nil:
				w.notifyChange(*event.session)
			case event.work != nil:
				w.notifyWorkChange(*event.work)
			}
		}
	}
}

// notifyChange sends notifications to all subscribers.
func (w *SessionListWatcher) notifyChange(event session.SessionChangeEvent) {
	if !w.HasSubscriptions() {
		return
	}

	if event.Op == session.OperationDelete {
		w.works.forget(event.Session.ID)
		w.pushRemoval(event.Session.ID)
		slog.Debug("notified session list change", "operation", event.Op)
		return
	}

	workID, ok := w.works.resolve(event.Session.ID)
	if !ok {
		return
	}
	w.pushSession(event.Op, event.Session, workID)

	slog.Debug("notified session list change", "operation", event.Op)
}

// notifyWorkChange re-sends the row of the session a changed work item runs in.
// Nothing about the session moves when the relation does, so without this a row
// would keep saying what was true when the session was last touched.
//
// The relation is resolved from the store rather than read off the event: a
// delete carries the work as it was, and the row has to say what it is now,
// which is gone.
//
// A work with no session names no session to re-resolve, so nothing is pushed.
// That is the whole answer for a work that was never started, and for a start
// rolled back because the session could not be created. It is also right for a
// rollback after a failed kickoff, where the session *was* created: that session
// is deleted, and its own delete event is what takes the row away — the relation
// changing is not the news there, the session going away is.
//
// The residue is a session whose cleanup delete also failed
// (worktree.WorkStarter.createAndSendKickoff logs that and carries on). It
// survives with a row still naming the work that no longer runs it, until a full
// sync or a fresh subscription reads the relation again.
func (w *SessionListWatcher) notifyWorkChange(event work.ChangeEvent) {
	sessionID := event.Work.SessionID
	if sessionID == "" || !w.HasSubscriptions() {
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

	w.pushSession(session.OperationUpdate, meta, workID)
	slog.Debug("notified session list of a work change", "workId", event.Work.ID, "sessionId", sessionID)
}

// pushSession sends one session's row, which is news to a subscriber that wants
// work sessions and must not exist for one that does not.
//
// A subscriber filtering them out gets a *removal* the first time a session it
// may still be holding turns out to belong to work — that is the only way to
// retract a row already on its screen — and nothing at all on the pushes after
// it, which is most of them: a running work session is touched several times a
// turn, and none of it can put back a row that has already gone.
//
// "May still be holding" is read off the work id last broadcast for this
// session: if that was already this work item, no subscriber can be holding the
// row. Unknown counts as maybe, so the removal goes out — a client drops a
// session id it does not hold, the same as any delete it cannot place.
func (w *SessionListWatcher) pushSession(op session.Operation, meta session.SessionMeta, workID string) {
	// Built once and shared by pointer across subscribers; read-only from here on.
	item := rpc.NewSessionListItem(meta, workID)
	previous, known := w.works.remember(item.ID, item.WorkID)
	retract := !known || previous == ""

	w.NotifyAll("session.list.changed", func(sub *Subscription) any {
		if !filterOf(sub).keeps(item) {
			if !retract {
				return nil
			}
			return sessionListChangedParams{
				ID:        sub.ID,
				Operation: string(session.OperationDelete),
				SessionID: item.ID,
			}
		}
		return sessionListChangedParams{
			ID:        sub.ID,
			Operation: string(op),
			Session:   &item,
		}
	})
}

func (w *SessionListWatcher) pushRemoval(sessionID string) {
	w.NotifyAll("session.list.changed", func(sub *Subscription) any {
		return sessionListChangedParams{
			ID:        sub.ID,
			Operation: string(session.OperationDelete),
			SessionID: sessionID,
		}
	})
}

// listRows reads the whole session list and resolves each row's work item,
// reading the work index once rather than once per row. Session ids are unique
// across worktrees, so the index needs no worktree filter.
func (w *SessionListWatcher) listRows() ([]rpc.SessionListItem, error) {
	sessions, err := w.store.List()
	if err != nil {
		return nil, err
	}

	workIDs, err := w.works.bySession()
	if err != nil {
		return nil, err
	}

	items := make([]rpc.SessionListItem, len(sessions))
	for i, sess := range sessions {
		items[i] = rpc.NewSessionListItem(sess, workIDs[sess.ID])
	}

	return items, nil
}

// resetSentWorkIDs records a whole list as sent. Only for a sync, which goes to
// every subscriber: recording a list that went to one of them — a snapshot a new
// subscriber asked for — would suppress the very notification that tells all the
// others about the change it read.
func (w *SessionListWatcher) resetSentWorkIDs(items []rpc.SessionListItem) {
	entries := make(map[string]string, len(items))
	for _, item := range items {
		entries[item.ID] = item.WorkID
	}
	w.works.reset(entries)
}

// filterRows narrows a whole list for one subscriber. The result is allocated
// rather than filtered in place, so an empty one goes out as `[]` — which a
// client can iterate — and not `null`, which it cannot.
func filterRows(items []rpc.SessionListItem, filter SessionListFilter) []rpc.SessionListItem {
	if !filter.ExcludeWorkSessions {
		return items
	}
	kept := make([]rpc.SessionListItem, 0, len(items))
	for _, item := range items {
		if filter.keeps(item) {
			kept = append(kept, item)
		}
	}
	return kept
}

// notifySync sends the full session list to all subscribers after dropped events.
func (w *SessionListWatcher) notifySync() {
	if !w.HasSubscriptions() {
		return
	}

	items, err := w.listRows()
	if err != nil {
		// The flag goes back up: this sync is the only thing that can replace the
		// events that were dropped, and without it the next event would push one
		// row incrementally onto a list still missing them.
		w.dirty.Store(true)
		slog.Error("failed to list sessions for sync", "error", err)
		return
	}
	w.resetSentWorkIDs(items)
	// Both narrowings built once rather than per subscriber: there are only two,
	// and a sync goes to every subscriber at once.
	plain := filterRows(items, SessionListFilter{ExcludeWorkSessions: true})

	w.NotifyAll("session.list.changed", func(sub *Subscription) any {
		sessions := items
		if filterOf(sub).ExcludeWorkSessions {
			sessions = plain
		}
		return sessionListSyncParams{
			ID:        sub.ID,
			Operation: "sync",
			Sessions:  sessions,
		}
	})

	slog.Info("sent full sync to subscribers after event drop")
}

// Subscribe registers a subscriber under the client-chosen id and returns the
// current session list, narrowed by filter — which is kept on the subscription
// and applied to everything it is sent afterwards.
//
// Registered before the list is read, so a change landing between the two is
// notified rather than lost; see BaseWatcher.AddSubscription.
func (w *SessionListWatcher) Subscribe(id string, notifier Notifier, filter SessionListFilter) ([]rpc.SessionListItem, error) {
	sub := &Subscription{
		ID:       id,
		Filter:   filter,
		Notifier: notifier,
	}
	if err := w.AddSubscription(sub); err != nil {
		return nil, err
	}

	items, err := w.listRows()
	if err != nil {
		w.RemoveSubscription(id)
		return nil, err
	}

	return filterRows(items, filter), nil
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
	w.sendEvent(sessionListEvent{session: &event})
}

// HandleWorkChange is told that a work item changed in this worktree, because a
// row names the work item its session runs.
//
// Called by worktree.Manager rather than registered on the work store directly:
// that store is global and keeps its listeners for the life of the process,
// while worktrees are built and dropped as clients come and go — a watcher
// registered there would outlive its worktree and hold it alive. Same mutex
// contract as OnSessionChange: queued, never handled here.
func (w *SessionListWatcher) HandleWorkChange(event work.ChangeEvent) {
	w.sendEvent(sessionListEvent{work: &event})
}

func (w *SessionListWatcher) sendEvent(event sessionListEvent) {
	// Skip if watcher is stopped
	if w.Context().Err() != nil {
		return
	}

	select {
	case w.eventCh <- event:
	default:
		w.dirty.Store(true)
		slog.Warn("session list change event dropped, will sync on next event")
	}
}
