package watch

import (
	"encoding/json"
	"sync"
	"testing"

	"github.com/pockode/server/session"
	"github.com/pockode/server/work"
)

type mockDetailStore struct {
	work.Store
	works           []work.Work
	comments        []work.Comment
	changeListener  work.OnChangeListener
	commentListener work.OnCommentChangeListener
}

func (m *mockDetailStore) List() ([]work.Work, error) {
	return m.works, nil
}

func (m *mockDetailStore) FindBySessionID(sessionID string) (work.Work, bool, error) {
	for _, w := range m.works {
		if w.SessionID != "" && w.SessionID == sessionID {
			return w, true, nil
		}
	}
	return work.Work{}, false, nil
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

// mockUsageSource stands in for the worktree manager: session usage per
// worktree. Mutable under a lock, and handing out a copy, because the watcher
// reads it from its own goroutine while a test moves the numbers.
type mockUsageSource struct {
	mu     sync.Mutex
	usages map[string]map[string]session.Usage
}

func newMockUsageSource() *mockUsageSource {
	return &mockUsageSource{usages: map[string]map[string]session.Usage{}}
}

func (m *mockUsageSource) set(worktree, sessionID string, usage session.Usage) *mockUsageSource {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.usages[worktree] == nil {
		m.usages[worktree] = map[string]session.Usage{}
	}
	m.usages[worktree][sessionID] = usage
	return m
}

func (m *mockUsageSource) SessionUsages(worktree string) (map[string]session.Usage, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make(map[string]session.Usage, len(m.usages[worktree]))
	for id, usage := range m.usages[worktree] {
		out[id] = usage
	}
	return out, nil
}

func inputTokens(n int64) session.Usage {
	return session.Usage{TokenUsage: session.TokenUsage{InputTokens: n}}
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
	w := NewWorkDetailWatcher(store, newMockUsageSource(), nil)

	detail, err := w.Subscribe("client-1", "w1", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if detail.Work.ID != "w1" {
		t.Errorf("work ID = %q, want %q", detail.Work.ID, "w1")
	}
	if len(detail.Comments) != 2 {
		t.Errorf("expected 2 comments for w1, got %d", len(detail.Comments))
	}
	if !w.HasSubscriptions() {
		t.Error("expected HasSubscriptions to be true")
	}
}

func TestWorkDetailWatcher_SubscribeNotFound(t *testing.T) {
	store := &mockDetailStore{}
	w := NewWorkDetailWatcher(store, newMockUsageSource(), nil)

	_, err := w.Subscribe("client-1", "nonexistent", nil)
	if err == nil {
		t.Fatal("expected error for nonexistent work")
	}
}

func TestWorkDetailWatcher_Unsubscribe(t *testing.T) {
	store := &mockDetailStore{
		works: []work.Work{{ID: "w1"}},
	}
	w := NewWorkDetailWatcher(store, newMockUsageSource(), nil)

	w.Subscribe("client-1", "w1", nil)
	w.Unsubscribe("client-1")

	if w.HasSubscriptions() {
		t.Error("expected HasSubscriptions to be false")
	}
}

func TestWorkDetailWatcher_NotifyOnCommentChange(t *testing.T) {
	store := &mockDetailStore{
		works: []work.Work{{ID: "w1", Title: "task 1"}},
	}
	w := NewWorkDetailWatcher(store, newMockUsageSource(), nil)
	w.Start()
	defer w.Stop()

	notifier := &captureNotifier{}
	w.Subscribe("client-1", "w1", notifier)

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
	w := NewWorkDetailWatcher(store, newMockUsageSource(), nil)
	w.Start()
	defer w.Stop()

	notifier := &captureNotifier{}
	w.Subscribe("client-1", "w1", notifier)

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

// The other send point for a detail, and the one that runs for the life of a
// page. Its `type` is derived by rpc.NewWorkDetailItem — asserted in the rpc
// package — so what this asks is that the notification goes through it: a
// WorkDetailItem assembled field by field here would compile and marshal with
// `type` empty, and the open page would silently change what it draws on the
// next change to the item.
func TestWorkDetailWatcher_NotificationCarriesTheDerivedType(t *testing.T) {
	for _, tc := range []struct {
		name   string
		workID string
		want   work.WorkType
	}{
		{"a work naming no story", "s1", work.WorkTypeStory},
		{"a work naming one", "t1", work.WorkTypeTask},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := &mockDetailStore{works: []work.Work{
				{ID: "s1", Title: "a story"},
				{ID: "t1", StoryID: "s1", Title: "a task"},
			}}
			w := NewWorkDetailWatcher(store, newMockUsageSource(), nil)
			w.Start()
			defer w.Stop()

			notifier := &captureNotifier{}
			if _, err := w.Subscribe("client-1", tc.workID, notifier); err != nil {
				t.Fatalf("Subscribe: %v", err)
			}

			// Checked rather than discarded: a zero Work from a mistyped fixture id
			// derives to "story", which would pass the story case for the wrong
			// reason.
			item, found, err := store.Get(tc.workID)
			if err != nil || !found {
				t.Fatalf("fixture Get(%s) = found %v, err %v", tc.workID, found, err)
			}
			w.OnWorkChange(work.ChangeEvent{Op: work.OperationUpdate, Work: item})
			waitFor(t, func() bool { return notifier.count() >= 1 })

			var params workDetailChangedParams
			if err := json.Unmarshal(notifier.last(), &params); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}
			if params.Work.Type != tc.want {
				t.Errorf("detail type = %q, want %q", params.Work.Type, tc.want)
			}
		})
	}
}

func TestWorkDetailWatcher_NotifyFilteredByWorkID(t *testing.T) {
	store := &mockDetailStore{
		works: []work.Work{
			{ID: "w1", Title: "task 1"},
			{ID: "w2", Title: "task 2"},
		},
	}
	w := NewWorkDetailWatcher(store, newMockUsageSource(), nil)
	w.Start()
	defer w.Stop()

	n1 := &captureNotifier{}
	n2 := &captureNotifier{}
	w.Subscribe("client-1", "w1", n1)
	w.Subscribe("client-2", "w2", n2)

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
	// Built through the constructor rather than field by field: a literal here
	// silently skipped state the watcher needs (and did).
	w := NewWorkDetailWatcher(store, newMockUsageSource(), nil)

	n1 := &captureNotifier{}
	n2 := &captureNotifier{}
	w.Subscribe("client-1", "w1", n1)
	w.Subscribe("client-2", "w2", n2)

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
	w := NewWorkDetailWatcher(store, newMockUsageSource(), nil)
	w.Start()
	w.Stop()

	// Should not block or panic
	w.OnCommentChange(work.CommentEvent{
		Comment: work.Comment{ID: "c1", WorkID: "w1"},
	})
}

func TestWorkDetailWatcher_OnWorkChange_AfterStop(t *testing.T) {
	store := &mockDetailStore{}
	w := NewWorkDetailWatcher(store, newMockUsageSource(), nil)
	w.Start()
	w.Stop()

	// Should not block or panic
	w.OnWorkChange(work.ChangeEvent{
		Op:   work.OperationUpdate,
		Work: work.Work{ID: "w1"},
	})
}

// The detail carries the story's whole usage, which is the only place it is
// sent: the client sees its own work item and cannot reach the tasks that spent
// most of it.
func TestWorkDetailWatcher_SubscribeCarriesSubtreeUsage(t *testing.T) {
	store := &mockDetailStore{
		works: []work.Work{
			{ID: "w1", SessionID: "s1"},
			{ID: "w2", StoryID: "w1", SessionID: "s2"},
			{ID: "w3", StoryID: "w1", SessionID: "s3"},
		},
	}
	src := newMockUsageSource()
	src.set("", "s1", inputTokens(1))
	src.set("", "s2", inputTokens(10))
	src.set("", "s3", inputTokens(100))
	w := NewWorkDetailWatcher(store, src, nil)

	detail, err := w.Subscribe("client-1", "w1", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if detail.Usage.Own == nil || detail.Usage.Own.InputTokens != 1 {
		t.Errorf("own = %+v, want the work's own session", detail.Usage.Own)
	}
	if detail.Usage.Total == nil || detail.Usage.Total.InputTokens != 111 {
		t.Errorf("total = %+v, want the story and both its tasks", detail.Usage.Total)
	}
	if detail.Usage.TaskCount != 2 {
		t.Errorf("task count = %d, want 2", detail.Usage.TaskCount)
	}
}

// A session spending tokens changes nothing about the work item, so without
// listening to the session stores the number on screen would freeze for exactly
// as long as the agent is running. It reaches the task's story too, because the
// story's total includes it.
func TestWorkDetailWatcher_NotifyOnSessionUsageChange(t *testing.T) {
	store := &mockDetailStore{
		works: []work.Work{
			{ID: "story"},
			{ID: "task", StoryID: "story", SessionID: "s-task"},
			{ID: "other"},
		},
	}
	src := newMockUsageSource()
	w := NewWorkDetailWatcher(store, src, nil)
	w.Start()
	defer w.Stop()

	storyNotifier := &captureNotifier{}
	taskNotifier := &captureNotifier{}
	otherNotifier := &captureNotifier{}
	w.Subscribe("client-1", "story", storyNotifier)
	w.Subscribe("client-2", "task", taskNotifier)
	w.Subscribe("client-3", "other", otherNotifier)

	src.set("", "s-task", inputTokens(42))
	w.OnSessionChange(session.SessionChangeEvent{
		Op:      session.OperationUpdate,
		Session: session.SessionMeta{ID: "s-task"},
	})

	waitFor(t, func() bool { return storyNotifier.count() >= 1 && taskNotifier.count() >= 1 })

	var storyParams workDetailChangedParams
	json.Unmarshal(storyNotifier.last(), &storyParams)
	if storyParams.Usage.Total == nil || storyParams.Usage.Total.InputTokens != 42 {
		t.Errorf("story total = %+v, want the child's 42", storyParams.Usage.Total)
	}

	var taskParams workDetailChangedParams
	json.Unmarshal(taskNotifier.last(), &taskParams)
	if taskParams.Usage.Own == nil || taskParams.Usage.Own.InputTokens != 42 {
		t.Errorf("task own = %+v, want 42", taskParams.Usage.Own)
	}

	if otherNotifier.count() != 0 {
		t.Errorf("a work item outside the session's tree got %d notifications", otherNotifier.count())
	}
}

// Sessions that belong to no work item — plain chats — are most of the sessions
// in the app, and must not cost a work detail push each.
func TestWorkDetailWatcher_IgnoresSessionOutsideAnyWork(t *testing.T) {
	store := &mockDetailStore{works: []work.Work{{ID: "w1"}}}
	w := NewWorkDetailWatcher(store, newMockUsageSource(), nil)
	w.Start()
	defer w.Stop()

	notifier := &captureNotifier{}
	w.Subscribe("client-1", "w1", notifier)

	w.OnSessionChange(session.SessionChangeEvent{
		Op:      session.OperationUpdate,
		Session: session.SessionMeta{ID: "chat-session"},
	})
	// Followed by an event that does notify, so the assertion below is about
	// ordering rather than about how long we waited.
	w.OnWorkChange(work.ChangeEvent{Op: work.OperationUpdate, Work: work.Work{ID: "w1"}})

	waitFor(t, func() bool { return notifier.count() >= 1 })

	if notifier.count() != 1 {
		t.Errorf("got %d notifications, want only the work change", notifier.count())
	}
}

// A session is touched at the end of every turn, marked unread, marked as
// needing input — none of which moves a token count. A detail notification
// carries the work item and its whole comment list, so an unchanged aggregation
// must not buy one.
func TestWorkDetailWatcher_SessionChangeWithoutNewUsageSendsNothing(t *testing.T) {
	store := &mockDetailStore{works: []work.Work{{ID: "w1", SessionID: "s1"}}}
	src := newMockUsageSource().set("", "s1", inputTokens(7))
	w := NewWorkDetailWatcher(store, src, nil)
	w.Start()
	defer w.Stop()

	notifier := &captureNotifier{}
	detail, err := w.Subscribe("client-1", "w1", notifier)
	if err != nil {
		t.Fatalf("Subscribe: %v", err)
	}
	if detail.Usage.Own == nil || detail.Usage.Own.InputTokens != 7 {
		t.Fatalf("subscribe reply usage = %+v, want 7", detail.Usage.Own)
	}

	// Two session changes that leave the numbers where they were.
	for range 2 {
		w.OnSessionChange(session.SessionChangeEvent{
			Op:      session.OperationUpdate,
			Session: session.SessionMeta{ID: "s1"},
		})
	}
	// Then one that moves them, which is also how we know the two above were
	// processed and not merely still in flight.
	src.set("", "s1", inputTokens(9))
	w.OnSessionChange(session.SessionChangeEvent{
		Op:      session.OperationUpdate,
		Session: session.SessionMeta{ID: "s1"},
	})

	waitFor(t, func() bool { return notifier.count() >= 1 })

	if notifier.count() != 1 {
		t.Errorf("got %d notifications, want only the one that moved the numbers", notifier.count())
	}
	var params workDetailChangedParams
	json.Unmarshal(notifier.last(), &params)
	if params.Usage.Own == nil || params.Usage.Own.InputTokens != 9 {
		t.Errorf("notified usage = %+v, want 9", params.Usage.Own)
	}
}

// A work change is not filtered that way: its payload is the news, and the
// client has to get it whether or not any money moved.
func TestWorkDetailWatcher_WorkChangeSendsEvenWithUnchangedUsage(t *testing.T) {
	store := &mockDetailStore{works: []work.Work{{ID: "w1", SessionID: "s1"}}}
	w := NewWorkDetailWatcher(store, newMockUsageSource().set("", "s1", inputTokens(7)), nil)
	w.Start()
	defer w.Stop()

	notifier := &captureNotifier{}
	w.Subscribe("client-1", "w1", notifier)

	store.works[0].Title = "renamed"
	w.OnWorkChange(work.ChangeEvent{Op: work.OperationUpdate, Work: store.works[0]})

	waitFor(t, func() bool { return notifier.count() >= 1 })

	var params workDetailChangedParams
	json.Unmarshal(notifier.last(), &params)
	if params.Work.Title != "renamed" {
		t.Errorf("work title = %q, want %q", params.Work.Title, "renamed")
	}
}

// Whether a client has the latest aggregation is a fact about that client, not
// about the work item: two of them on the same work must each be told.
func TestWorkDetailWatcher_SessionChangeReachesEverySubscriber(t *testing.T) {
	store := &mockDetailStore{works: []work.Work{{ID: "w1", SessionID: "s1"}}}
	src := newMockUsageSource().set("", "s1", inputTokens(1))
	w := NewWorkDetailWatcher(store, src, nil)
	w.Start()
	defer w.Stop()

	first := &captureNotifier{}
	second := &captureNotifier{}
	w.Subscribe("client-1", "w1", first)
	w.Subscribe("client-2", "w1", second)

	src.set("", "s1", inputTokens(2))
	w.OnSessionChange(session.SessionChangeEvent{
		Op:      session.OperationUpdate,
		Session: session.SessionMeta{ID: "s1"},
	})

	waitFor(t, func() bool { return first.count() >= 1 && second.count() >= 1 })
}

// What was sent is remembered per subscription, so unsubscribing has to forget
// it — otherwise the map grows by one entry per work item ever opened, for as
// long as the server runs.
func TestWorkDetailWatcher_UnsubscribeForgetsSentUsage(t *testing.T) {
	store := &mockDetailStore{works: []work.Work{{ID: "w1", SessionID: "s1"}}}
	w := NewWorkDetailWatcher(store, newMockUsageSource().set("", "s1", inputTokens(1)), nil)

	w.Subscribe("client-1", "w1", &captureNotifier{})
	w.Unsubscribe("client-1")

	w.sentUsageMu.Lock()
	defer w.sentUsageMu.Unlock()
	if len(w.sentUsage) != 0 {
		t.Errorf("sentUsage still holds %d entries after unsubscribe", len(w.sentUsage))
	}
}

// turnSourceStub answers with one worktree's turns, the way the worktree manager
// does for a worktree that is loaded.
type turnSourceStub struct {
	mu    sync.Mutex
	turns map[string]session.TurnState
}

func (s *turnSourceStub) set(sessionID string, turn session.TurnState) *turnSourceStub {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.turns == nil {
		s.turns = map[string]session.TurnState{}
	}
	s.turns[sessionID] = turn
	return s
}

func (s *turnSourceStub) SessionTurns(string) (map[string]session.TurnState, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make(map[string]session.TurnState, len(s.turns))
	for id, turn := range s.turns {
		out[id] = turn
	}
	return out, nil
}

// The detail carries the work's activity as well as its usage, and a turn
// starting spends nothing. Judging the re-send on the money alone would leave
// the page saying Idle for the whole of a turn — the most visible thing that can
// happen to the work item the user has open.
func TestWorkDetailWatcher_ResendsWhenOnlyTheActivityMoved(t *testing.T) {
	store := &mockDetailStore{works: []work.Work{
		{ID: "w1", Status: work.StatusActive, SessionID: "s1"},
	}}
	turns := &turnSourceStub{}
	w := NewWorkDetailWatcher(store, newMockUsageSource(), turns)
	w.Start()
	defer w.Stop()

	notifier := &captureNotifier{}
	detail, err := w.Subscribe("client-1", "w1", notifier)
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	if detail.Activity != work.ActivityIdle {
		t.Fatalf("activity on subscribe = %q, want idle", detail.Activity)
	}

	turns.set("s1", session.TurnState{Phase: session.PhaseRunning, Open: true})
	w.OnSessionChange(session.SessionChangeEvent{
		Op:      session.OperationUpdate,
		Session: session.SessionMeta{ID: "s1"},
	})

	waitFor(t, func() bool { return notifier.count() >= 1 })
	var params workDetailChangedParams
	if err := json.Unmarshal(notifier.last(), &params); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if params.Activity != work.ActivityRunning {
		t.Errorf("activity = %q, want running", params.Activity)
	}
}

// A story's detail is the one place its tasks are listed, and it answers for
// them itself: the work list is the `Current` segment and holds no closed work,
// so a closed story read out of the archive would otherwise look childless
// (docs/list-paging-ui.md §2.2).
func TestWorkDetailWatcher_CarriesItsChildrenAndItsParent(t *testing.T) {
	store := &mockDetailStore{works: []work.Work{
		{ID: "story", Status: work.StatusClosed, Title: "Story"},
		{ID: "t1", StoryID: "story", Status: work.StatusClosed, Title: "One"},
		{ID: "t2", StoryID: "story", Status: work.StatusClosed, Title: "Two"},
		{ID: "other", Status: work.StatusOpen, Title: "Other"},
	}}
	w := NewWorkDetailWatcher(store, newMockUsageSource(), nil)

	detail, err := w.Subscribe("client-1", "story", nil)
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	if got := len(detail.Children); got != 2 {
		t.Errorf("children = %d, want 2", got)
	}
	if detail.Parent != nil {
		t.Errorf("a top-level story has no parent, got %+v", detail.Parent)
	}

	child, err := w.Subscribe("client-2", "t1", nil)
	if err != nil {
		t.Fatalf("subscribe to the task: %v", err)
	}
	if len(child.Children) != 0 {
		t.Errorf("a task has no children, got %d", len(child.Children))
	}
	if child.Parent == nil || child.Parent.ID != "story" {
		t.Errorf("parent = %+v, want the story", child.Parent)
	}
}
