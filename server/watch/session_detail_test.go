package watch

import (
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/pockode/server/session"
	"github.com/pockode/server/work"
)

// mockSessionStoreWithGetHook runs onGet inside the store read, which is how a
// test reaches the moment between a subscription being registered and the
// snapshot it replies with being taken.
type mockSessionStoreWithGetHook struct {
	mockSessionStore
	onGet func()
}

func (m *mockSessionStoreWithGetHook) Get(sessionID string) (session.SessionMeta, bool, error) {
	if m.onGet != nil {
		m.onGet()
	}
	return m.mockSessionStore.Get(sessionID)
}

func TestSessionDetailWatcher_Subscribe(t *testing.T) {
	store := &mockSessionStore{
		sessions: []session.SessionMeta{
			{ID: "sess-1", Title: "Session 1", Model: "opus", Effort: "high"},
			{ID: "sess-2", Title: "Session 2"},
		},
	}
	w := NewSessionDetailWatcher(store, nil)

	meta, err := w.Subscribe("client-1", "sess-1", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if sub := w.GetSubscription("client-1"); sub == nil {
		t.Error("subscription must be registered under the id the client chose")
	}
	if meta.Model != "opus" || meta.Effort != "high" {
		t.Errorf("snapshot missing detail fields: %+v", meta)
	}
	if !store.hasListener(w) {
		t.Error("expected watcher to be registered as listener")
	}
}

func TestSessionDetailWatcher_SubscribeNotFound(t *testing.T) {
	store := &mockSessionStore{}
	w := NewSessionDetailWatcher(store, nil)

	if _, err := w.Subscribe("client-1", "missing", nil); err != session.ErrSessionNotFound {
		t.Errorf("err = %v, want ErrSessionNotFound", err)
	}
	if w.HasSubscriptions() {
		t.Error("expected no subscriptions after a failed subscribe")
	}
}

func TestSessionDetailWatcher_Unsubscribe(t *testing.T) {
	store := &mockSessionStore{sessions: []session.SessionMeta{{ID: "sess-1"}}}
	w := NewSessionDetailWatcher(store, nil)

	w.Subscribe("client-1", "sess-1", nil)
	w.Unsubscribe("client-1")

	if w.HasSubscriptions() {
		t.Error("expected HasSubscriptions to be false after unsubscribe")
	}
}

func TestSessionDetailWatcher_NotifyOnUpdate(t *testing.T) {
	store := &mockSessionStore{sessions: []session.SessionMeta{{ID: "sess-1", Model: "sonnet"}}}
	w := NewSessionDetailWatcher(store, nil)
	w.Start()
	defer w.Stop()

	notifier := &captureNotifier{}
	w.Subscribe("client-1", "sess-1", notifier)

	w.OnSessionChange(session.SessionChangeEvent{
		Op:      session.OperationUpdate,
		Session: session.SessionMeta{ID: "sess-1", Model: "opus"},
	})

	waitFor(t, func() bool { return notifier.count() >= 1 })

	params := decodeSessionDetailParams(t, notifier.last())
	if params.Deleted {
		t.Error("update must not be reported as deleted")
	}
	if params.Session == nil || params.Session.Model != "opus" {
		t.Errorf("unexpected session in notification: %+v", params.Session)
	}
}

func TestSessionDetailWatcher_NotifyOnDelete(t *testing.T) {
	store := &mockSessionStore{sessions: []session.SessionMeta{{ID: "sess-1"}}}
	w := NewSessionDetailWatcher(store, nil)
	w.Start()
	defer w.Stop()

	notifier := &captureNotifier{}
	w.Subscribe("client-1", "sess-1", notifier)

	w.OnSessionChange(session.SessionChangeEvent{
		Op:      session.OperationDelete,
		Session: session.SessionMeta{ID: "sess-1"},
	})

	waitFor(t, func() bool { return notifier.count() >= 1 })

	params := decodeSessionDetailParams(t, notifier.last())
	if !params.Deleted {
		t.Error("expected deleted = true")
	}
	if params.Session != nil {
		t.Errorf("expected no session payload on delete, got %+v", params.Session)
	}
}

func TestSessionDetailWatcher_FiltersBySessionID(t *testing.T) {
	store := &mockSessionStore{
		sessions: []session.SessionMeta{{ID: "sess-1"}, {ID: "sess-2"}},
	}
	w := NewSessionDetailWatcher(store, nil)
	w.Start()
	defer w.Stop()

	watched := &captureNotifier{}
	other := &captureNotifier{}
	w.Subscribe("client-1", "sess-1", watched)
	w.Subscribe("client-2", "sess-2", other)

	w.OnSessionChange(session.SessionChangeEvent{
		Op:      session.OperationUpdate,
		Session: session.SessionMeta{ID: "sess-1", Title: "renamed"},
	})

	waitFor(t, func() bool { return watched.count() >= 1 })

	if other.count() != 0 {
		t.Errorf("subscriber of another session was notified %d times", other.count())
	}
}

func TestSessionDetailWatcher_DirtyFlag_SyncsFromStore(t *testing.T) {
	store := &mockSessionStore{
		sessions: []session.SessionMeta{{ID: "sess-1", Title: "current"}},
	}
	w := NewSessionDetailWatcher(store, nil)

	live := &captureNotifier{}
	gone := &captureNotifier{}
	w.Subscribe("client-1", "sess-1", live)
	// Subscribed while the session still existed; the store no longer has it,
	// standing in for a delete whose event was dropped.
	if err := w.AddSubscription(&Subscription{ID: "sd-gone", Key: "sess-removed", Notifier: gone}); err != nil {
		t.Fatalf("add subscription: %v", err)
	}

	w.dirty.Store(true)
	w.Start()
	defer w.Stop()

	w.eventCh <- sessionDetailEvent{session: &session.SessionChangeEvent{
		Op:      session.OperationUpdate,
		Session: session.SessionMeta{ID: "sess-1"},
	}}

	waitFor(t, func() bool { return live.count() >= 1 && gone.count() >= 1 })

	params := decodeSessionDetailParams(t, live.last())
	if params.Session == nil || params.Session.Title != "current" {
		t.Errorf("sync must carry the store's current session, got %+v", params.Session)
	}

	removed := decodeSessionDetailParams(t, gone.last())
	if !removed.Deleted {
		t.Error("a session missing from the store must sync as deleted")
	}

	if w.dirty.Load() {
		t.Error("dirty flag should be cleared after sync")
	}
}

func TestSessionDetailWatcher_OnSessionChange_AfterStop(t *testing.T) {
	store := &mockSessionStore{}
	w := NewSessionDetailWatcher(store, nil)
	w.Start()
	w.Stop()

	// Must neither block nor panic once the watcher is stopped.
	w.OnSessionChange(session.SessionChangeEvent{
		Op:      session.OperationUpdate,
		Session: session.SessionMeta{ID: "sess-1"},
	})
}

func TestSessionDetailWatcher_ConcurrentSubscribeUnsubscribe(t *testing.T) {
	store := &mockSessionStore{sessions: []session.SessionMeta{{ID: "sess-1"}, {ID: "sess-2"}}}
	w := NewSessionDetailWatcher(store, nil)
	w.Start()
	defer w.Stop()

	var wg sync.WaitGroup
	for i := range 20 {
		sessionID := "sess-1"
		if i%2 == 1 {
			sessionID = "sess-2"
		}
		subID := fmt.Sprintf("client-%d", i)

		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := w.Subscribe(subID, sessionID, &captureNotifier{}); err != nil {
				t.Errorf("subscribe failed: %v", err)
				return
			}
			w.Unsubscribe(subID)
		}()

		wg.Add(1)
		go func() {
			defer wg.Done()
			w.OnSessionChange(session.SessionChangeEvent{
				Op:      session.OperationUpdate,
				Session: session.SessionMeta{ID: sessionID},
			})
		}()
	}
	wg.Wait()

	if w.HasSubscriptions() {
		t.Error("expected every subscription to be removed")
	}
}

// The window this pins: the subscription is registered, the snapshot has not
// been read yet, and a write lands. The notification must reach the subscriber,
// addressed to the id the client already has — with a server-generated id the
// client could not learn before the reply, this notification had no receiver and
// left the client on a stale snapshot with nothing to correct it.
func TestSessionDetailWatcher_NotifiesChangeLandingDuringSubscribe(t *testing.T) {
	store := &mockSessionStoreWithGetHook{}
	store.sessions = []session.SessionMeta{{ID: "sess-1", Title: "before"}}
	w := NewSessionDetailWatcher(store, nil)
	w.Start()
	defer w.Stop()

	notifier := &captureNotifier{}
	store.onGet = func() {
		w.OnSessionChange(session.SessionChangeEvent{
			Op:      session.OperationUpdate,
			Session: session.SessionMeta{ID: "sess-1", Title: "during subscribe"},
		})
	}

	meta, err := w.Subscribe("client-1", "sess-1", notifier)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if meta.Title != "before" {
		t.Errorf("snapshot = %q, want the state the store read saw", meta.Title)
	}

	waitFor(t, func() bool { return notifier.count() >= 1 })

	params := decodeSessionDetailParams(t, notifier.last())
	if params.ID != "client-1" {
		t.Errorf("notification addressed to %q, want the client's own id", params.ID)
	}
	if params.Session == nil || params.Session.Title != "during subscribe" {
		t.Errorf("unexpected session in notification: %+v", params.Session)
	}
}

// What the id space refuses is BaseWatcher's business (see base_test.go); what
// this pins is that a refusal is passed on rather than swallowed, leaving the
// client believing it has a subscription the watcher never made.
func TestSessionDetailWatcher_SubscribeReportsUnusableID(t *testing.T) {
	store := &mockSessionStore{
		sessions: []session.SessionMeta{{ID: "sess-1"}, {ID: "sess-2"}},
	}
	w := NewSessionDetailWatcher(store, nil)

	if _, err := w.Subscribe("client-1", "sess-1", &captureNotifier{}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if _, err := w.Subscribe("client-1", "sess-2", &captureNotifier{}); !errors.Is(err, ErrSubscriptionIDInUse) {
		t.Errorf("err = %v, want ErrSubscriptionIDInUse", err)
	}
}

func decodeSessionDetailParams(t *testing.T, raw json.RawMessage) sessionDetailChangedParams {
	t.Helper()
	var params sessionDetailChangedParams
	if err := json.Unmarshal(raw, &params); err != nil {
		t.Fatalf("unmarshal session detail params: %v", err)
	}
	return params
}

// The open session says which work item it runs. The list row says it too, but
// the sidebar filter hides exactly the work sessions — so for the session a
// client actually has open, this is often the only place the id exists.
func TestSessionDetailWatcher_Subscribe_CarriesTheWorkID(t *testing.T) {
	store, works := sessionsWithOneWorkSession()
	w := NewSessionDetailWatcher(store, works)

	detail, err := w.Subscribe("client-1", "sess-work", nil)
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	if detail.WorkID != "work-1" {
		t.Errorf("work session's detail work_id = %q, want %q", detail.WorkID, "work-1")
	}

	plain, err := w.Subscribe("client-2", "sess-chat", nil)
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	if plain.WorkID != "" {
		t.Errorf("plain chat session's detail carries work_id %q, want none", plain.WorkID)
	}
}

// Refused rather than answered without the id: a detail with no work_id says
// the session belongs to no work, and a subscriber has no reason to ask again.
func TestSessionDetailWatcher_Subscribe_WorkIndexError(t *testing.T) {
	store, works := sessionsWithOneWorkSession()
	w := NewSessionDetailWatcher(store, &failingWorkSource{stubWorkSource: works, failFor: "sess-work"})

	if _, err := w.Subscribe("client-1", "sess-work", nil); err == nil {
		t.Error("expected an error")
	}
	if w.HasSubscriptions() {
		t.Error("expected no subscription left behind after the error")
	}
}

// The binding is live: a work item claiming a session that was already open has
// to reach the client that has it open, because nothing about the session itself
// moved.
func TestSessionDetailWatcher_HandleWorkChange_PushesTheBinding(t *testing.T) {
	store, works := sessionsWithOneWorkSession()
	w := NewSessionDetailWatcher(store, works)
	notifier := &captureNotifier{}
	if _, err := w.Subscribe("client-1", "sess-work", notifier); err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	w.Start()
	defer w.Stop()

	w.HandleWorkChange(work.ChangeEvent{
		Op:   work.OperationUpdate,
		Work: work.Work{ID: "work-1", SessionID: "sess-work"},
	})

	waitFor(t, func() bool { return notifier.count() >= 1 })
	params := decodeSessionDetailParams(t, notifier.last())
	if params.Session == nil || params.Session.WorkID != "work-1" {
		t.Errorf("work change pushed %+v, want the detail carrying its work id", params.Session)
	}
	if params.Session.ID != "sess-work" {
		t.Errorf("pushed session %q, want the one the work runs", params.Session.ID)
	}
}

// A work is written several times a turn — a wait declared, a nudge counted, a
// step advanced — and none of it moves the one thing the detail takes from it.
func TestSessionDetailWatcher_HandleWorkChange_SkipsWritesThatMoveNothing(t *testing.T) {
	store, works := sessionsWithOneWorkSession()
	w := NewSessionDetailWatcher(store, works)
	notifier := &captureNotifier{}
	if _, err := w.Subscribe("client-1", "sess-work", notifier); err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	w.Start()
	defer w.Stop()

	event := work.ChangeEvent{
		Op:   work.OperationUpdate,
		Work: work.Work{ID: "work-1", SessionID: "sess-work"},
	}
	w.HandleWorkChange(event)
	waitFor(t, func() bool { return notifier.count() >= 1 })

	w.HandleWorkChange(event)
	// A session change is pushed unconditionally, so it also proves the work
	// event before it was handled rather than merely still in flight.
	w.OnSessionChange(session.SessionChangeEvent{
		Op:      session.OperationUpdate,
		Session: session.SessionMeta{ID: "sess-work", Title: "renamed"},
	})
	waitFor(t, func() bool { return notifier.count() >= 2 })

	if got := notifier.count(); got != 2 {
		t.Errorf("sent %d notifications, want 2 — the repeated work write moves nothing", got)
	}
	params := decodeSessionDetailParams(t, notifier.last())
	if params.Session == nil || params.Session.Title != "renamed" {
		t.Errorf("last notification is %+v, want the session change", params.Session)
	}
}

// A work item whose session nobody has open is not this watcher's business,
// which is what keeps a project's work churn off a client watching one chat.
func TestSessionDetailWatcher_HandleWorkChange_IgnoresUnwatchedSessions(t *testing.T) {
	store, works := sessionsWithOneWorkSession()
	w := NewSessionDetailWatcher(store, works)
	notifier := &captureNotifier{}
	if _, err := w.Subscribe("client-1", "sess-chat", notifier); err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	w.Start()
	defer w.Stop()

	w.HandleWorkChange(work.ChangeEvent{
		Op:   work.OperationUpdate,
		Work: work.Work{ID: "work-1", SessionID: "sess-work"},
	})
	w.OnSessionChange(session.SessionChangeEvent{
		Op:      session.OperationUpdate,
		Session: session.SessionMeta{ID: "sess-chat"},
	})

	waitFor(t, func() bool { return notifier.count() >= 1 })
	if got := notifier.count(); got != 1 {
		t.Errorf("sent %d notifications, want only the one about the watched session", got)
	}
}

// Every session notification carries the relation, not just the ones a work
// change triggers: a client that took a title change must not take a detail
// that has lost its work id along with it.
func TestSessionDetailWatcher_SessionChange_CarriesTheWorkID(t *testing.T) {
	store, works := sessionsWithOneWorkSession()
	w := NewSessionDetailWatcher(store, works)
	notifier := &captureNotifier{}
	if _, err := w.Subscribe("client-1", "sess-work", notifier); err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	w.Start()
	defer w.Stop()

	w.OnSessionChange(session.SessionChangeEvent{
		Op:      session.OperationUpdate,
		Session: session.SessionMeta{ID: "sess-work", Title: "renamed"},
	})

	waitFor(t, func() bool { return notifier.count() >= 1 })
	params := decodeSessionDetailParams(t, notifier.last())
	if params.Session == nil || params.Session.WorkID != "work-1" {
		t.Errorf("session change pushed %+v, want the detail carrying its work id", params.Session)
	}
}

// A relation that could not be read is not news about the session: saying
// nothing leaves the client with what it had, where pushing would replace a
// correct work id with an empty one.
func TestSessionDetailWatcher_SessionChange_WorkIndexError(t *testing.T) {
	store, works := sessionsWithOneWorkSession()
	w := NewSessionDetailWatcher(store, works)
	notifier := &captureNotifier{}
	if _, err := w.Subscribe("client-1", "sess-work", notifier); err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	w.works.source = &failingWorkSource{stubWorkSource: works, failFor: "sess-work"}
	w.Start()
	defer w.Stop()

	w.OnSessionChange(session.SessionChangeEvent{
		Op:      session.OperationUpdate,
		Session: session.SessionMeta{ID: "sess-work", Title: "renamed"},
	})
	// The delete needs no relation, so it goes out either way — and proves the
	// update before it was handled and dropped.
	w.OnSessionChange(session.SessionChangeEvent{
		Op:      session.OperationDelete,
		Session: session.SessionMeta{ID: "sess-work"},
	})

	waitFor(t, func() bool { return notifier.count() >= 1 })
	if got := notifier.count(); got != 1 {
		t.Errorf("sent %d notifications, want only the delete", got)
	}
	params := decodeSessionDetailParams(t, notifier.last())
	if !params.Deleted {
		t.Errorf("notification is %+v, want the delete", params)
	}
}

// What was last sent for a session is only sound while it names what every
// subscriber of that session holds — and a relation that changed while nobody
// watched it was sent to nobody. So a subscribe drops the record rather than
// writing its own snapshot into it: the cost is one redundant push, where
// recording would cost a push that never comes.
func TestSessionDetailWatcher_Subscribe_DoesNotSuppressTheNextPush(t *testing.T) {
	store, works := sessionsWithOneWorkSession()
	w := NewSessionDetailWatcher(store, works)
	first := &captureNotifier{}
	if _, err := w.Subscribe("client-1", "sess-work", first); err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	w.Start()
	defer w.Stop()

	event := work.ChangeEvent{
		Op:   work.OperationUpdate,
		Work: work.Work{ID: "work-1", SessionID: "sess-work"},
	}
	w.HandleWorkChange(event)
	waitFor(t, func() bool { return first.count() >= 1 })

	second := &captureNotifier{}
	if _, err := w.Subscribe("client-2", "sess-work", second); err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	w.HandleWorkChange(event)

	waitFor(t, func() bool { return second.count() >= 1 })
	params := decodeSessionDetailParams(t, second.last())
	if params.Session == nil || params.Session.WorkID != "work-1" {
		t.Errorf("the subscriber that joined got %+v, want the detail with its work id", params.Session)
	}
}

// flakyWorkSource fails the lookup for one session until it is told to stop,
// which is how a test gets a sync to skip that session and then lets the retry
// succeed. Toggled with an atomic because the watcher reads it from its own
// goroutine.
type flakyWorkSource struct {
	*stubWorkSource
	failFor string
	failing atomic.Bool
}

func (f *flakyWorkSource) FindBySessionID(sessionID string) (work.Work, bool, error) {
	if f.failing.Load() && sessionID == f.failFor {
		return work.Work{}, false, errors.New("index unreadable")
	}
	return f.stubWorkSource.FindBySessionID(sessionID)
}

// The sync after a dropped event is the only thing that can replace what was
// dropped, so a session it could not read has to leave the flag up. Without
// that, the subscriber keeps what it held before the drop until some later event
// happens to touch that session — which, for a session whose agent has
// finished, may never happen.
func TestSessionDetailWatcher_Sync_RetriesASkippedSession(t *testing.T) {
	store, stub := sessionsWithOneWorkSession()
	works := &flakyWorkSource{stubWorkSource: stub, failFor: "sess-work"}
	works.failing.Store(true)
	w := NewSessionDetailWatcher(store, works)

	// The second subscriber is the clock: its notification is what proves the
	// sync ran at all, since a skipped session is sent nothing by definition.
	skipped := &captureNotifier{}
	witness := &captureNotifier{}
	if err := w.AddSubscription(&Subscription{ID: "client-1", Key: "sess-work", Notifier: skipped}); err != nil {
		t.Fatalf("add subscription: %v", err)
	}
	if err := w.AddSubscription(&Subscription{ID: "client-2", Key: "sess-chat", Notifier: witness}); err != nil {
		t.Fatalf("add subscription: %v", err)
	}

	w.dirty.Store(true)
	w.Start()
	defer w.Stop()

	w.OnSessionChange(session.SessionChangeEvent{
		Op:      session.OperationUpdate,
		Session: session.SessionMeta{ID: "sess-chat"},
	})

	waitFor(t, func() bool { return witness.count() >= 1 })
	if skipped.count() != 0 {
		t.Fatalf("sent %d notifications about the session whose work could not be read", skipped.count())
	}
	if !w.dirty.Load() {
		t.Fatal("a sync that skipped a session left the dirty flag down: nothing will retry it")
	}

	works.failing.Store(false)
	w.OnSessionChange(session.SessionChangeEvent{
		Op:      session.OperationUpdate,
		Session: session.SessionMeta{ID: "sess-chat"},
	})

	waitFor(t, func() bool { return skipped.count() >= 1 })
	params := decodeSessionDetailParams(t, skipped.last())
	if params.Session == nil || params.Session.WorkID != "work-1" {
		t.Errorf("the retried sync sent %+v, want the session with its work id", params.Session)
	}
}
