package watch

import (
	"bytes"
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/pockode/server/session"
	"github.com/pockode/server/work"
)

type captureNotifier struct {
	mu      sync.Mutex
	params  []json.RawMessage
	methods []string
}

func (n *captureNotifier) Notify(_ context.Context, notif Notification) error {
	data, _ := json.Marshal(notif.Params)
	n.mu.Lock()
	defer n.mu.Unlock()
	n.params = append(n.params, data)
	n.methods = append(n.methods, notif.Method)
	return nil
}

func (n *captureNotifier) count() int {
	n.mu.Lock()
	defer n.mu.Unlock()
	return len(n.params)
}

func (n *captureNotifier) last() json.RawMessage {
	n.mu.Lock()
	defer n.mu.Unlock()
	if len(n.params) == 0 {
		return nil
	}
	return n.params[len(n.params)-1]
}

func (n *captureNotifier) all() []json.RawMessage {
	n.mu.Lock()
	defer n.mu.Unlock()
	out := make([]json.RawMessage, len(n.params))
	copy(out, n.params)
	return out
}

type mockWorkStore struct {
	mu    sync.Mutex
	works []work.Work
	work.Store
	listener work.OnChangeListener
}

func (m *mockWorkStore) List() ([]work.Work, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]work.Work, len(m.works))
	copy(out, m.works)
	return out, nil
}

func (m *mockWorkStore) AddOnChangeListener(l work.OnChangeListener) {
	m.listener = l
}

func TestWorkListWatcher_Subscribe(t *testing.T) {
	store := &mockWorkStore{
		works: []work.Work{
			{ID: "w1", Title: "Work 1"},
			{ID: "w2", Title: "Work 2"},
		},
	}
	w := NewWorkListWatcher(store, nil)

	snapshot, err := w.Subscribe("client-1", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	items := snapshot.Items
	if len(items) != 2 {
		t.Errorf("expected 2 items, got %d", len(items))
	}
	if !w.HasSubscriptions() {
		t.Error("expected HasSubscriptions to be true")
	}
}

// A client with no work items must be sent `[]`, which it can iterate, and not
// `null`, which it cannot. The guarantee used to live on rpc.NewWorkListItems;
// that function is gone, and the one place left that builds a whole list is
// here.
func TestWorkListWatcher_SubscribeToAnEmptyStoreSendsAnEmptyList(t *testing.T) {
	w := NewWorkListWatcher(&mockWorkStore{}, nil)

	snapshot, err := w.Subscribe("client-1", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	items := snapshot.Items

	// Asserted on the wire shape rather than on `items != nil`: the wire is what
	// the contract is about, and a nil slice is only wrong once it is marshalled.
	encoded, err := json.Marshal(workListSyncParams{Works: items})
	if err != nil {
		t.Fatalf("marshal items: %v", err)
	}
	if !bytes.Contains(encoded, []byte(`"works":[]`)) {
		t.Errorf("empty work list marshalled as %s, want an empty array", encoded)
	}
}

func TestWorkListWatcher_Unsubscribe(t *testing.T) {
	store := &mockWorkStore{}
	w := NewWorkListWatcher(store, nil)

	w.Subscribe("client-1", nil)
	w.Unsubscribe("client-1")

	if w.HasSubscriptions() {
		t.Error("expected HasSubscriptions to be false")
	}
}

func TestWorkListWatcher_NotifyChange(t *testing.T) {
	store := &mockWorkStore{}
	w := NewWorkListWatcher(store, nil)
	w.Start()
	defer w.Stop()

	notifier := &captureNotifier{}
	w.Subscribe("client-1", notifier)

	// Fire a create event
	w.OnWorkChange(work.ChangeEvent{
		Op:   work.OperationCreate,
		Work: work.Work{ID: "w1", Title: "New"},
	})

	waitFor(t, func() bool { return notifier.count() >= 1 })

	var params workListChangedParams
	json.Unmarshal(notifier.last(), &params)
	if params.Operation != "create" {
		t.Errorf("operation = %q, want %q", params.Operation, "create")
	}
	if params.Work == nil || params.Work.ID != "w1" {
		t.Errorf("expected work with ID w1")
	}
}

func TestWorkListWatcher_NotifyDelete(t *testing.T) {
	store := &mockWorkStore{}
	w := NewWorkListWatcher(store, nil)
	w.Start()
	defer w.Stop()

	notifier := &captureNotifier{}
	w.Subscribe("client-1", notifier)

	w.OnWorkChange(work.ChangeEvent{
		Op:   work.OperationDelete,
		Work: work.Work{ID: "w1"},
	})

	waitFor(t, func() bool { return notifier.count() >= 1 })

	var params workListChangedParams
	json.Unmarshal(notifier.last(), &params)
	if params.Operation != "delete" {
		t.Errorf("operation = %q, want %q", params.Operation, "delete")
	}
	if params.WorkID != "w1" {
		t.Errorf("workId = %q, want %q", params.WorkID, "w1")
	}
}

func TestWorkListWatcher_DirtyFlag_SyncsAfterDrop(t *testing.T) {
	store := &mockWorkStore{
		works: []work.Work{
			{ID: "w1", Title: "Work 1"},
			{ID: "w2", Title: "Work 2"},
		},
	}
	w := &WorkListWatcher{
		BaseWatcher:  NewBaseWatcher(),
		store:        store,
		eventCh:      make(chan listEvent, 1),
		sentActivity: make(map[string]work.RowState),
	}
	store.AddOnChangeListener(w)

	notifier := &captureNotifier{}
	w.Subscribe("client-1", notifier)

	// Simulate the dirty flag being set (as if events were dropped)
	w.dirty.Store(true)

	// Start eventLoop AFTER setting dirty so the next event triggers sync
	w.Start()
	defer w.Stop()

	// Send a single event — eventLoop sees dirty=true and sends sync instead
	w.eventCh <- listEvent{workEvent: &work.ChangeEvent{Op: work.OperationUpdate, Work: work.Work{ID: "w1"}}}

	waitFor(t, func() bool { return notifier.count() >= 1 })

	// The notification should be a "sync" with the full list
	raw := notifier.last()
	var params workListSyncParams
	if err := json.Unmarshal(raw, &params); err != nil {
		t.Fatalf("unmarshal sync params: %v", err)
	}
	if params.Operation != "sync" {
		t.Errorf("operation = %q, want %q", params.Operation, "sync")
	}
	if len(params.Works) != 2 {
		t.Errorf("expected 2 works in sync, got %d", len(params.Works))
	}

	// dirty flag should be cleared
	if w.dirty.Load() {
		t.Error("dirty flag should be cleared after sync")
	}
}

func TestWorkListWatcher_OnWorkChange_AfterStop(t *testing.T) {
	store := &mockWorkStore{}
	w := NewWorkListWatcher(store, nil)
	w.Start()
	w.Stop()

	// Should not block or panic
	w.OnWorkChange(work.ChangeEvent{
		Op:   work.OperationCreate,
		Work: work.Work{ID: "w1"},
	})
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("timed out waiting for condition")
}

// Both shapes the list watcher sends — the incremental row and the full sync —
// go through rpc.NewWorkListItem, so a body typed into a work item is not
// broadcast to every subscriber. Asserted on the wire bytes rather than on the
// params struct: what matters is what a client is sent.
func TestWorkListWatcher_NotificationsCarryNoBody(t *testing.T) {
	const body = "the work item's instructions"
	item := work.Work{ID: "w1", Title: "Work 1", Body: body}
	store := &mockWorkStore{works: []work.Work{item}}
	w := NewWorkListWatcher(store, nil)
	w.Start()
	defer w.Stop()

	notifier := &captureNotifier{}
	w.Subscribe("client-1", notifier)

	w.OnWorkChange(work.ChangeEvent{Op: work.OperationUpdate, Work: item})
	waitFor(t, func() bool { return notifier.count() >= 1 })
	assertNoBody(t, "update notification", notifier.last(), body)

	// A dropped event turns the next one into a full sync, which re-reads the
	// store rather than reusing the event's work item.
	w.dirty.Store(true)
	w.OnWorkChange(work.ChangeEvent{Op: work.OperationUpdate, Work: item})
	waitFor(t, func() bool { return notifier.count() >= 2 })
	var sync workListSyncParams
	if err := json.Unmarshal(notifier.last(), &sync); err != nil {
		t.Fatalf("unmarshal sync params: %v", err)
	}
	if sync.Operation != "sync" {
		t.Fatalf("operation = %q, want sync — the test never reached the sync path", sync.Operation)
	}
	assertNoBody(t, "sync notification", notifier.last(), body)
}

func assertNoBody(t *testing.T, what string, params json.RawMessage, body string) {
	t.Helper()
	if bytes.Contains(params, []byte(body)) {
		t.Errorf("%s carries the work body: %s", what, params)
	}
}

func (m *mockWorkStore) FindBySessionID(sessionID string) (work.Work, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, w := range m.works {
		if w.SessionID == sessionID {
			return w, true, nil
		}
	}
	return work.Work{}, false, nil
}

// A row's activity comes from the turn of the session the work runs in, and the
// work record does not change when that turn moves. Without this the list would
// draw a work as idle for the whole of a turn.
func TestWorkListWatcher_PushesARowWhenItsSessionsTurnMoves(t *testing.T) {
	store := &mockWorkStore{works: []work.Work{
		{ID: "w1", Title: "Work 1", Status: work.StatusActive, SessionID: "s1"},
	}}
	w := NewWorkListWatcher(store, nil)
	w.Start()
	defer w.Stop()

	notifier := &captureNotifier{}
	snapshot, err := w.Subscribe("client-1", notifier)
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	if snapshot.Items[0].Activity != work.ActivityIdle {
		t.Fatalf("activity on subscribe = %q, want idle", snapshot.Items[0].Activity)
	}

	w.OnSessionChange(session.SessionChangeEvent{
		Op: session.OperationUpdate,
		Session: session.SessionMeta{
			ID:   "s1",
			Turn: session.TurnState{Phase: session.PhaseRunning, Open: true},
		},
	})

	waitFor(t, func() bool { return notifier.count() >= 1 })
	var params workListChangedParams
	if err := json.Unmarshal(notifier.last(), &params); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if params.Work == nil || params.Work.Activity != work.ActivityRunning {
		t.Fatalf("pushed row = %+v, want activity running", params.Work)
	}
}

// A session is touched several times a turn without moving its activity — at the
// end of every turn, when it is marked unread, when usage is credited. A row
// pushed to every subscriber for each of those would be the most frequent
// notification in the app.
func TestWorkListWatcher_SaysNothingWhenTheActivityDidNotMove(t *testing.T) {
	store := &mockWorkStore{works: []work.Work{
		{ID: "w1", Title: "Work 1", Status: work.StatusActive, SessionID: "s1"},
	}}
	w := NewWorkListWatcher(store, nil)
	w.Start()
	defer w.Stop()

	notifier := &captureNotifier{}
	w.Subscribe("client-1", notifier)

	idle := session.SessionMeta{ID: "s1"}
	w.OnSessionChange(session.SessionChangeEvent{Op: session.OperationUpdate, Session: idle})
	// A second event that does move it, to prove the first one was processed and
	// dropped rather than merely slow.
	w.OnSessionChange(session.SessionChangeEvent{
		Op: session.OperationUpdate,
		Session: session.SessionMeta{
			ID:   "s1",
			Turn: session.TurnState{Phase: session.PhaseRunning, Open: true},
		},
	})

	waitFor(t, func() bool { return notifier.count() >= 1 })
	if got := notifier.count(); got != 1 {
		t.Errorf("sent %d notifications, want only the one that changed something", got)
	}
}

// A session belonging to no work at all — a plain chat — moves no row.
func TestWorkListWatcher_IgnoresASessionWithNoWork(t *testing.T) {
	store := &mockWorkStore{works: []work.Work{{ID: "w1", SessionID: "other"}}}
	w := NewWorkListWatcher(store, nil)
	w.Start()
	defer w.Stop()

	notifier := &captureNotifier{}
	w.Subscribe("client-1", notifier)

	w.OnSessionChange(session.SessionChangeEvent{
		Op:      session.OperationUpdate,
		Session: session.SessionMeta{ID: "s1", Turn: session.TurnState{Phase: session.PhaseRunning, Open: true}},
	})
	w.OnWorkChange(work.ChangeEvent{Op: work.OperationUpdate, Work: work.Work{ID: "w1"}})

	waitFor(t, func() bool { return notifier.count() >= 1 })
	if got := notifier.count(); got != 1 {
		t.Errorf("sent %d notifications, want only the work change", got)
	}
}
