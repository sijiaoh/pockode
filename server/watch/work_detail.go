package watch

import (
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/pockode/server/rpc"
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
	turnSource  work.TurnSource
	eventCh     chan detailEvent
	dirty       atomic.Bool

	// sentUsageMu guards sentUsage: what was last sent to each subscription of
	// the two things a session change can move, which is what makes a session
	// change that moved neither cost nothing. Keyed by subscription id and
	// dropped on unsubscribe, so it is bounded by what clients are watching
	// right now.
	sentUsageMu sync.Mutex
	sentUsage   map[string]sentDetail
}

// sentDetail is what a subscription has already been told about the two derived
// parts of a detail. Judged per subscription, not per work item: two clients can
// be on the same work item at different states, and telling one must not leave
// the other stale.
type sentDetail struct {
	sentUsage    work.Usage
	sentActivity work.Activity
	// sentQuestions is the request ids of the pending questions last sent, in
	// order and joined. The ids and not a count: a question answered while
	// another is posted leaves the count where it was, and the detail lists the
	// questions themselves, so that change has to reach the subscriber.
	sentQuestions string
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
// comments, what its subtree consumed, what it is doing, and the two relations
// its page draws.
//
// Children and Parent ride here rather than being looked up in the work list,
// because that list is the `Current` segment and closed work is not in it: a
// closed story read out of the archive — or reached by reloading the page on
// it — would otherwise look childless, and a story's `{closed}/{total}` is a
// claim over children that get no rows anywhere (docs/list-paging-ui.md §2.2).
// The detail is the one place a story's tasks are listed, and it now answers
// for them itself.
type WorkDetail struct {
	Work     work.Work
	Comments []work.Comment
	Usage    work.Usage
	Activity work.Activity
	// PendingQuestions are the questions the item's session is waiting on
	// answers to, in full: the detail is the one surface with room for them.
	PendingQuestions []session.PendingQuestion
	Children         []rpc.WorkListItem
	Parent           *rpc.WorkListItem
}

// relatives reads the rows a detail page draws besides the item itself: the
// item's children, and the story it belongs to.
//
// Allocated to zero length rather than left nil, so a work with no children is
// sent `[]`, which a client can iterate, and not `null`, which it cannot.
func (w *WorkDetailWatcher) relatives(item work.Work) ([]rpc.WorkListItem, *rpc.WorkListItem, error) {
	items, err := w.store.List()
	if err != nil {
		return nil, nil, err
	}

	resolver := work.NewActivityResolver(w.turnSource)
	children := make([]rpc.WorkListItem, 0, 4)
	var parent *rpc.WorkListItem
	for _, other := range items {
		switch {
		case other.StoryID == item.ID:
			children = append(children, rpc.NewWorkListItem(other, resolver.RowState(other)))
		case item.StoryID != "" && other.ID == item.StoryID:
			row := rpc.NewWorkListItem(other, resolver.RowState(other))
			parent = &row
		}
	}
	return children, parent, nil
}

// NewWorkDetailWatcher builds the watcher. usageSource is where the subtree's
// consumption is read from (worktree.Manager in the server); it is required, and
// a work detail without it would silently report that nothing was ever spent.
// turnSource is where the work's own activity is derived from; nil reads it as
// idle, which is what a narrow test wants and nothing else.
func NewWorkDetailWatcher(store work.Store, usageSource work.SessionUsageSource, turnSource work.TurnSource) *WorkDetailWatcher {
	w := &WorkDetailWatcher{
		BaseWatcher: NewBaseWatcher(),
		store:       store,
		usageSource: usageSource,
		turnSource:  turnSource,
		eventCh:     make(chan detailEvent, 64),
		sentUsage:   make(map[string]sentDetail),
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
	// Skip the store reads (several linear scans + allocation) when nobody is
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
		if fromSession && w.usageAlreadySent(sub.ID, detail.Usage) && !w.derivedMoved(sub.ID, detail) {
			continue
		}
		w.rememberSent(sub.ID, detail)
		w.notifyDetail(sub, detail)
	}
}

func (w *WorkDetailWatcher) notifyDetail(sub *Subscription, detail WorkDetail) {
	n := Notification{Method: "work.detail.changed", Params: workDetailChangedParams{
		ID:               sub.ID,
		Work:             rpc.NewWorkDetailItem(detail.Work),
		Comments:         detail.Comments,
		Usage:            detail.Usage,
		Activity:         detail.Activity,
		PendingQuestions: detail.PendingQuestions,
		Children:         detail.Children,
		Parent:           detail.Parent,
	}}
	if err := sub.Notifier.Notify(w.Context(), n); err != nil {
		slog.Debug("failed to notify detail subscriber", "id", sub.ID, "error", err)
	}
}

// notifyForSessionID re-sends the detail of the work item owning the session
// and, when that item is a task, of its story: a usage total covers a story and
// its tasks, so the session that just spent tokens is part of the story's total
// too. There is no level above a story, so there is nothing further to walk.
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

	w.notifyForWorkID(item.ID, true)
	if item.StoryID != "" {
		w.notifyForWorkID(item.StoryID, true)
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

	children, parent, err := w.relatives(item)
	if err != nil {
		slog.Error("failed to read work relatives for detail notification", "error", err, "workId", workID)
		return WorkDetail{}, false
	}

	resolver := work.NewActivityResolver(w.turnSource)
	return WorkDetail{
		Work:             item,
		Comments:         comments,
		Usage:            usage,
		Activity:         resolver.Activity(item),
		PendingQuestions: resolver.PendingQuestions(item),
		Children:         children,
		Parent:           parent,
	}, true
}

// usageAlreadySent reports whether this subscription has the aggregation
// already. A subscription we have recorded nothing for counts as not having it.
func (w *WorkDetailWatcher) usageAlreadySent(subID string, usage work.Usage) bool {
	w.sentUsageMu.Lock()
	defer w.sentUsageMu.Unlock()
	sent, found := w.sentUsage[subID]
	return found && sent.sentUsage.Equal(usage)
}

// derivedMoved is the other half of the same question, and the reason a session
// change is not judged on money alone: a turn starting spends nothing and is the
// most visible thing that can happen to an open work item — and so is a question
// appearing on it.
func (w *WorkDetailWatcher) derivedMoved(subID string, detail WorkDetail) bool {
	w.sentUsageMu.Lock()
	defer w.sentUsageMu.Unlock()
	sent, found := w.sentUsage[subID]
	if !found {
		return false
	}
	return sent.sentActivity != detail.Activity ||
		sent.sentQuestions != questionFingerprint(detail.PendingQuestions)
}

func (w *WorkDetailWatcher) rememberSent(subID string, detail WorkDetail) {
	w.sentUsageMu.Lock()
	defer w.sentUsageMu.Unlock()
	w.sentUsage[subID] = sentDetail{
		sentUsage:     detail.Usage,
		sentActivity:  detail.Activity,
		sentQuestions: questionFingerprint(detail.PendingQuestions),
	}
}

// questionFingerprint is the pending list reduced to what can change about it:
// which questions, in what order. A question's text never changes once posted.
func questionFingerprint(questions []session.PendingQuestion) string {
	ids := make([]string, len(questions))
	for i, q := range questions {
		ids[i] = q.RequestID
	}
	return strings.Join(ids, "\n")
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
		w.rememberSent(sub.ID, d)
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

	resolver := work.NewActivityResolver(w.turnSource)

	children, parent, err := w.relatives(item)
	if err != nil {
		w.RemoveSubscription(id)
		return WorkDetail{}, err
	}

	detail := WorkDetail{
		Work:             item,
		Comments:         comments,
		Usage:            usage,
		Activity:         resolver.Activity(item),
		PendingQuestions: resolver.PendingQuestions(item),
		Children:         children,
		Parent:           parent,
	}
	// The reply carries every derived part, so the subscriber already has them:
	// a session change that moves none of them is then not worth a notification.
	w.rememberSent(id, detail)
	return detail, nil
}

type workDetailChangedParams struct {
	ID string `json:"id"`
	// Work is the same shape the subscribe result carries, built by the same
	// narrowing: a subscriber must not be handed a different item by the
	// notification than by the reply it started from.
	Work     rpc.WorkDetailItem `json:"work"`
	Comments []work.Comment     `json:"comments"`
	// Usage rides on the notification rather than on Work, for the reason
	// work.Usage documents. Activity is derived too, and for the same reason
	// is not a field of the work item.
	Usage    work.Usage    `json:"usage"`
	Activity work.Activity `json:"activity"`
	// PendingQuestions is the same field, and the same rule, as
	// rpc.WorkDetailSubscribeResult.PendingQuestions.
	PendingQuestions []session.PendingQuestion `json:"pending_questions,omitempty"`
	// Children and Parent are the two relations the page draws, and are here
	// rather than looked up in the work list for the reason WorkDetail gives.
	Children []rpc.WorkListItem `json:"children"`
	Parent   *rpc.WorkListItem  `json:"parent,omitempty"`
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
