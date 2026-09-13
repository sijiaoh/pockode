package watch

import (
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"testing"

	"github.com/pockode/server/session"
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
	w := NewSessionDetailWatcher(store)

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
	w := NewSessionDetailWatcher(store)

	if _, err := w.Subscribe("client-1", "missing", nil); err != session.ErrSessionNotFound {
		t.Errorf("err = %v, want ErrSessionNotFound", err)
	}
	if w.HasSubscriptions() {
		t.Error("expected no subscriptions after a failed subscribe")
	}
}

func TestSessionDetailWatcher_Unsubscribe(t *testing.T) {
	store := &mockSessionStore{sessions: []session.SessionMeta{{ID: "sess-1"}}}
	w := NewSessionDetailWatcher(store)

	w.Subscribe("client-1", "sess-1", nil)
	w.Unsubscribe("client-1")

	if w.HasSubscriptions() {
		t.Error("expected HasSubscriptions to be false after unsubscribe")
	}
}

func TestSessionDetailWatcher_NotifyOnUpdate(t *testing.T) {
	store := &mockSessionStore{sessions: []session.SessionMeta{{ID: "sess-1", Model: "sonnet"}}}
	w := NewSessionDetailWatcher(store)
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
	w := NewSessionDetailWatcher(store)
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
	w := NewSessionDetailWatcher(store)
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
	w := NewSessionDetailWatcher(store)

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

	w.eventCh <- session.SessionChangeEvent{
		Op:      session.OperationUpdate,
		Session: session.SessionMeta{ID: "sess-1"},
	}

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
	w := NewSessionDetailWatcher(store)
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
	w := NewSessionDetailWatcher(store)
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
	w := NewSessionDetailWatcher(store)
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
	w := NewSessionDetailWatcher(store)

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
