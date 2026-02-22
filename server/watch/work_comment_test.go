package watch

import (
	"encoding/json"
	"testing"

	"github.com/pockode/server/work"
)

type mockCommentStore struct {
	work.Store
	comments []work.Comment
	listener work.OnCommentChangeListener
}

func (m *mockCommentStore) ListComments(workID string) ([]work.Comment, error) {
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

func (m *mockCommentStore) AddOnCommentChangeListener(l work.OnCommentChangeListener) {
	m.listener = l
}

func TestWorkCommentWatcher_Subscribe(t *testing.T) {
	store := &mockCommentStore{
		comments: []work.Comment{
			{ID: "c1", WorkID: "w1", Body: "hello"},
			{ID: "c2", WorkID: "w1", Body: "world"},
			{ID: "c3", WorkID: "w2", Body: "other"},
		},
	}
	w := NewWorkCommentWatcher(store)

	id, comments, err := w.Subscribe("w1", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if id == "" {
		t.Error("expected non-empty subscription ID")
	}
	if len(comments) != 2 {
		t.Errorf("expected 2 comments for w1, got %d", len(comments))
	}
	if !w.HasSubscriptions() {
		t.Error("expected HasSubscriptions to be true")
	}
}

func TestWorkCommentWatcher_Unsubscribe(t *testing.T) {
	store := &mockCommentStore{}
	w := NewWorkCommentWatcher(store)

	id, _, _ := w.Subscribe("w1", nil)
	w.Unsubscribe(id)

	if w.HasSubscriptions() {
		t.Error("expected HasSubscriptions to be false")
	}
}

func TestWorkCommentWatcher_NotifyChange(t *testing.T) {
	store := &mockCommentStore{}
	w := NewWorkCommentWatcher(store)
	w.Start()
	defer w.Stop()

	notifier := &captureNotifier{}
	w.Subscribe("w1", notifier)

	w.OnCommentChange(work.CommentEvent{
		Comment: work.Comment{ID: "c1", WorkID: "w1", Body: "new comment"},
	})

	waitFor(t, func() bool { return notifier.count() >= 1 })

	if notifier.methods[0] != "work.comment.changed" {
		t.Errorf("method = %q, want %q", notifier.methods[0], "work.comment.changed")
	}

	var params workCommentChangedParams
	json.Unmarshal(notifier.last(), &params)
	if params.Operation != "create" {
		t.Errorf("operation = %q, want %q", params.Operation, "create")
	}
	if params.Comment.ID != "c1" {
		t.Errorf("comment ID = %q, want %q", params.Comment.ID, "c1")
	}
	if params.Comment.Body != "new comment" {
		t.Errorf("comment body = %q, want %q", params.Comment.Body, "new comment")
	}
}

func TestWorkCommentWatcher_NotifyFilteredByWorkID(t *testing.T) {
	store := &mockCommentStore{}
	w := NewWorkCommentWatcher(store)
	w.Start()
	defer w.Stop()

	n1 := &captureNotifier{}
	n2 := &captureNotifier{}
	w.Subscribe("w1", n1)
	w.Subscribe("w2", n2)

	// Send event for w1 only
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

func TestWorkCommentWatcher_DirtyFlag_SyncsAll(t *testing.T) {
	store := &mockCommentStore{
		comments: []work.Comment{
			{ID: "c1", WorkID: "w1", Body: "hello"},
			{ID: "c2", WorkID: "w2", Body: "world"},
		},
	}
	w := &WorkCommentWatcher{
		BaseWatcher: NewBaseWatcher("wc"),
		store:       store,
		eventCh:     make(chan work.CommentEvent, 1),
	}
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
	w.eventCh <- work.CommentEvent{Comment: work.Comment{ID: "c3", WorkID: "w1"}}

	// Both subscribers should receive a sync
	waitFor(t, func() bool { return n1.count() >= 1 && n2.count() >= 1 })

	var p1 workCommentSyncParams
	json.Unmarshal(n1.last(), &p1)
	if p1.Operation != "sync" {
		t.Errorf("n1 operation = %q, want %q", p1.Operation, "sync")
	}
	if len(p1.Comments) != 1 {
		t.Errorf("n1 expected 1 comment in sync, got %d", len(p1.Comments))
	}

	var p2 workCommentSyncParams
	json.Unmarshal(n2.last(), &p2)
	if p2.Operation != "sync" {
		t.Errorf("n2 operation = %q, want %q", p2.Operation, "sync")
	}
	if len(p2.Comments) != 1 {
		t.Errorf("n2 expected 1 comment in sync, got %d", len(p2.Comments))
	}

	if w.dirty.Load() {
		t.Error("dirty flag should be cleared after sync")
	}
}

func TestWorkCommentWatcher_OnCommentChange_AfterStop(t *testing.T) {
	store := &mockCommentStore{}
	w := NewWorkCommentWatcher(store)
	w.Start()
	w.Stop()

	// Should not block or panic
	w.OnCommentChange(work.CommentEvent{
		Comment: work.Comment{ID: "c1", WorkID: "w1"},
	})
}
