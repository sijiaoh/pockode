package watch

import (
	"log/slog"
	"sync/atomic"

	"github.com/pockode/server/work"
)

// WorkCommentWatcher notifies subscribers when comments are added to a work item.
// Subscriptions are keyed by work_id — each subscriber watches a single work item's comments.
type WorkCommentWatcher struct {
	*BaseWatcher
	store   work.Store
	eventCh chan work.CommentEvent
	dirty   atomic.Bool
}

func NewWorkCommentWatcher(store work.Store) *WorkCommentWatcher {
	w := &WorkCommentWatcher{
		BaseWatcher: NewBaseWatcher("wc"),
		store:       store,
		eventCh:     make(chan work.CommentEvent, 64),
	}
	store.AddOnCommentChangeListener(w)
	return w
}

func (w *WorkCommentWatcher) Start() error {
	go w.eventLoop()
	slog.Info("WorkCommentWatcher started")
	return nil
}

func (w *WorkCommentWatcher) Stop() {
	w.Cancel()
	slog.Info("WorkCommentWatcher stopped")
}

func (w *WorkCommentWatcher) eventLoop() {
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

func (w *WorkCommentWatcher) notifyChange(event work.CommentEvent) {
	if !w.HasSubscriptions() {
		return
	}

	w.notifyFiltered(event.Comment.WorkID, "work.comment.changed", func(sub *Subscription) any {
		return workCommentChangedParams{
			ID:        sub.ID,
			Operation: "create",
			Comment:   event.Comment,
		}
	})
}

// notifySyncAll sends the full comment list for every subscribed work_id.
// Called after dropped events, where we don't know which work_ids were affected.
func (w *WorkCommentWatcher) notifySyncAll() {
	subs := w.GetAllSubscriptions()
	if len(subs) == 0 {
		return
	}

	// Collect unique work_ids to avoid redundant store reads
	workIDs := make(map[string]struct{})
	for _, sub := range subs {
		workIDs[sub.WorkID] = struct{}{}
	}

	// Fetch and cache comments per work_id
	commentsByWorkID := make(map[string][]work.Comment, len(workIDs))
	for wid := range workIDs {
		comments, err := w.store.ListComments(wid)
		if err != nil {
			slog.Error("failed to list comments for sync", "error", err, "workId", wid)
			continue
		}
		commentsByWorkID[wid] = comments
	}

	for _, sub := range subs {
		comments, ok := commentsByWorkID[sub.WorkID]
		if !ok {
			continue
		}
		params := workCommentSyncParams{
			ID:        sub.ID,
			Operation: "sync",
			WorkID:    sub.WorkID,
			Comments:  comments,
		}
		n := Notification{Method: "work.comment.changed", Params: params}
		if err := sub.Notifier.Notify(w.Context(), n); err != nil {
			slog.Debug("failed to notify comment subscriber",
				"id", sub.ID,
				"error", err)
		}
	}

	slog.Info("sent full comment sync to subscribers after event drop")
}

// notifyFiltered sends a notification only to subscribers watching the given work_id.
func (w *WorkCommentWatcher) notifyFiltered(workID, method string, makeParams func(sub *Subscription) any) {
	subs := w.GetAllSubscriptions()
	for _, sub := range subs {
		if sub.WorkID != workID {
			continue
		}
		params := makeParams(sub)
		n := Notification{Method: method, Params: params}
		if err := sub.Notifier.Notify(w.Context(), n); err != nil {
			slog.Debug("failed to notify comment subscriber",
				"id", sub.ID,
				"error", err)
		}
	}
}

// Subscribe registers a subscriber for a specific work item's comments.
func (w *WorkCommentWatcher) Subscribe(workID string, notifier Notifier) (string, []work.Comment, error) {
	id := w.GenerateID()
	sub := &Subscription{
		ID:       id,
		WorkID:   workID,
		Notifier: notifier,
	}
	w.AddSubscription(sub)

	comments, err := w.store.ListComments(workID)
	if err != nil {
		w.RemoveSubscription(id)
		return "", nil, err
	}

	return id, comments, nil
}

type workCommentChangedParams struct {
	ID        string       `json:"id"`
	Operation string       `json:"operation"`
	Comment   work.Comment `json:"comment"`
}

type workCommentSyncParams struct {
	ID        string         `json:"id"`
	Operation string         `json:"operation"`
	WorkID    string         `json:"work_id"`
	Comments  []work.Comment `json:"comments"`
}

// OnCommentChange implements work.OnCommentChangeListener.
func (w *WorkCommentWatcher) OnCommentChange(event work.CommentEvent) {
	select {
	case <-w.Context().Done():
		return
	case w.eventCh <- event:
	default:
		w.dirty.Store(true)
		slog.Warn("work comment event dropped, will sync on next event", "workId", event.Comment.WorkID)
	}
}
