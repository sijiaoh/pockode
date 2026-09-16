package watch

import (
	"log/slog"
	"sync"
	"sync/atomic"

	"github.com/pockode/server/session"
	"github.com/pockode/server/work"
)

// WorkDetailWatcher notifies subscribers when a work item, its comments, or the
// usage of a session anywhere in its subtree changes. Subscriptions are keyed by
// work_id — each subscriber watches a single work item's full detail.
type WorkDetailWatcher struct {
	*BaseWatcher
	store       work.Store
	usageSource work.SessionUsageSource
	eventCh     chan detailEvent
	dirty       atomic.Bool

	// sentUsageMu guards sentUsage: the usage last sent to each subscription,
	// which is what makes a session change that moved no number cost nothing.
	// Keyed by subscription id and dropped on unsubscribe, so it is bounded by
	// what clients are watching right now.
	sentUsageMu sync.Mutex
	sentUsage   map[string]work.Usage
}

// detailEvent is a union of the three changes that alter a work item's detail:
// the work item itself, its comments, and the usage of a session somewhere in
// its subtree. Exactly one field is set per event.
type detailEvent struct {
	workEvent    *work.ChangeEvent
	commentEvent *work.CommentEvent
	sessionID    string
}

// WorkDetail is everything a work.detail subscriber is sent: the work item, its
// comments, and what its subtree consumed.
type WorkDetail struct {
	Work     work.Work
	Comments []work.Comment
	Usage    work.Usage
}

// NewWorkDetailWatcher builds the watcher. usageSource is where the subtree's
// consumption is read from (worktree.Manager in the server); it is required, and
// a work detail without it would silently report that nothing was ever spent.
func NewWorkDetailWatcher(store work.Store, usageSource work.SessionUsageSource) *WorkDetailWatcher {
	w := &WorkDetailWatcher{
		BaseWatcher: NewBaseWatcher(),
		store:       store,
		usageSource: usageSource,
		eventCh:     make(chan detailEvent, 64),
		sentUsage:   make(map[string]work.Usage),
	}
	store.AddOnChangeListener(w)
	store.AddOnCommentChangeListener(w)
	return w
}

func (w *WorkDetailWatcher) Start() error {
	w.Go(w.eventLoop)
	slog.Info("WorkDetailWatcher started")
	return nil
}

func (w *WorkDetailWatcher) Stop() {
	w.CancelAndWait()
	slog.Info("WorkDetailWatcher stopped")
}

func (w *WorkDetailWatcher) eventLoop() {
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

func (w *WorkDetailWatcher) notifyChange(event detailEvent) {
	if !w.HasSubscriptions() {
		return
	}

	switch {
	case event.workEvent != nil:
		w.notifyForWorkID(event.workEvent.Work.ID, false)
	case event.commentEvent != nil:
		w.notifyForWorkID(event.commentEvent.Comment.WorkID, false)
	default:
		w.notifyForSessionID(event.sessionID)
	}
}

// notifyForWorkID fetches the latest work + comments and sends to subscribers of
// this work_id.
//
// fromSession says a session in the subtree changed, rather than the work item
// or its comments. Those changes are frequent and mostly not about money — a
// session is touched at the end of every turn, marked unread, marked as needing
// input — while a detail notification carries the work item and its *entire*
// comment list. So one is only sent if the aggregation actually moved.
func (w *WorkDetailWatcher) notifyForWorkID(workID string, fromSession bool) {
	// This watcher receives every work/comment change in the app, but detail
	// subscriptions normally exist only for the one work item a client has open.
	// Skip the store reads (two linear scans + allocation) when nobody is
	// watching this work_id.
	if !w.HasSubscriptionForKey(workID) {
		return
	}

	detail, ok := w.buildDetail(workID)
	if !ok {
		return
	}

	for _, sub := range w.GetAllSubscriptions() {
		if sub.Key != workID {
			continue
		}
		// Judged per subscription, not per work_id: two clients can be on the same
		// work item at different aggregations, and telling one of them must not
		// leave the other stale.
		if fromSession && w.usageAlreadySent(sub.ID, detail.Usage) {
			continue
		}
		w.rememberSentUsage(sub.ID, detail.Usage)
		w.notifyDetail(sub, detail)
	}
}

func (w *WorkDetailWatcher) notifyDetail(sub *Subscription, detail WorkDetail) {
	n := Notification{Method: "work.detail.changed", Params: workDetailChangedParams{
		ID:       sub.ID,
		Work:     detail.Work,
		Comments: detail.Comments,
		Usage:    detail.Usage,
	}}
	if err := sub.Notifier.Notify(w.Context(), n); err != nil {
		slog.Debug("failed to notify detail subscriber", "id", sub.ID, "error", err)
	}
}

// notifyForSessionID re-sends the detail of the work item owning the session and
// of every work item above it, because a usage total covers the whole subtree:
// the session that just spent tokens is part of each of its ancestors' totals.
func (w *WorkDetailWatcher) notifyForSessionID(sessionID string) {
	if sessionID == "" || !w.HasSubscriptions() {
		return
	}

	item, found, err := w.store.FindBySessionID(sessionID)
	if err != nil {
		slog.Error("failed to find work for session usage notification", "error", err, "sessionId", sessionID)
		return
	}
	if !found {
		return // A plain chat session, belonging to no work item.
	}

	// Bounded by the seen set rather than by trusting the parent chain: a cycle
	// in it would otherwise walk forever on every session change.
	seen := make(map[string]struct{})
	for {
		if _, dup := seen[item.ID]; dup {
			slog.Warn("work parent chain loops, stopping usage notification walk", "workId", item.ID)
			return
		}
		seen[item.ID] = struct{}{}

		w.notifyForWorkID(item.ID, true)

		if item.ParentID == "" {
			return
		}
		parent, found, err := w.store.Get(item.ParentID)
		if err != nil {
			slog.Error("failed to get parent work for usage notification", "error", err, "workId", item.ParentID)
			return
		}
		if !found {
			return
		}
		item = parent
	}
}

// buildDetail reads a work item's current detail, or reports that there is none
// to send — the work item was deleted between the event and this read.
func (w *WorkDetailWatcher) buildDetail(workID string) (WorkDetail, bool) {
	item, found, err := w.store.Get(workID)
	if err != nil {
		slog.Error("failed to get work for detail notification", "error", err, "workId", workID)
		return WorkDetail{}, false
	}
	if !found {
		return WorkDetail{}, false
	}

	comments, err := w.store.ListComments(workID)
	if err != nil {
		slog.Error("failed to list comments for detail notification", "error", err, "workId", workID)
		return WorkDetail{}, false
	}

	usage, err := work.AggregateUsage(w.store, w.usageSource, item)
	if err != nil {
		slog.Error("failed to aggregate work usage", "error", err, "workId", workID)
		return WorkDetail{}, false
	}

	return WorkDetail{Work: item, Comments: comments, Usage: usage}, true
}

// usageAlreadySent reports whether this subscription has the aggregation
// already. A subscription we have recorded nothing for counts as not having it.
func (w *WorkDetailWatcher) usageAlreadySent(subID string, usage work.Usage) bool {
	w.sentUsageMu.Lock()
	defer w.sentUsageMu.Unlock()
	sent, found := w.sentUsage[subID]
	return found && sent.Equal(usage)
}

func (w *WorkDetailWatcher) rememberSentUsage(subID string, usage work.Usage) {
	w.sentUsageMu.Lock()
	defer w.sentUsageMu.Unlock()
	w.sentUsage[subID] = usage
}

// Unsubscribe also forgets what that subscription was sent — otherwise the map
// would keep an entry per work item ever opened, for the life of the process.
func (w *WorkDetailWatcher) Unsubscribe(id string) {
	w.RemoveSubscription(id)
	w.sentUsageMu.Lock()
	defer w.sentUsageMu.Unlock()
	delete(w.sentUsage, id)
}

// notifySyncAll sends the full detail for every subscribed work_id.
// Called after dropped events, where we don't know which work_ids were affected.
func (w *WorkDetailWatcher) notifySyncAll() {
	subs := w.GetAllSubscriptions()
	if len(subs) == 0 {
		return
	}

	// Collect unique work_ids to avoid redundant store reads.
	workIDs := make(map[string]struct{})
	for _, sub := range subs {
		workIDs[sub.Key] = struct{}{}
	}

	cache := make(map[string]WorkDetail, len(workIDs))
	for wid := range workIDs {
		detail, ok := w.buildDetail(wid)
		if !ok {
			continue
		}
		cache[wid] = detail
	}

	for _, sub := range subs {
		d, ok := cache[sub.Key]
		if !ok {
			continue
		}
		w.rememberSentUsage(sub.ID, d.Usage)
		w.notifyDetail(sub, d)
	}

	slog.Info("sent full detail sync to subscribers after event drop")
}

// Subscribe registers a subscriber for a specific work item's detail, under the
// client-chosen id.
//
// Registered before the store read, so a change landing between the two is
// notified rather than lost; see BaseWatcher.AddSubscription.
func (w *WorkDetailWatcher) Subscribe(id, workID string, notifier Notifier) (WorkDetail, error) {
	sub := &Subscription{
		ID:       id,
		Key:      workID,
		Notifier: notifier,
	}
	if err := w.AddSubscription(sub); err != nil {
		return WorkDetail{}, err
	}

	item, found, err := w.store.Get(workID)
	if err != nil {
		w.RemoveSubscription(id)
		return WorkDetail{}, err
	}
	if !found {
		w.RemoveSubscription(id)
		return WorkDetail{}, work.ErrWorkNotFound
	}

	comments, err := w.store.ListComments(workID)
	if err != nil {
		w.RemoveSubscription(id)
		return WorkDetail{}, err
	}

	usage, err := work.AggregateUsage(w.store, w.usageSource, item)
	if err != nil {
		w.RemoveSubscription(id)
		return WorkDetail{}, err
	}

	// The reply carries the aggregation, so the subscriber already has it: a
	// session change that moves nothing is then not worth a notification either.
	w.rememberSentUsage(id, usage)

	return WorkDetail{Work: item, Comments: comments, Usage: usage}, nil
}

type workDetailChangedParams struct {
	ID       string         `json:"id"`
	Work     work.Work      `json:"work"`
	Comments []work.Comment `json:"comments"`
	// Usage rides on the notification rather than on Work, for the reason
	// work.Usage documents.
	Usage work.Usage `json:"usage"`
}

// OnWorkChange implements work.OnChangeListener.
func (w *WorkDetailWatcher) OnWorkChange(event work.ChangeEvent) {
	w.sendEvent(detailEvent{workEvent: &event})
}

// OnCommentChange implements work.OnCommentChangeListener.
func (w *WorkDetailWatcher) OnCommentChange(event work.CommentEvent) {
	w.sendEvent(detailEvent{commentEvent: &event})
}

// OnSessionChange implements session.OnChangeListener, which is how a work
// item's usage keeps up while its agents run: nothing about the work item itself
// changes when one of its sessions spends tokens.
//
// Queued rather than handled here — the session store holds its lock across this
// call, and the aggregation reads session state.
func (w *WorkDetailWatcher) OnSessionChange(event session.SessionChangeEvent) {
	w.sendEvent(detailEvent{sessionID: event.Session.ID})
}

func (w *WorkDetailWatcher) sendEvent(event detailEvent) {
	select {
	case <-w.Context().Done():
		return
	case w.eventCh <- event:
	default:
		w.dirty.Store(true)
		slog.Warn("work detail event dropped, will sync on next event")
	}
}
