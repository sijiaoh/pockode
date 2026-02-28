package watch

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

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
	w := NewWorkListWatcher(store)

	id, items, err := w.Subscribe(nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if id == "" {
		t.Error("expected non-empty subscription ID")
	}
	if len(items) != 2 {
		t.Errorf("expected 2 items, got %d", len(items))
	}
	if !w.HasSubscriptions() {
		t.Error("expected HasSubscriptions to be true")
	}
}

func TestWorkListWatcher_Unsubscribe(t *testing.T) {
	store := &mockWorkStore{}
	w := NewWorkListWatcher(store)

	id, _, _ := w.Subscribe(nil)
	w.Unsubscribe(id)

	if w.HasSubscriptions() {
		t.Error("expected HasSubscriptions to be false")
	}
}

func TestWorkListWatcher_NotifyChange(t *testing.T) {
	store := &mockWorkStore{}
	w := NewWorkListWatcher(store)
	w.Start()
	defer w.Stop()

	notifier := &captureNotifier{}
	w.Subscribe(notifier)

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
	w := NewWorkListWatcher(store)
	w.Start()
	defer w.Stop()

	notifier := &captureNotifier{}
	w.Subscribe(notifier)

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
		BaseWatcher: NewBaseWatcher("wl"),
		store:       store,
		eventCh:     make(chan work.ChangeEvent, 1),
	}
	store.AddOnChangeListener(w)

	notifier := &captureNotifier{}
	w.Subscribe(notifier)

	// Simulate the dirty flag being set (as if events were dropped)
	w.dirty.Store(true)

	// Start eventLoop AFTER setting dirty so the next event triggers sync
	w.Start()
	defer w.Stop()

	// Send a single event — eventLoop sees dirty=true and sends sync instead
	w.eventCh <- work.ChangeEvent{Op: work.OperationUpdate, Work: work.Work{ID: "w1"}}

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
	w := NewWorkListWatcher(store)
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
