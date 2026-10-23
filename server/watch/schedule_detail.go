package watch

import (
	"errors"
	"log/slog"
	"slices"
	"sort"
	"sync/atomic"

	"github.com/pockode/server/rpc"
	"github.com/pockode/server/schedule"
	"github.com/pockode/server/session"
	"github.com/pockode/server/work"
)

// ScheduleDetailWatcher notifies subscribers when one schedule or any of its
// runs changes. Subscriptions are keyed by schedule id.
//
// A detail carries the schedule and the newest page of its runs, so it changes
// for three reasons: the schedule (its settings or its run bookkeeping), a run
// (made, started, closed, deleted), and the turn of a run's session, which moves
// the run's activity without anything about the run itself changing.
type ScheduleDetailWatcher struct {
	*BaseWatcher
	store      schedule.Store
	workStore  work.Store
	turnSource work.TurnSource
	eventCh    chan scheduleDetailEvent
	dirty      atomic.Bool

	// sentRuns is the run page last sent to each subscription. A session is
	// touched at the end of every turn, marked unread, credited with usage, and
	// almost none of that moves a run's row — so a session change is only sent
	// on when the page it would send differs from this.
	sentRuns *sentRecord[[]rpc.ScheduleRunItem]
}

// scheduleDetailEvent is a union of what alters a detail: the schedule or one
// of its runs (scheduleID), or the session some run may be running in
// (sessionID). Exactly one field is set per event.
type scheduleDetailEvent struct {
	scheduleID string
	sessionID  string
}

// ScheduleDetail is everything a schedule.detail subscriber is sent.
type ScheduleDetail struct {
	Schedule   schedule.Schedule
	Runs       rpc.ScheduleRunPage
	ServerZone schedule.Zone
}

// NewScheduleDetailWatcher builds the watcher. workStore is where the runs are
// read from; turnSource is where their activity is derived from (nil reads
// every run as idle, which only a narrow test wants).
func NewScheduleDetailWatcher(store schedule.Store, workStore work.Store, turnSource work.TurnSource) *ScheduleDetailWatcher {
	base := NewBaseWatcher()
	w := &ScheduleDetailWatcher{
		BaseWatcher: base,
		store:       store,
		workStore:   workStore,
		turnSource:  turnSource,
		eventCh:     make(chan scheduleDetailEvent, 64),
		sentRuns:    newSentRecord[[]rpc.ScheduleRunItem](base),
	}
	store.AddOnChangeListener(w)
	workStore.AddOnChangeListener(w)
	return w
}

func (w *ScheduleDetailWatcher) Start() error {
	w.Go(w.eventLoop)
	slog.Info("ScheduleDetailWatcher started")
	return nil
}

func (w *ScheduleDetailWatcher) Stop() {
	w.CancelAndWait()
	slog.Info("ScheduleDetailWatcher stopped")
}

func (w *ScheduleDetailWatcher) eventLoop() {
	for {
		select {
		case <-w.Context().Done():
			return
		case event := <-w.eventCh:
			if w.dirty.Swap(false) {
				w.notifySyncAll()
			} else if event.scheduleID != "" {
				w.notifyForSchedule(event.scheduleID, false)
			} else {
				w.notifyForSession(event.sessionID)
			}
		}
	}
}

// notifyForSchedule sends the current detail to the subscribers of scheduleID.
// fromSession says only a run's session changed, which is worth a notification
// only when it moved the run page.
func (w *ScheduleDetailWatcher) notifyForSchedule(scheduleID string, fromSession bool) {
	if !w.HasSubscriptionForKey(scheduleID) {
		return
	}

	detail, ok := w.buildDetail(scheduleID)
	if !ok {
		return
	}

	for _, sub := range w.GetAllSubscriptions() {
		if sub.Key != scheduleID {
			continue
		}
		if fromSession && w.runsAlreadySent(sub.ID, detail.Runs.Items) {
			continue
		}
		w.notifyDetail(sub, detail)
	}
}

func (w *ScheduleDetailWatcher) notifyForSession(sessionID string) {
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
	w.notifyForSchedule(run.ScheduleID, true)
}

// notifySyncAll sends the full detail to every subscriber, after dropped events
// left it unknown which schedules changed.
func (w *ScheduleDetailWatcher) notifySyncAll() {
	subs := w.GetAllSubscriptions()
	if len(subs) == 0 {
		return
	}

	cache := make(map[string]ScheduleDetail)
	for _, sub := range subs {
		detail, cached := cache[sub.Key]
		if !cached {
			var ok bool
			if detail, ok = w.buildDetail(sub.Key); !ok {
				continue
			}
			cache[sub.Key] = detail
		}
		w.notifyDetail(sub, detail)
	}

	slog.Info("sent full schedule detail sync to subscribers after event drop")
}

func (w *ScheduleDetailWatcher) notifyDetail(sub *Subscription, detail ScheduleDetail) {
	w.sentRuns.remember(sub.ID, detail.Runs.Items)
	n := Notification{Method: "schedule.detail.changed", Params: scheduleDetailChangedParams{
		ID:         sub.ID,
		Schedule:   detail.Schedule,
		Runs:       detail.Runs,
		ServerZone: detail.ServerZone,
	}}
	if err := sub.Notifier.Notify(w.Context(), n); err != nil {
		slog.Debug("failed to notify schedule detail subscriber", "id", sub.ID, "error", err)
	}
}

// buildDetail reads a schedule's current detail, or reports that there is none
// to send: the schedule was deleted between the event and this read. A deleted
// schedule is announced on schedule.list, as a deleted work is on work.list.
func (w *ScheduleDetailWatcher) buildDetail(scheduleID string) (ScheduleDetail, bool) {
	detail, err := w.readDetail(scheduleID)
	if err != nil {
		if !errors.Is(err, schedule.ErrNotFound) {
			slog.Error("failed to read schedule detail", "scheduleId", scheduleID, "error", err)
		}
		return ScheduleDetail{}, false
	}
	return detail, true
}

func (w *ScheduleDetailWatcher) readDetail(scheduleID string) (ScheduleDetail, error) {
	sched, found, err := w.store.Get(scheduleID)
	if err != nil {
		return ScheduleDetail{}, err
	}
	if !found {
		return ScheduleDetail{}, schedule.ErrNotFound
	}
	runs, err := w.runPage(scheduleID, "", 0)
	if err != nil {
		return ScheduleDetail{}, err
	}
	return ScheduleDetail{Schedule: sched, Runs: runs, ServerZone: w.store.Zone()}, nil
}

// runPage reads one page of a schedule's runs, newest made first.
//
// The runs are paged before any row is built: a schedule that fires every
// minute has thousands of runs, and only a page of them is sent.
func (w *ScheduleDetailWatcher) runPage(scheduleID, cursor string, limit int) (rpc.ScheduleRunPage, error) {
	runs, err := w.workStore.ListBySchedule(scheduleID)
	if err != nil {
		return rpc.ScheduleRunPage{}, err
	}
	sort.Slice(runs, session.ListOrder(runs, runCursor))

	page, next, hasMore, err := session.PageList(runs, runCursor, cursor, limit)
	if err != nil {
		return rpc.ScheduleRunPage{}, err
	}

	resolver := work.NewActivityResolver(w.turnSource)
	items := make([]rpc.ScheduleRunItem, 0, len(page))
	for _, run := range page {
		items = append(items, rpc.NewScheduleRunItem(run, resolver.RowState(run)))
	}
	result := rpc.ScheduleRunPage{Items: items, HasMore: hasMore}
	if hasMore {
		result.NextCursor = next.String()
	}
	return result, nil
}

// runCursor is a run's position in its schedule's run list: when it was made.
// Not its last change, which is what a work list orders by — a run list paged
// by that would reorder under the pager every time a run moved.
func runCursor(run work.Work) session.ListCursor {
	return session.ListCursor{UpdatedAt: run.CreatedAt, ID: run.ID}
}

func (w *ScheduleDetailWatcher) runsAlreadySent(subID string, runs []rpc.ScheduleRunItem) bool {
	sent, found := w.sentRuns.get(subID)
	return found && slices.Equal(sent, runs)
}

// Subscribe registers a subscriber for one schedule's detail, under the
// client-chosen id.
//
// Registered before the store read, so a change landing between the two is
// notified rather than lost; see BaseWatcher.AddSubscription.
func (w *ScheduleDetailWatcher) Subscribe(id, scheduleID string, notifier Notifier) (ScheduleDetail, error) {
	sub := &Subscription{
		ID:       id,
		Key:      scheduleID,
		Notifier: notifier,
	}
	if err := w.AddSubscription(sub); err != nil {
		return ScheduleDetail{}, err
	}

	detail, err := w.readDetail(scheduleID)
	if err != nil {
		// Unsubscribe, not RemoveSubscription: the loop may have sent this
		// subscription something already, and recorded it.
		w.Unsubscribe(id)
		return ScheduleDetail{}, err
	}
	// The reply carries the page, so a session change that leaves it as it is
	// is not news to this subscriber.
	w.sentRuns.rememberReply(id, detail.Runs.Items)
	return detail, nil
}

// Runs reads a page of the runs of the schedule subscription id follows. An id
// this watcher does not hold is ErrSubscriptionNotFound, which tells the client
// to subscribe afresh rather than retry.
func (w *ScheduleDetailWatcher) Runs(id, cursor string, limit int) (rpc.ScheduleRunPage, error) {
	sub := w.GetSubscription(id)
	if sub == nil {
		return rpc.ScheduleRunPage{}, ErrSubscriptionNotFound
	}
	return w.runPage(sub.Key, cursor, limit)
}

// Unsubscribe also forgets what that subscription was sent.
func (w *ScheduleDetailWatcher) Unsubscribe(id string) {
	w.RemoveSubscription(id)
	w.sentRuns.forget(id)
}

// scheduleDetailChangedParams is the whole detail every time, so it carries the
// zone as the subscribe result does.
type scheduleDetailChangedParams struct {
	ID         string              `json:"id"`
	Schedule   schedule.Schedule   `json:"schedule"`
	Runs       rpc.ScheduleRunPage `json:"runs"`
	ServerZone schedule.Zone       `json:"server_zone"`
}

// OnScheduleChange implements schedule.OnChangeListener.
func (w *ScheduleDetailWatcher) OnScheduleChange(event schedule.ChangeEvent) {
	w.sendEvent(scheduleDetailEvent{scheduleID: event.Schedule.ID})
}

// OnWorkChange implements work.OnChangeListener: a run was made, moved or
// deleted. Every other work is no schedule's.
func (w *ScheduleDetailWatcher) OnWorkChange(event work.ChangeEvent) {
	if event.Work.ScheduleID == "" {
		return
	}
	w.sendEvent(scheduleDetailEvent{scheduleID: event.Work.ScheduleID})
}

// OnSessionChange implements session.OnChangeListener. Queued rather than
// handled here: the session store holds its lock across this call, and
// deriving a run's activity reads session state.
func (w *ScheduleDetailWatcher) OnSessionChange(event session.SessionChangeEvent) {
	w.sendEvent(scheduleDetailEvent{sessionID: event.Session.ID})
}

func (w *ScheduleDetailWatcher) sendEvent(event scheduleDetailEvent) {
	select {
	case <-w.Context().Done():
		return
	case w.eventCh <- event:
	default:
		w.dirty.Store(true)
		slog.Warn("schedule detail event dropped, will sync on next event")
	}
}
