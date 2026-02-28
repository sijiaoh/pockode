package watch

import (
	"log/slog"
	"sync/atomic"

	"github.com/pockode/server/work"
)

// WorkDetailWatcher notifies subscribers when a work item or its comments change.
// Subscriptions are keyed by work_id — each subscriber watches a single work item's
// full detail (the work item itself plus its comments).
type WorkDetailWatcher struct {
	*BaseWatcher
	store   work.Store
	eventCh chan detailEvent
	dirty   atomic.Bool
}

// detailEvent is a union of work change and comment change events.
// Exactly one field is set per event.
type detailEvent struct {
	workEvent    *work.ChangeEvent
	commentEvent *work.CommentEvent
}

func NewWorkDetailWatcher(store work.Store) *WorkDetailWatcher {
	w := &WorkDetailWatcher{
		BaseWatcher: NewBaseWatcher("wd"),
		store:       store,
		eventCh:     make(chan detailEvent, 64),
	}
	store.AddOnChangeListener(w)
	store.AddOnCommentChangeListener(w)
	return w
}

func (w *WorkDetailWatcher) Start() error {
	go w.eventLoop()
	slog.Info("WorkDetailWatcher started")
	return nil
}

func (w *WorkDetailWatcher) Stop() {
	w.Cancel()
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

	var workID string
	if event.workEvent != nil {
		workID = event.workEvent.Work.ID
	} else {
		workID = event.commentEvent.Comment.WorkID
	}

	w.notifyForWorkID(workID)
}

// notifyForWorkID fetches the latest work + comments and sends to subscribers of this work_id.
func (w *WorkDetailWatcher) notifyForWorkID(workID string) {
	item, found, err := w.store.Get(workID)
	if err != nil {
		slog.Error("failed to get work for detail notification", "error", err, "workId", workID)
		return
	}
	if !found {
		return
	}

	comments, err := w.store.ListComments(workID)
	if err != nil {
		slog.Error("failed to list comments for detail notification", "error", err, "workId", workID)
		return
	}

	w.notifyFiltered(workID, "work.detail.changed", func(sub *Subscription) any {
		return workDetailChangedParams{
			ID:       sub.ID,
			Work:     item,
			Comments: comments,
		}
	})
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
		workIDs[sub.WorkID] = struct{}{}
	}

	type detail struct {
		Work     work.Work
		Comments []work.Comment
	}

	cache := make(map[string]*detail, len(workIDs))
	for wid := range workIDs {
		item, found, err := w.store.Get(wid)
		if err != nil {
			slog.Error("failed to get work for sync", "error", err, "workId", wid)
			continue
		}
		if !found {
			continue
		}
		comments, err := w.store.ListComments(wid)
		if err != nil {
			slog.Error("failed to list comments for sync", "error", err, "workId", wid)
			continue
		}
		cache[wid] = &detail{Work: item, Comments: comments}
	}

	for _, sub := range subs {
		d, ok := cache[sub.WorkID]
		if !ok {
			continue
		}
		params := workDetailChangedParams{
			ID:       sub.ID,
			Work:     d.Work,
			Comments: d.Comments,
		}
		n := Notification{Method: "work.detail.changed", Params: params}
		if err := sub.Notifier.Notify(w.Context(), n); err != nil {
			slog.Debug("failed to notify detail subscriber",
				"id", sub.ID,
				"error", err)
		}
	}

	slog.Info("sent full detail sync to subscribers after event drop")
}

// notifyFiltered sends a notification only to subscribers watching the given work_id.
func (w *WorkDetailWatcher) notifyFiltered(workID, method string, makeParams func(sub *Subscription) any) {
	subs := w.GetAllSubscriptions()
	for _, sub := range subs {
		if sub.WorkID != workID {
			continue
		}
		params := makeParams(sub)
		n := Notification{Method: method, Params: params}
		if err := sub.Notifier.Notify(w.Context(), n); err != nil {
			slog.Debug("failed to notify detail subscriber",
				"id", sub.ID,
				"error", err)
		}
	}
}

// Subscribe registers a subscriber for a specific work item's detail.
func (w *WorkDetailWatcher) Subscribe(workID string, notifier Notifier) (string, work.Work, []work.Comment, error) {
	id := w.GenerateID()
	sub := &Subscription{
		ID:       id,
		WorkID:   workID,
		Notifier: notifier,
	}
	w.AddSubscription(sub)

	item, found, err := w.store.Get(workID)
	if err != nil {
		w.RemoveSubscription(id)
		return "", work.Work{}, nil, err
	}
	if !found {
		w.RemoveSubscription(id)
		return "", work.Work{}, nil, work.ErrWorkNotFound
	}

	comments, err := w.store.ListComments(workID)
	if err != nil {
		w.RemoveSubscription(id)
		return "", work.Work{}, nil, err
	}

	return id, item, comments, nil
}

type workDetailChangedParams struct {
	ID       string         `json:"id"`
	Work     work.Work      `json:"work"`
	Comments []work.Comment `json:"comments"`
}

// OnWorkChange implements work.OnChangeListener.
func (w *WorkDetailWatcher) OnWorkChange(event work.ChangeEvent) {
	w.sendEvent(detailEvent{workEvent: &event})
}

// OnCommentChange implements work.OnCommentChangeListener.
func (w *WorkDetailWatcher) OnCommentChange(event work.CommentEvent) {
	w.sendEvent(detailEvent{commentEvent: &event})
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
