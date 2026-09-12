package watch

import (
	"encoding/json"
	"sync"
	"testing"

	"github.com/pockode/server/session"
)

func TestSessionDetailWatcher_Subscribe(t *testing.T) {
	store := &mockSessionStore{
		sessions: []session.SessionMeta{
			{ID: "sess-1", Title: "Session 1", Model: "opus", Effort: "high"},
			{ID: "sess-2", Title: "Session 2"},
		},
	}
	w := NewSessionDetailWatcher(store)

	id, meta, err := w.Subscribe("sess-1", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if id == "" {
		t.Error("expected non-empty subscription ID")
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

	if _, _, err := w.Subscribe("missing", nil); err != session.ErrSessionNotFound {
		t.Errorf("err = %v, want ErrSessionNotFound", err)
	}
	if w.HasSubscriptions() {
		t.Error("expected no subscriptions after a failed subscribe")
	}
}

func TestSessionDetailWatcher_Unsubscribe(t *testing.T) {
	store := &mockSessionStore{sessions: []session.SessionMeta{{ID: "sess-1"}}}
	w := NewSessionDetailWatcher(store)

	id, _, _ := w.Subscribe("sess-1", nil)
	w.Unsubscribe(id)

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
	w.Subscribe("sess-1", notifier)

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
	w.Subscribe("sess-1", notifier)

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
	w.Subscribe("sess-1", watched)
	w.Subscribe("sess-2", other)

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
	w.Subscribe("sess-1", live)
	// Subscribed while the session still existed; the store no longer has it,
	// standing in for a delete whose event was dropped.
	w.AddSubscription(&Subscription{ID: "sd-gone", Key: "sess-removed", Notifier: gone})

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

		wg.Add(1)
		go func() {
			defer wg.Done()
			id, _, err := w.Subscribe(sessionID, &captureNotifier{})
			if err != nil {
				t.Errorf("subscribe failed: %v", err)
				return
			}
			w.Unsubscribe(id)
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

func decodeSessionDetailParams(t *testing.T, raw json.RawMessage) sessionDetailChangedParams {
	t.Helper()
	var params sessionDetailChangedParams
	if err := json.Unmarshal(raw, &params); err != nil {
		t.Fatalf("unmarshal session detail params: %v", err)
	}
	return params
}
