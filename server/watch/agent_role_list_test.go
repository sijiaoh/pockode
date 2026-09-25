package watch

import (
	"encoding/json"
	"sync"
	"testing"

	"github.com/pockode/server/agentrole"
	"github.com/pockode/server/work"
)

type mockAgentRoleStore struct {
	agentrole.Store
	mu    sync.Mutex
	roles []agentrole.AgentRole
}

func (m *mockAgentRoleStore) List() ([]agentrole.AgentRole, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]agentrole.AgentRole, len(m.roles))
	copy(out, m.roles)
	return out, nil
}

func (m *mockAgentRoleStore) AddOnChangeListener(agentrole.OnChangeListener) {}

// replaceWorks stands in for whatever moved the work store: the watcher reads
// the counts back from the store, so a test only has to leave the store saying
// what it wants counted before it fires the event.
func (m *mockWorkStore) replaceWorks(works []work.Work) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.works = works
}

func refCountsOf(t *testing.T, raw json.RawMessage) (map[string]int, bool) {
	t.Helper()
	var params agentRoleRefCountsParams
	if err := json.Unmarshal(raw, &params); err != nil {
		t.Fatalf("unmarshal notification: %v", err)
	}
	if params.Operation != "ref_counts" {
		return nil, false
	}
	return params.WorkRefCounts, true
}

func lastRefCounts(t *testing.T, notifier *captureNotifier) map[string]int {
	t.Helper()
	all := notifier.all()
	for i := len(all) - 1; i >= 0; i-- {
		if counts, ok := refCountsOf(t, all[i]); ok {
			return counts
		}
	}
	return nil
}

func TestAgentRoleListWatcher_SubscribeReturnsRefCounts(t *testing.T) {
	roles := &mockAgentRoleStore{roles: []agentrole.AgentRole{{ID: "r1"}, {ID: "r2"}}}
	works := &mockWorkStore{works: []work.Work{
		{ID: "w1", AgentRoleID: "r1"},
		{ID: "w2", AgentRoleID: "r1"},
		{ID: "w3"}, // No role at all: counted for nobody.
	}}
	w := NewAgentRoleListWatcher(roles, works)

	items, counts, err := w.Subscribe("client-1", nil)
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	if len(items) != 2 {
		t.Errorf("items = %d, want 2", len(items))
	}
	if counts["r1"] != 2 {
		t.Errorf("counts[r1] = %d, want 2", counts["r1"])
	}
	if _, found := counts["r2"]; found {
		t.Errorf("r2 is referenced by nothing, want no entry, got %d", counts["r2"])
	}
}

// The count lives in the work store, so the only thing that can announce it is
// a work change — no role changed here, and the subscriber must still learn.
func TestAgentRoleListWatcher_WorkChangePushesRefCounts(t *testing.T) {
	roles := &mockAgentRoleStore{roles: []agentrole.AgentRole{{ID: "r1"}}}
	works := &mockWorkStore{}
	w := NewAgentRoleListWatcher(roles, works)
	w.Start()
	defer w.Stop()

	notifier := &captureNotifier{}
	if _, _, err := w.Subscribe("client-1", notifier); err != nil {
		t.Fatalf("subscribe: %v", err)
	}

	works.replaceWorks([]work.Work{{ID: "w1", AgentRoleID: "r1"}})
	w.OnWorkChange(work.ChangeEvent{Op: work.OperationCreate, Work: work.Work{ID: "w1", AgentRoleID: "r1"}})

	waitFor(t, func() bool { return notifier.count() >= 1 })

	counts := lastRefCounts(t, notifier)
	if counts["r1"] != 1 {
		t.Errorf("counts[r1] = %d, want 1", counts["r1"])
	}
}

// Every work change reaches this watcher — a turn ending, a title edited. Only
// the ones that move a count may reach the client.
func TestAgentRoleListWatcher_WorkChangeWithoutRefMoveIsSilent(t *testing.T) {
	roles := &mockAgentRoleStore{roles: []agentrole.AgentRole{{ID: "r1"}}}
	works := &mockWorkStore{works: []work.Work{{ID: "w1", AgentRoleID: "r1"}}}
	w := NewAgentRoleListWatcher(roles, works)
	w.Start()
	defer w.Stop()

	notifier := &captureNotifier{}
	if _, _, err := w.Subscribe("client-1", notifier); err != nil {
		t.Fatalf("subscribe: %v", err)
	}

	// One real change first, so that what the subscribers hold is on record —
	// until something has been pushed, every push is the first one and owed.
	works.replaceWorks([]work.Work{{ID: "w1", AgentRoleID: "r1"}, {ID: "w2", AgentRoleID: "r1"}})
	w.OnWorkChange(work.ChangeEvent{Op: work.OperationCreate, Work: work.Work{ID: "w2", AgentRoleID: "r1"}})
	waitFor(t, func() bool { return notifier.count() >= 1 })
	settled := notifier.count()

	// The title moved, the role did not.
	works.replaceWorks([]work.Work{{ID: "w1", Title: "renamed", AgentRoleID: "r1"}, {ID: "w2", AgentRoleID: "r1"}})
	w.OnWorkChange(work.ChangeEvent{Op: work.OperationUpdate, Work: work.Work{ID: "w1", AgentRoleID: "r1"}})

	// A count-moving change behind it proves the first one was skipped rather
	// than merely slow: both leave through the same loop, in order.
	works.replaceWorks(nil)
	w.OnWorkChange(work.ChangeEvent{Op: work.OperationDelete, Work: work.Work{ID: "w1", AgentRoleID: "r1"}})

	waitFor(t, func() bool { return notifier.count() > settled })

	if got := notifier.count(); got != settled+1 {
		t.Fatalf("notifications = %d, want 1 (the count-moving change only)", got-settled)
	}
	counts := lastRefCounts(t, notifier)
	if len(counts) != 0 {
		t.Errorf("counts = %v, want empty", counts)
	}
}

// The eventLoop now considers two notifications per event, and a role change
// must not grow a count push it does not need: no work moved, so the map that
// every subscriber already holds is still the answer.
//
// Two role events, because the first one after a subscribe legitimately pushes
// the counts — nothing has been pushed to anyone yet at that point.
func TestAgentRoleListWatcher_RoleChangeAloneDoesNotRepushCounts(t *testing.T) {
	roles := &mockAgentRoleStore{roles: []agentrole.AgentRole{{ID: "r1"}}}
	works := &mockWorkStore{works: []work.Work{{ID: "w1", AgentRoleID: "r1"}}}
	w := NewAgentRoleListWatcher(roles, works)
	w.Start()
	defer w.Stop()

	notifier := &captureNotifier{}
	if _, _, err := w.Subscribe("client-1", notifier); err != nil {
		t.Fatalf("subscribe: %v", err)
	}

	created := agentrole.AgentRole{ID: "r2", Name: "Reviewer"}
	roles.mu.Lock()
	roles.roles = append(roles.roles, created)
	roles.mu.Unlock()
	w.OnAgentRoleChange(agentrole.ChangeEvent{Op: agentrole.OperationCreate, Role: created})

	waitFor(t, func() bool { return notifier.count() >= 1 })
	settled := notifier.count()

	renamed := agentrole.AgentRole{ID: "r2", Name: "Reviewer II"}
	w.OnAgentRoleChange(agentrole.ChangeEvent{Op: agentrole.OperationUpdate, Role: renamed})
	renamedAgain := agentrole.AgentRole{ID: "r2", Name: "Reviewer III"}
	w.OnAgentRoleChange(agentrole.ChangeEvent{Op: agentrole.OperationUpdate, Role: renamedAgain})

	// Two updates rather than one and a pause: everything leaves through the
	// same loop in order, so a count push that should not exist would have to
	// land between them, and waiting for the second is waiting long enough.
	waitFor(t, func() bool { return notifier.count() >= settled+2 })

	all := notifier.all()
	if len(all) != settled+2 {
		t.Fatalf("notifications after the two updates = %d, want 2", len(all)-settled)
	}
	for i, want := range []string{"Reviewer II", "Reviewer III"} {
		var params agentRoleListChangedParams
		if err := json.Unmarshal(all[settled+i], &params); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if params.Operation != "update" || params.Role == nil || params.Role.Name != want {
			t.Errorf("notification %d = %+v, want the update to %q", i, params, want)
		}
	}
}

// A subscriber arriving mid-stream is told the counts in its reply, and that
// reply says nothing about what everyone else holds. If the arrival recorded
// its own read as pushed, an already-queued change would find its result
// "unchanged" and go to nobody — leaving every earlier subscriber on the count
// it had, with nothing left to correct it.
func TestAgentRoleListWatcher_LateSubscriberDoesNotSwallowAQueuedChange(t *testing.T) {
	roles := &mockAgentRoleStore{roles: []agentrole.AgentRole{{ID: "r1"}}}
	works := &mockWorkStore{}
	w := NewAgentRoleListWatcher(roles, works)

	first := &captureNotifier{}
	if _, _, err := w.Subscribe("client-1", first); err != nil {
		t.Fatalf("subscribe: %v", err)
	}

	// Queued while the loop is not running yet, which is what puts the arrival
	// below in between the change and its notification.
	works.replaceWorks([]work.Work{{ID: "w1", AgentRoleID: "r1"}})
	w.OnWorkChange(work.ChangeEvent{Op: work.OperationCreate, Work: work.Work{ID: "w1", AgentRoleID: "r1"}})

	second := &captureNotifier{}
	if _, counts, err := w.Subscribe("client-2", second); err != nil {
		t.Fatalf("subscribe: %v", err)
	} else if counts["r1"] != 1 {
		t.Fatalf("the arriving subscriber's own counts[r1] = %d, want 1", counts["r1"])
	}

	w.Start()
	defer w.Stop()

	waitFor(t, func() bool { return first.count() >= 1 })

	if counts := lastRefCounts(t, first); counts["r1"] != 1 {
		t.Errorf("the earlier subscriber was left at counts[r1] = %d, want 1", counts["r1"])
	}
}
