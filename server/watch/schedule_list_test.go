package watch

import (
	"encoding/json"
	"testing"

	"github.com/pockode/server/schedule"
	"github.com/pockode/server/session"
	"github.com/pockode/server/work"
)

// A schedule's row carries its latest run, and a session is touched far more
// often than that run's row moves. The schedule is re-sent for a session change
// only when the latest run's row differs — here, when its turn starts — and not
// for one that leaves it as it was, nor for an older run's session.
func TestScheduleListWatcher_ResendsOnlyWhenTheLatestRunMoved(t *testing.T) {
	schedules := &mockScheduleStore{schedules: []schedule.Schedule{{ID: "sched", LastRunWorkID: "latest"}}}
	runs := &mockRunStore{mockDetailStore{works: []work.Work{
		{ID: "older", ScheduleID: "sched", Status: work.StatusStopped, SessionID: "s0"},
		{ID: "latest", ScheduleID: "sched", Status: work.StatusActive, SessionID: "s1"},
		{ID: "story", Status: work.StatusActive, SessionID: "s2"},
	}}}
	turns := &turnSourceStub{}
	w := NewScheduleListWatcher(schedules, runs, turns)
	w.Start()
	defer w.Stop()

	notifier := &captureNotifier{}
	list, err := w.Subscribe("client-1", notifier)
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	if len(list.Items) != 1 || list.Items[0].LastRun == nil || list.Items[0].LastRun.ID != "latest" {
		t.Fatalf("items on subscribe = %+v, want the schedule with its latest run", list.Items)
	}
	if list.ServerZone.OffsetSeconds != 9*60*60 {
		t.Errorf("server_zone = %+v, want the store's", list.ServerZone)
	}

	// The first change of the latest run's session after a subscribe goes out:
	// the watcher cannot know what this subscriber's reply was built from.
	w.OnSessionChange(session.SessionChangeEvent{Op: session.OperationUpdate, Session: session.SessionMeta{ID: "s1"}})
	waitFor(t, func() bool { return notifier.count() >= 1 })

	// None of these moves the row: the same turn again, an older run, a story.
	w.OnSessionChange(session.SessionChangeEvent{Op: session.OperationUpdate, Session: session.SessionMeta{ID: "s1"}})
	w.OnSessionChange(session.SessionChangeEvent{Op: session.OperationUpdate, Session: session.SessionMeta{ID: "s0"}})
	w.OnSessionChange(session.SessionChangeEvent{Op: session.OperationUpdate, Session: session.SessionMeta{ID: "s2"}})

	turns.set("s1", session.TurnState{Phase: session.PhaseRunning, Open: true})
	w.OnSessionChange(session.SessionChangeEvent{Op: session.OperationUpdate, Session: session.SessionMeta{ID: "s1"}})

	waitFor(t, func() bool { return notifier.count() >= 2 })
	var params scheduleListChangedParams
	if err := json.Unmarshal(notifier.last(), &params); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if params.Schedule == nil || params.Schedule.LastRun == nil || params.Schedule.LastRun.Activity != work.ActivityRunning {
		t.Errorf("schedule = %+v, want its latest run running", params.Schedule)
	}
	// Events are handled in order, so the ones before it have been handled too.
	if got := notifier.count(); got != 2 {
		t.Errorf("notifications = %d, want only the first after subscribe and the turn starting", got)
	}
}

// A sync replaces the client's list whole, so it carries what the subscribe
// result does: each schedule with its latest run, and the zone.
func TestScheduleListWatcher_SyncCarriesLatestRunsAndZone(t *testing.T) {
	schedules := &mockScheduleStore{schedules: []schedule.Schedule{{ID: "sched", LastRunWorkID: "latest"}}}
	runs := &mockRunStore{mockDetailStore{works: []work.Work{
		{ID: "latest", ScheduleID: "sched", Status: work.StatusActive, SessionID: "s1"},
	}}}
	w := NewScheduleListWatcher(schedules, runs, nil)

	notifier := &captureNotifier{}
	if _, err := w.Subscribe("client-1", notifier); err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	w.notifySync()

	var params scheduleListSyncParams
	if err := json.Unmarshal(notifier.last(), &params); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if params.Operation != "sync" || len(params.Schedules) != 1 || params.Schedules[0].LastRun == nil || params.Schedules[0].LastRun.ID != "latest" {
		t.Errorf("sync = %+v, want the schedule with its latest run", params)
	}
	if params.ServerZone.OffsetSeconds != 9*60*60 {
		t.Errorf("server_zone = %+v, want the store's", params.ServerZone)
	}
}
