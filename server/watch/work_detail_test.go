package watch

import (
	"encoding/json"
	"testing"

	"github.com/pockode/server/work"
)

type mockDetailStore struct {
	work.Store
	works            []work.Work
	comments         []work.Comment
	changeListener   work.OnChangeListener
	commentListener  work.OnCommentChangeListener
}

func (m *mockDetailStore) Get(id string) (work.Work, bool, error) {
	for _, w := range m.works {
		if w.ID == id {
			return w, true, nil
		}
	}
	return work.Work{}, false, nil
}

func (m *mockDetailStore) ListComments(workID string) ([]work.Comment, error) {
	var result []work.Comment
	for _, c := range m.comments {
		if c.WorkID == workID {
			result = append(result, c)
		}
	}
	if result == nil {
		result = []work.Comment{}
	}
	return result, nil
}

func (m *mockDetailStore) AddOnChangeListener(l work.OnChangeListener) {
	m.changeListener = l
}

func (m *mockDetailStore) AddOnCommentChangeListener(l work.OnCommentChangeListener) {
	m.commentListener = l
}

func TestWorkDetailWatcher_Subscribe(t *testing.T) {
	store := &mockDetailStore{
		works: []work.Work{
			{ID: "w1", Title: "task 1"},
		},
		comments: []work.Comment{
			{ID: "c1", WorkID: "w1", Body: "hello"},
			{ID: "c2", WorkID: "w1", Body: "world"},
			{ID: "c3", WorkID: "w2", Body: "other"},
		},
	}
	w := NewWorkDetailWatcher(store)

	id, item, comments, err := w.Subscribe("w1", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if id == "" {
		t.Error("expected non-empty subscription ID")
	}
	if item.ID != "w1" {
		t.Errorf("work ID = %q, want %q", item.ID, "w1")
	}
	if len(comments) != 2 {
		t.Errorf("expected 2 comments for w1, got %d", len(comments))
	}
	if !w.HasSubscriptions() {
		t.Error("expected HasSubscriptions to be true")
	}
}

func TestWorkDetailWatcher_SubscribeNotFound(t *testing.T) {
	store := &mockDetailStore{}
	w := NewWorkDetailWatcher(store)

	_, _, _, err := w.Subscribe("nonexistent", nil)
	if err == nil {
		t.Fatal("expected error for nonexistent work")
	}
}

func TestWorkDetailWatcher_Unsubscribe(t *testing.T) {
	store := &mockDetailStore{
		works: []work.Work{{ID: "w1"}},
	}
	w := NewWorkDetailWatcher(store)

	id, _, _, _ := w.Subscribe("w1", nil)
	w.Unsubscribe(id)

	if w.HasSubscriptions() {
		t.Error("expected HasSubscriptions to be false")
	}
}

func TestWorkDetailWatcher_NotifyOnCommentChange(t *testing.T) {
	store := &mockDetailStore{
		works: []work.Work{{ID: "w1", Title: "task 1"}},
	}
	w := NewWorkDetailWatcher(store)
	w.Start()
	defer w.Stop()

	notifier := &captureNotifier{}
	w.Subscribe("w1", notifier)

	// Add the comment so store reflects it
	store.comments = append(store.comments, work.Comment{ID: "c1", WorkID: "w1", Body: "new comment"})

	w.OnCommentChange(work.CommentEvent{
		Comment: work.Comment{ID: "c1", WorkID: "w1", Body: "new comment"},
	})

	waitFor(t, func() bool { return notifier.count() >= 1 })

	if notifier.methods[0] != "work.detail.changed" {
		t.Errorf("method = %q, want %q", notifier.methods[0], "work.detail.changed")
	}

	var params workDetailChangedParams
	json.Unmarshal(notifier.last(), &params)
	if params.Work.ID != "w1" {
		t.Errorf("work ID = %q, want %q", params.Work.ID, "w1")
	}
	if len(params.Comments) != 1 {
		t.Errorf("expected 1 comment, got %d", len(params.Comments))
	}
}

func TestWorkDetailWatcher_NotifyOnWorkChange(t *testing.T) {
	store := &mockDetailStore{
		works: []work.Work{{ID: "w1", Title: "task 1"}},
	}
	w := NewWorkDetailWatcher(store)
	w.Start()
	defer w.Stop()

	notifier := &captureNotifier{}
	w.Subscribe("w1", notifier)

	// Update the work in the mock store
	store.works[0].Title = "updated"

	w.OnWorkChange(work.ChangeEvent{
		Op:   work.OperationUpdate,
		Work: store.works[0],
	})

	waitFor(t, func() bool { return notifier.count() >= 1 })

	if notifier.methods[0] != "work.detail.changed" {
		t.Errorf("method = %q, want %q", notifier.methods[0], "work.detail.changed")
	}

	var params workDetailChangedParams
	json.Unmarshal(notifier.last(), &params)
	if params.Work.Title != "updated" {
		t.Errorf("work title = %q, want %q", params.Work.Title, "updated")
	}
}

func TestWorkDetailWatcher_NotifyFilteredByWorkID(t *testing.T) {
	store := &mockDetailStore{
		works: []work.Work{
			{ID: "w1", Title: "task 1"},
			{ID: "w2", Title: "task 2"},
		},
	}
	w := NewWorkDetailWatcher(store)
	w.Start()
	defer w.Stop()

	n1 := &captureNotifier{}
	n2 := &captureNotifier{}
	w.Subscribe("w1", n1)
	w.Subscribe("w2", n2)

	w.OnCommentChange(work.CommentEvent{
		Comment: work.Comment{ID: "c1", WorkID: "w1", Body: "for w1"},
	})

	waitFor(t, func() bool { return n1.count() >= 1 })

	if n1.count() != 1 {
		t.Errorf("n1 should have 1 notification, got %d", n1.count())
	}
	if n2.count() != 0 {
		t.Errorf("n2 should have 0 notifications, got %d", n2.count())
	}
}

func TestWorkDetailWatcher_DirtyFlag_SyncsAll(t *testing.T) {
	store := &mockDetailStore{
		works: []work.Work{
			{ID: "w1", Title: "task 1"},
			{ID: "w2", Title: "task 2"},
		},
		comments: []work.Comment{
			{ID: "c1", WorkID: "w1", Body: "hello"},
			{ID: "c2", WorkID: "w2", Body: "world"},
		},
	}
	w := &WorkDetailWatcher{
		BaseWatcher: NewBaseWatcher("wd"),
		store:       store,
		eventCh:     make(chan detailEvent, 1),
	}
	store.AddOnChangeListener(w)
	store.AddOnCommentChangeListener(w)

	n1 := &captureNotifier{}
	n2 := &captureNotifier{}
	w.Subscribe("w1", n1)
	w.Subscribe("w2", n2)

	// Simulate the dirty flag being set (as if events were dropped)
	w.dirty.Store(true)

	w.Start()
	defer w.Stop()

	// Send a single event — eventLoop sees dirty=true and sends sync to ALL subscribers
	ce := work.CommentEvent{Comment: work.Comment{ID: "c3", WorkID: "w1"}}
	w.eventCh <- detailEvent{commentEvent: &ce}

	waitFor(t, func() bool { return n1.count() >= 1 && n2.count() >= 1 })

	var p1 workDetailChangedParams
	json.Unmarshal(n1.last(), &p1)
	if p1.Work.ID != "w1" {
		t.Errorf("n1 work ID = %q, want %q", p1.Work.ID, "w1")
	}
	if len(p1.Comments) != 1 {
		t.Errorf("n1 expected 1 comment in sync, got %d", len(p1.Comments))
	}

	var p2 workDetailChangedParams
	json.Unmarshal(n2.last(), &p2)
	if p2.Work.ID != "w2" {
		t.Errorf("n2 work ID = %q, want %q", p2.Work.ID, "w2")
	}
	if len(p2.Comments) != 1 {
		t.Errorf("n2 expected 1 comment in sync, got %d", len(p2.Comments))
	}

	if w.dirty.Load() {
		t.Error("dirty flag should be cleared after sync")
	}
}

func TestWorkDetailWatcher_OnCommentChange_AfterStop(t *testing.T) {
	store := &mockDetailStore{}
	w := NewWorkDetailWatcher(store)
	w.Start()
	w.Stop()

	// Should not block or panic
	w.OnCommentChange(work.CommentEvent{
		Comment: work.Comment{ID: "c1", WorkID: "w1"},
	})
}

func TestWorkDetailWatcher_OnWorkChange_AfterStop(t *testing.T) {
	store := &mockDetailStore{}
	w := NewWorkDetailWatcher(store)
	w.Start()
	w.Stop()

	// Should not block or panic
	w.OnWorkChange(work.ChangeEvent{
		Op:   work.OperationUpdate,
		Work: work.Work{ID: "w1"},
	})
}
