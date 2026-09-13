package watch

import (
	"log/slog"
	"sync/atomic"

	"github.com/pockode/server/work"
)

// WorkListWatcher notifies subscribers when the work list changes.
// Follows the same channel-based async pattern as SessionListWatcher.
type WorkListWatcher struct {
	*BaseWatcher
	store   work.Store
	eventCh chan work.ChangeEvent
	dirty   atomic.Bool // set when an event is dropped; triggers full sync
}

func NewWorkListWatcher(store work.Store) *WorkListWatcher {
	w := &WorkListWatcher{
		BaseWatcher: NewBaseWatcher(),
		store:       store,
		eventCh:     make(chan work.ChangeEvent, 64),
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
			} else {
				w.notifyChange(event)
			}
		}
	}
}

func (w *WorkListWatcher) notifyChange(event work.ChangeEvent) {
	if !w.HasSubscriptions() {
		return
	}

	w.NotifyAll("work.list.changed", func(sub *Subscription) any {
		params := workListChangedParams{
			ID:        sub.ID,
			Operation: string(event.Op),
		}
		if event.Op == work.OperationDelete {
			params.WorkID = event.Work.ID
		} else {
			item := event.Work
			params.Work = &item
		}
		return params
	})

	slog.Debug("notified work list change", "operation", event.Op)
}

// notifySync sends the full work list to all subscribers after dropped events.
func (w *WorkListWatcher) notifySync() {
	if !w.HasSubscriptions() {
		return
	}

	works, err := w.store.List()
	if err != nil {
		slog.Error("failed to list works for sync", "error", err)
		return
	}

	w.NotifyAll("work.list.changed", func(sub *Subscription) any {
		return workListSyncParams{
			ID:        sub.ID,
			Operation: "sync",
			Works:     works,
		}
	})

	slog.Info("sent full sync to subscribers after event drop")
}

// Subscribe registers a subscriber under the client-chosen id and returns the
// current work list.
//
// Registered before the list is read, so a change landing between the two is
// notified rather than lost; see BaseWatcher.AddSubscription.
func (w *WorkListWatcher) Subscribe(id string, notifier Notifier) ([]work.Work, error) {
	sub := &Subscription{
		ID:       id,
		Notifier: notifier,
	}
	if err := w.AddSubscription(sub); err != nil {
		return nil, err
	}

	works, err := w.store.List()
	if err != nil {
		w.RemoveSubscription(id)
		return nil, err
	}

	return works, nil
}

type workListChangedParams struct {
	ID        string     `json:"id"`
	Operation string     `json:"operation"`
	Work      *work.Work `json:"work,omitempty"`
	WorkID    string     `json:"workId,omitempty"`
}

type workListSyncParams struct {
	ID        string      `json:"id"`
	Operation string      `json:"operation"`
	Works     []work.Work `json:"works"`
}

// OnWorkChange implements work.OnChangeListener.
// Called outside the store's mutex, but still must not block
// to avoid delaying other listeners.
func (w *WorkListWatcher) OnWorkChange(event work.ChangeEvent) {
	select {
	case <-w.Context().Done():
		return
	case w.eventCh <- event:
	default:
		w.dirty.Store(true)
		slog.Warn("work list change event dropped, will sync on next event", "operation", event.Op)
	}
}
