package watch

import (
	"log/slog"
	"sync/atomic"

	"github.com/pockode/server/schedule"
)

// ScheduleListWatcher notifies subscribers when the schedule list changes.
//
// Every change the store makes reaches subscribers, the run bookkeeping
// included: the next firing, the latest run, a skipped firing and a failed run
// are what a schedule's row exists to show, and they move without anyone
// editing the schedule.
type ScheduleListWatcher struct {
	*BaseWatcher
	store   schedule.Store
	eventCh chan schedule.ChangeEvent
	dirty   atomic.Bool
}

func NewScheduleListWatcher(store schedule.Store) *ScheduleListWatcher {
	w := &ScheduleListWatcher{
		BaseWatcher: NewBaseWatcher(),
		store:       store,
		eventCh:     make(chan schedule.ChangeEvent, 64),
	}
	store.AddOnChangeListener(w)
	return w
}

func (w *ScheduleListWatcher) Start() error {
	w.Go(w.eventLoop)
	slog.Info("ScheduleListWatcher started")
	return nil
}

func (w *ScheduleListWatcher) Stop() {
	w.CancelAndWait()
	slog.Info("ScheduleListWatcher stopped")
}

func (w *ScheduleListWatcher) eventLoop() {
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

func (w *ScheduleListWatcher) notifyChange(event schedule.ChangeEvent) {
	if !w.HasSubscriptions() {
		return
	}

	w.NotifyAll("schedule.list.changed", func(sub *Subscription) any {
		params := scheduleListChangedParams{
			ID:        sub.ID,
			Operation: string(event.Op),
		}
		if event.Op == schedule.OperationDelete {
			params.ScheduleID = event.Schedule.ID
		} else {
			sched := event.Schedule
			params.Schedule = &sched
		}
		return params
	})

	slog.Debug("notified schedule list change", "operation", event.Op)
}

func (w *ScheduleListWatcher) notifySync() {
	if !w.HasSubscriptions() {
		return
	}

	schedules, err := w.store.List()
	if err != nil {
		slog.Error("failed to list schedules for sync", "error", err)
		return
	}

	w.NotifyAll("schedule.list.changed", func(sub *Subscription) any {
		return scheduleListSyncParams{
			ID:        sub.ID,
			Operation: "sync",
			Schedules: schedules,
		}
	})

	slog.Info("sent full schedule sync to subscribers after event drop")
}

// Subscribe registers a subscriber under the client-chosen id and returns the
// current schedule list.
//
// Registered before the list is read, so a change landing between the two is
// notified rather than lost; see BaseWatcher.AddSubscription.
func (w *ScheduleListWatcher) Subscribe(id string, notifier Notifier) ([]schedule.Schedule, error) {
	sub := &Subscription{
		ID:       id,
		Notifier: notifier,
	}
	if err := w.AddSubscription(sub); err != nil {
		return nil, err
	}

	schedules, err := w.store.List()
	if err != nil {
		w.RemoveSubscription(id)
		return nil, err
	}
	return schedules, nil
}

type scheduleListChangedParams struct {
	ID         string             `json:"id"`
	Operation  string             `json:"operation"`
	Schedule   *schedule.Schedule `json:"schedule,omitempty"`
	ScheduleID string             `json:"scheduleId,omitempty"`
}

type scheduleListSyncParams struct {
	ID        string              `json:"id"`
	Operation string              `json:"operation"`
	Schedules []schedule.Schedule `json:"schedules"`
}

// OnScheduleChange implements schedule.OnChangeListener.
func (w *ScheduleListWatcher) OnScheduleChange(event schedule.ChangeEvent) {
	select {
	case <-w.Context().Done():
		return
	case w.eventCh <- event:
	default:
		w.dirty.Store(true)
		slog.Warn("schedule list change event dropped, will sync on next event", "operation", event.Op)
	}
}
