package watch

import (
	"encoding/json"
	"testing"

	"github.com/pockode/server/schedule"
	"github.com/pockode/server/session"
	"github.com/pockode/server/work"
)

type mockScheduleStore struct {
	schedule.Store
	schedules []schedule.Schedule
}

func (m *mockScheduleStore) Get(id string) (schedule.Schedule, bool, error) {
	for _, s := range m.schedules {
		if s.ID == id {
			return s, true, nil
		}
	}
	return schedule.Schedule{}, false, nil
}

func (m *mockScheduleStore) List() ([]schedule.Schedule, error) {
	return m.schedules, nil
}

func (m *mockScheduleStore) AddOnChangeListener(schedule.OnChangeListener) {}

type mockRunStore struct {
	mockDetailStore
}

func (m *mockRunStore) ListBySchedule(scheduleID string) ([]work.Work, error) {
	var runs []work.Work
	for _, w := range m.works {
		if w.ScheduleID == scheduleID {
			runs = append(runs, w)
		}
	}
	return runs, nil
}

// A session is touched far more often than a run's row moves. The detail is
// re-sent for a session change only when the run page it carries differs —
// here, when the run's turn starts — and not for one that leaves it as it was.
func TestScheduleDetailWatcher_ResendsOnlyWhenARunMoved(t *testing.T) {
	schedules := &mockScheduleStore{schedules: []schedule.Schedule{{ID: "sched"}}}
	runs := &mockRunStore{mockDetailStore{works: []work.Work{
		{ID: "run", ScheduleID: "sched", Status: work.StatusActive, SessionID: "s1"},
		{ID: "story", Status: work.StatusActive, SessionID: "s2"},
	}}}
	turns := &turnSourceStub{}
	w := NewScheduleDetailWatcher(schedules, runs, turns)
	w.Start()
	defer w.Stop()

	notifier := &captureNotifier{}
	detail, err := w.Subscribe("client-1", "sched", notifier)
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	if len(detail.Runs.Items) != 1 || detail.Runs.Items[0].Activity != work.ActivityIdle {
		t.Fatalf("runs on subscribe = %+v, want the one idle run", detail.Runs.Items)
	}

	// Neither moves the page: the run's turn is as it was, and s2 is a story's.
	w.OnSessionChange(session.SessionChangeEvent{Op: session.OperationUpdate, Session: session.SessionMeta{ID: "s1"}})
	w.OnSessionChange(session.SessionChangeEvent{Op: session.OperationUpdate, Session: session.SessionMeta{ID: "s2"}})

	turns.set("s1", session.TurnState{Phase: session.PhaseRunning, Open: true})
	w.OnSessionChange(session.SessionChangeEvent{Op: session.OperationUpdate, Session: session.SessionMeta{ID: "s1"}})

	waitFor(t, func() bool { return notifier.count() >= 1 })
	var params scheduleDetailChangedParams
	if err := json.Unmarshal(notifier.last(), &params); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if params.Runs.Items[0].Activity != work.ActivityRunning {
		t.Errorf("run activity = %q, want running", params.Runs.Items[0].Activity)
	}
	// Events are handled in order, so the two before it have been handled too.
	if got := notifier.count(); got != 1 {
		t.Errorf("notifications = %d, want only the one for the turn starting", got)
	}
}
