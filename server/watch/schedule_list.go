package watch

import (
	"log/slog"
	"sync"
	"sync/atomic"

	"github.com/pockode/server/rpc"
	"github.com/pockode/server/schedule"
	"github.com/pockode/server/session"
	"github.com/pockode/server/work"
)

// ScheduleListWatcher notifies subscribers when the schedule list changes.
//
// Every change the store makes reaches subscribers, the run bookkeeping
// included: the next firing, the latest run, a skipped firing and a failed run
// are what a schedule's row exists to show, and they move without anyone
// editing the schedule.
//
// So does a change to a schedule's latest run, whose row rides on the item
// (rpc.ScheduleListItem.LastRun): the run itself changing, and the turn of its
// session, which moves the run's activity without anything about the run
// changing — the same triggers ScheduleDetailWatcher follows for its run page.
// Only the latest run counts; any other run is on no row.
type ScheduleListWatcher struct {
	*BaseWatcher
	store      schedule.Store
	workStore  work.Store
	turnSource work.TurnSource
	eventCh    chan scheduleListEvent
	dirty      atomic.Bool

	// sentRunsMu guards sentRuns: the last_run row last sent for each schedule,
	// by schedule id. A session is touched at the end of every turn, marked
	// unread, credited with usage, and almost none of that moves a run's row —
	// so a session change is only sent on when the row differs from this.
	// Every subscriber is sent the same notifications, so one record serves
	// them all; Subscribe clears it, at the cost of at most one repeated row.
	sentRunsMu sync.Mutex
	sentRuns   map[string]*rpc.WorkListItem
}

// scheduleListEvent is a union of what alters the list: a schedule, a run of
// one, or the session some run may be running in. Exactly one field is set.
type scheduleListEvent struct {
	scheduleEvent *schedule.ChangeEvent
	run           *work.Work
	sessionID     string
}

// NewScheduleListWatcher builds the watcher. workStore is where each latest
// run is read from; turnSource is where its activity is derived from (nil reads
// every run as idle, which only a narrow test wants).
func NewScheduleListWatcher(store schedule.Store, workStore work.Store, turnSource work.TurnSource) *ScheduleListWatcher {
	w := &ScheduleListWatcher{
		BaseWatcher: NewBaseWatcher(),
		store:       store,
		workStore:   workStore,
		turnSource:  turnSource,
		eventCh:     make(chan scheduleListEvent, 64),
		sentRuns:    make(map[string]*rpc.WorkListItem),
	}
	store.AddOnChangeListener(w)
	workStore.AddOnChangeListener(w)
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
			switch {
			case w.dirty.Swap(false):
				w.notifySync()
			case event.scheduleEvent != nil:
				w.notifyChange(*event.scheduleEvent)
			case event.run != nil:
				w.notifyForRun(*event.run, false)
			default:
				w.notifyForSession(event.sessionID)
			}
		}
	}
}

func (w *ScheduleListWatcher) notifyChange(event schedule.ChangeEvent) {
	if !w.HasSubscriptions() {
		return
	}

	if event.Op == schedule.OperationDelete {
		w.forgetRun(event.Schedule.ID)
		w.notifyAll(scheduleListChangedParams{Operation: string(event.Op), ScheduleID: event.Schedule.ID})
		return
	}
	item, err := w.item(event.Schedule)
	if err != nil {
		slog.Error("failed to read a schedule's latest run", "scheduleId", event.Schedule.ID, "error", err)
		return
	}
	w.notifyItem(string(event.Op), item)
}

// notifyForRun re-sends the schedule run is the latest run of. fromSession says
// only the run's session changed, which is worth a notification only when it
// moved the row.
func (w *ScheduleListWatcher) notifyForRun(run work.Work, fromSession bool) {
	if !w.HasSubscriptions() {
		return
	}

	sched, found, err := w.store.Get(run.ScheduleID)
	if err != nil {
		slog.Error("failed to read schedule for a run change", "scheduleId", run.ScheduleID, "workId", run.ID, "error", err)
		return
	}
	if !found || sched.LastRunWorkID != run.ID {
		return // Not on any row: the schedule is gone, or this is an older run.
	}
	item, err := w.item(sched)
	if err != nil {
		slog.Error("failed to read a schedule's latest run", "scheduleId", sched.ID, "error", err)
		return
	}
	if fromSession && w.runAlreadySent(sched.ID, item.LastRun) {
		return
	}
	w.notifyItem(string(schedule.OperationUpdate), item)
}

func (w *ScheduleListWatcher) notifyForSession(sessionID string) {
	if sessionID == "" || !w.HasSubscriptions() {
		return
	}

	run, found, err := w.workStore.FindBySessionID(sessionID)
	if err != nil {
		slog.Error("failed to find work for a session change", "sessionId", sessionID, "error", err)
		return
	}
	if !found || run.ScheduleID == "" {
		return // A plain chat, or a story or task: not a run.
	}
	w.notifyForRun(run, true)
}

func (w *ScheduleListWatcher) notifyItem(op string, item rpc.ScheduleListItem) {
	w.rememberRun(item.ID, item.LastRun)
	w.notifyAll(scheduleListChangedParams{Operation: op, Schedule: &item})
	slog.Debug("notified schedule list change", "operation", op)
}

func (w *ScheduleListWatcher) notifyAll(params scheduleListChangedParams) {
	w.NotifyAll("schedule.list.changed", func(sub *Subscription) any {
		params.ID = sub.ID
		return params
	})
}

func (w *ScheduleListWatcher) notifySync() {
	if !w.HasSubscriptions() {
		return
	}

	items, err := w.items()
	if err != nil {
		slog.Error("failed to list schedules for sync", "error", err)
		return
	}
	for _, item := range items {
		w.rememberRun(item.ID, item.LastRun)
	}
	zone := w.store.Zone()

	w.NotifyAll("schedule.list.changed", func(sub *Subscription) any {
		return scheduleListSyncParams{
			ID:         sub.ID,
			Operation:  "sync",
			Schedules:  items,
			ServerZone: zone,
		}
	})

	slog.Info("sent full schedule sync to subscribers after event drop")
}

// items reads every schedule as its row draws it.
func (w *ScheduleListWatcher) items() ([]rpc.ScheduleListItem, error) {
	schedules, err := w.store.List()
	if err != nil {
		return nil, err
	}
	items := make([]rpc.ScheduleListItem, 0, len(schedules))
	for _, sched := range schedules {
		item, err := w.item(sched)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, nil
}

func (w *ScheduleListWatcher) item(sched schedule.Schedule) (rpc.ScheduleListItem, error) {
	item := rpc.ScheduleListItem{Schedule: sched}
	if sched.LastRunWorkID == "" {
		return item, nil
	}
	run, found, err := w.workStore.Get(sched.LastRunWorkID)
	if err != nil {
		return rpc.ScheduleListItem{}, err
	}
	if found {
		row := rpc.NewWorkListItem(run, work.NewActivityResolver(w.turnSource).RowState(run))
		item.LastRun = &row
	}
	return item, nil
}

func (w *ScheduleListWatcher) runAlreadySent(scheduleID string, row *rpc.WorkListItem) bool {
	w.sentRunsMu.Lock()
	defer w.sentRunsMu.Unlock()
	sent, found := w.sentRuns[scheduleID]
	if !found {
		return false
	}
	if sent == nil || row == nil {
		return sent == row
	}
	return *sent == *row
}

func (w *ScheduleListWatcher) rememberRun(scheduleID string, row *rpc.WorkListItem) {
	w.sentRunsMu.Lock()
	defer w.sentRunsMu.Unlock()
	w.sentRuns[scheduleID] = row
}

func (w *ScheduleListWatcher) forgetRun(scheduleID string) {
	w.sentRunsMu.Lock()
	defer w.sentRunsMu.Unlock()
	delete(w.sentRuns, scheduleID)
}

// ScheduleList is everything a schedule.list subscriber is sent on subscribe.
type ScheduleList struct {
	Items      []rpc.ScheduleListItem
	ServerZone schedule.Zone
}

// Subscribe registers a subscriber under the client-chosen id and returns the
// current schedule list.
//
// Registered before the list is read, so a change landing between the two is
// notified rather than lost; see BaseWatcher.AddSubscription.
func (w *ScheduleListWatcher) Subscribe(id string, notifier Notifier) (ScheduleList, error) {
	sub := &Subscription{
		ID:       id,
		Notifier: notifier,
	}
	if err := w.AddSubscription(sub); err != nil {
		return ScheduleList{}, err
	}

	items, err := w.items()
	if err != nil {
		w.RemoveSubscription(id)
		return ScheduleList{}, err
	}
	// The loop may have sent the others a row this reply is newer or older
	// than; forgetting what was sent makes the next session change go out
	// either way, rather than be suppressed against a row this subscriber was
	// never sent.
	w.sentRunsMu.Lock()
	clear(w.sentRuns)
	w.sentRunsMu.Unlock()
	return ScheduleList{Items: items, ServerZone: w.store.Zone()}, nil
}

type scheduleListChangedParams struct {
	ID         string                `json:"id"`
	Operation  string                `json:"operation"`
	Schedule   *rpc.ScheduleListItem `json:"schedule,omitempty"`
	ScheduleID string                `json:"scheduleId,omitempty"`
}

type scheduleListSyncParams struct {
	ID         string                 `json:"id"`
	Operation  string                 `json:"operation"`
	Schedules  []rpc.ScheduleListItem `json:"schedules"`
	ServerZone schedule.Zone          `json:"server_zone"`
}

// OnScheduleChange implements schedule.OnChangeListener.
func (w *ScheduleListWatcher) OnScheduleChange(event schedule.ChangeEvent) {
	w.sendEvent(scheduleListEvent{scheduleEvent: &event})
}

// OnWorkChange implements work.OnChangeListener: a run was made, moved or
// deleted. Every other work is on no schedule's row.
func (w *ScheduleListWatcher) OnWorkChange(event work.ChangeEvent) {
	if event.Work.ScheduleID == "" {
		return
	}
	run := event.Work
	w.sendEvent(scheduleListEvent{run: &run})
}

// OnSessionChange implements session.OnChangeListener. Queued rather than
// handled here: the session store holds its lock across this call, and
// deriving a run's activity reads session state.
func (w *ScheduleListWatcher) OnSessionChange(event session.SessionChangeEvent) {
	w.sendEvent(scheduleListEvent{sessionID: event.Session.ID})
}

func (w *ScheduleListWatcher) sendEvent(event scheduleListEvent) {
	select {
	case <-w.Context().Done():
		return
	case w.eventCh <- event:
	default:
		w.dirty.Store(true)
		slog.Warn("schedule list change event dropped, will sync on next event")
	}
}
