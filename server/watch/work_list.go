package watch

import (
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"

	"github.com/pockode/server/rpc"
	"github.com/pockode/server/session"
	"github.com/pockode/server/work"
)

// WorkListWatcher notifies subscribers when the work list changes.
// Follows the same channel-based async pattern as SessionListWatcher.
//
// A row carries the work's Activity, which is derived from the turn of the
// session it runs in — so the list changes for two reasons, not one, and the
// second is a session moving in a worktree the client may not even have open.
// Why that derivation is the server's job is docs/lifecycle-ui.md §1.3.
type WorkListWatcher struct {
	*BaseWatcher
	store      work.Store
	turnSource work.TurnSource
	eventCh    chan listEvent
	dirty      atomic.Bool // set when an event is dropped; triggers full sync

	// sentActivityMu guards sentActivity: the activity last put on the wire for
	// each work item. A session is touched at the end of every turn, marked
	// unread, credited with usage; almost none of that moves an activity, and a
	// row pushed to every subscriber for each of them would be the most frequent
	// notification in the app.
	sentActivityMu sync.Mutex
	sentActivity   map[string]work.Activity
}

// listEvent is a union of the two changes that alter a row: the work item
// itself, and the turn of a session some work item runs in. Exactly one field
// is set per event.
//
// A session event carries the turn it arrived with rather than a session id to
// look up later: it is the value that caused the event, so deriving from it
// cannot read a different one than the notification was about — and it saves
// asking the turn source for a worktree whose answer is already in hand.
type listEvent struct {
	workEvent *work.ChangeEvent
	session   *session.SessionMeta
}

// NewWorkListWatcher builds the watcher. turnSource is where each worktree's
// turn state is read from (worktree.Manager in the server); nil is tolerated for
// narrow tests, and reads every active work as idle.
func NewWorkListWatcher(store work.Store, turnSource work.TurnSource) *WorkListWatcher {
	w := &WorkListWatcher{
		BaseWatcher:  NewBaseWatcher(),
		store:        store,
		turnSource:   turnSource,
		eventCh:      make(chan listEvent, 64),
		sentActivity: make(map[string]work.Activity),
	}
	store.AddOnChangeListener(w)
	return w
}

func (w *WorkListWatcher) Start() error {
	w.Go(w.eventLoop)
	slog.Info("WorkListWatcher started")
	return nil
}

func (w *WorkListWatcher) Stop() {
	w.CancelAndWait()
	slog.Info("WorkListWatcher stopped")
}

func (w *WorkListWatcher) eventLoop() {
	for {
		select {
		case <-w.Context().Done():
			return
		case event := <-w.eventCh:
			if w.dirty.Swap(false) {
				w.notifySync()
			} else if event.workEvent != nil {
				w.notifyChange(*event.workEvent)
			} else if event.session != nil {
				w.notifySessionChange(*event.session)
			}
		}
	}
}

func (w *WorkListWatcher) notifyChange(event work.ChangeEvent) {
	if event.Op == work.OperationDelete {
		w.forget(event.Work.ID)
	}
	if !w.HasSubscriptions() {
		return
	}

	// Built once and shared by pointer across subscribers: NotifyAll calls this
	// per subscription, and the row is read-only from here on.
	var row *rpc.WorkListItem
	if event.Op != work.OperationDelete {
		item := rpc.NewWorkListItem(event.Work, work.NewActivityResolver(w.turnSource).Activity(event.Work))
		w.rememberActivity(item.ID, item.Activity)
		row = &item
	}

	w.push(event.Op, event.Work.ID, row)
	slog.Debug("notified work list change", "operation", event.Op)
}

// notifySessionChange pushes the row of the work running in this session, and
// only when its activity has actually moved.
func (w *WorkListWatcher) notifySessionChange(meta session.SessionMeta) {
	if meta.ID == "" || !w.HasSubscriptions() {
		return
	}

	item, found, err := w.store.FindBySessionID(meta.ID)
	if err != nil {
		slog.Error("failed to find work for a session change", "sessionId", meta.ID, "error", err)
		return
	}
	if !found {
		return // A plain chat session, belonging to no work item.
	}

	activity := work.DeriveActivity(item, meta.Turn)
	if w.activityAlreadySent(item.ID, activity) {
		return
	}
	w.rememberActivity(item.ID, activity)

	row := rpc.NewWorkListItem(item, activity)
	w.push(work.OperationUpdate, item.ID, &row)
	slog.Debug("notified work activity change", "workId", item.ID, "activity", activity)
}

func (w *WorkListWatcher) push(op work.Operation, workID string, row *rpc.WorkListItem) {
	w.NotifyAll("work.list.changed", func(sub *Subscription) any {
		params := workListChangedParams{
			ID:        sub.ID,
			Operation: string(op),
			Work:      row,
		}
		if op == work.OperationDelete {
			params.WorkID = workID
		}
		return params
	})
}

func (w *WorkListWatcher) activityAlreadySent(workID string, activity work.Activity) bool {
	w.sentActivityMu.Lock()
	defer w.sentActivityMu.Unlock()
	sent, found := w.sentActivity[workID]
	return found && sent == activity
}

func (w *WorkListWatcher) rememberActivity(workID string, activity work.Activity) {
	w.sentActivityMu.Lock()
	defer w.sentActivityMu.Unlock()
	w.sentActivity[workID] = activity
}

func (w *WorkListWatcher) forget(workID string) {
	w.sentActivityMu.Lock()
	defer w.sentActivityMu.Unlock()
	delete(w.sentActivity, workID)
}

// notifySync sends the full work list to all subscribers after dropped events.
func (w *WorkListWatcher) notifySync() {
	if !w.HasSubscriptions() {
		return
	}

	items, err := w.listRows()
	if err != nil {
		slog.Error("failed to list works for sync", "error", err)
		return
	}

	// Cut once and shared: a sync goes to every subscriber at the same moment,
	// and this list is not narrowed per subscriber.
	current, hidden := currentSegment(items, CurrentGroupCap)

	w.NotifyAll("work.list.changed", func(sub *Subscription) any {
		return workListSyncParams{
			ID:            sub.ID,
			Operation:     "sync",
			Works:         current,
			StoppedHidden: hidden.Stopped,
			OpenHidden:    hidden.Open,
		}
	})

	slog.Info("sent full sync to subscribers after event drop")
}

// listRows reads the whole list and derives each row's activity, reading every
// worktree's turn state at most once.
//
// Allocated to length rather than appended to, so an empty store yields an empty
// slice and not nil: a client with no work items is sent `[]`, which it can
// iterate, rather than `null`, which it cannot.
func (w *WorkListWatcher) listRows() ([]rpc.WorkListItem, error) {
	items, err := w.readRows()
	if err != nil {
		return nil, err
	}

	w.sentActivityMu.Lock()
	// Replaced rather than merged: this is the whole list, so anything not in it
	// no longer exists.
	w.sentActivity = make(map[string]work.Activity, len(items))
	for _, item := range items {
		w.sentActivity[item.ID] = item.Activity
	}
	w.sentActivityMu.Unlock()

	return items, nil
}

// readRows is listRows without the record of what has been sent: for the reads
// that answer one client and push nothing. Recording a list nobody was notified
// of would suppress the very pushes that would have told them about it.
func (w *WorkListWatcher) readRows() ([]rpc.WorkListItem, error) {
	works, err := w.store.List()
	if err != nil {
		return nil, err
	}

	resolver := work.NewActivityResolver(w.turnSource)
	items := make([]rpc.WorkListItem, len(works))
	for i, item := range works {
		items[i] = rpc.NewWorkListItem(item, resolver.Activity(item))
	}
	return items, nil
}

// Subscribe registers a subscriber under the client-chosen id and returns the
// current work list.
//
// Registered before the list is read, so a change landing between the two is
// notified rather than lost; see BaseWatcher.AddSubscription.
func (w *WorkListWatcher) Subscribe(id string, notifier Notifier) (WorkListSnapshot, error) {
	sub := &Subscription{
		ID:       id,
		Notifier: notifier,
	}
	if err := w.AddSubscription(sub); err != nil {
		return WorkListSnapshot{}, err
	}

	items, err := w.listRows()
	if err != nil {
		w.RemoveSubscription(id)
		return WorkListSnapshot{}, err
	}

	current, hidden := currentSegment(items, CurrentGroupCap)
	return WorkListSnapshot{Items: current, Hidden: hidden}, nil
}

// Archive serves one page of closed work to the subscription that asked.
//
// Nothing is remembered about which page a subscriber is on, and nothing is
// pushed to it: the page the user asked for is the page they keep, a work
// closed while they are on page 3 belongs at the top of page 1, and nobody is
// waiting on the archive (docs/list-paging-ui.md §4.3).
func (w *WorkListWatcher) Archive(id, cursor string, limit int) (WorkListArchivePage, error) {
	if w.GetSubscription(id) == nil {
		return WorkListArchivePage{}, fmt.Errorf("%w: %s", ErrSubscriptionNotFound, id)
	}

	items, err := w.readRows()
	if err != nil {
		return WorkListArchivePage{}, err
	}

	rows, next, hasMore, err := archiveSegment(items, cursor, limit)
	if err != nil {
		return WorkListArchivePage{}, err
	}

	return WorkListArchivePage{
		Items:      rows,
		NextCursor: cursorString(next, hasMore),
		HasMore:    hasMore,
	}, nil
}

// Earlier serves the `Current` segment with both group caps lifted. It is the
// whole segment rather than the difference, because a cap is not a page: the
// client replaces what it holds, and there is no second press to keep in step
// with.
//
// Both caps at once, even when only one group asked: one press lifts the lid on
// the segment, so when two groups each offer the control, either of them clears
// both (docs/list-paging-ui.md §4.1).
func (w *WorkListWatcher) Earlier(id string) ([]rpc.WorkListItem, error) {
	if w.GetSubscription(id) == nil {
		return nil, fmt.Errorf("%w: %s", ErrSubscriptionNotFound, id)
	}

	items, err := w.readRows()
	if err != nil {
		return nil, err
	}

	current, _ := currentSegment(items, 0)
	return current, nil
}

// WorkListSnapshot is the `Current` segment as a subscription's first answer;
// see rpc.WorkListSubscribeResult.
type WorkListSnapshot struct {
	Items  []rpc.WorkListItem
	Hidden CurrentHidden
}

// WorkListArchivePage is one page of the closed archive.
type WorkListArchivePage struct {
	Items      []rpc.WorkListItem
	NextCursor string
	HasMore    bool
}

type workListChangedParams struct {
	ID        string            `json:"id"`
	Operation string            `json:"operation"`
	Work      *rpc.WorkListItem `json:"work,omitempty"`
	WorkID    string            `json:"workId,omitempty"`
}

type workListSyncParams struct {
	ID        string             `json:"id"`
	Operation string             `json:"operation"`
	Works     []rpc.WorkListItem `json:"works"`
	// Each is over its whole group, never over what was sent; see
	// rpc.WorkListSubscribeResult.
	StoppedHidden int `json:"stopped_hidden,omitempty"`
	OpenHidden    int `json:"open_hidden,omitempty"`
}

// OnWorkChange implements work.OnChangeListener.
// Called outside the store's mutex, but still must not block
// to avoid delaying other listeners.
func (w *WorkListWatcher) OnWorkChange(event work.ChangeEvent) {
	w.sendEvent(listEvent{workEvent: &event})
}

// OnSessionChange implements session.OnChangeListener, which is how a row keeps
// up with the turn it draws: nothing about the work item changes when its agent
// starts producing output or stops on a question.
//
// A deletion is skipped: it carries no turn, and the work above a deleted
// session is stopped by the engine — which is a work change, and arrives as one.
//
// Queued rather than handled here, because the session store holds its lock
// across this call and the work store is read on the other side of it.
func (w *WorkListWatcher) OnSessionChange(event session.SessionChangeEvent) {
	if event.Op == session.OperationDelete {
		return
	}
	meta := event.Session
	w.sendEvent(listEvent{session: &meta})
}

func (w *WorkListWatcher) sendEvent(event listEvent) {
	select {
	case <-w.Context().Done():
		return
	case w.eventCh <- event:
	default:
		w.dirty.Store(true)
		slog.Warn("work list change event dropped, will sync on next event")
	}
}
