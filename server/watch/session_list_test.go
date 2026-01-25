package watch

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/pockode/server/session"
)

type mockSessionStore struct {
	sessions []session.SessionMeta
	listener session.OnChangeListener
}

func (m *mockSessionStore) List() ([]session.SessionMeta, error) {
	return m.sessions, nil
}

func (m *mockSessionStore) Get(sessionID string) (session.SessionMeta, bool, error) {
	return session.SessionMeta{}, false, nil
}

func (m *mockSessionStore) Create(ctx context.Context, sessionID string) (session.SessionMeta, error) {
	return session.SessionMeta{}, nil
}

func (m *mockSessionStore) Delete(ctx context.Context, sessionID string) error {
	return nil
}

func (m *mockSessionStore) Update(ctx context.Context, sessionID string, title string) error {
	return nil
}

func (m *mockSessionStore) Activate(ctx context.Context, sessionID string) error {
	return nil
}

func (m *mockSessionStore) GetHistory(ctx context.Context, sessionID string) ([]json.RawMessage, error) {
	return nil, nil
}

func (m *mockSessionStore) AppendToHistory(ctx context.Context, sessionID string, record any) error {
	return nil
}

func (m *mockSessionStore) Touch(ctx context.Context, sessionID string) error {
	return nil
}

func (m *mockSessionStore) SetMode(ctx context.Context, sessionID string, mode session.Mode) error {
	return nil
}

func (m *mockSessionStore) SetOnChangeListener(listener session.OnChangeListener) {
	m.listener = listener
}

type mockSessionStoreWithError struct {
	mockSessionStore
	err error
}

func (m *mockSessionStoreWithError) List() ([]session.SessionMeta, error) {
	return nil, m.err
}

func TestSessionListWatcher_Subscribe(t *testing.T) {
	store := &mockSessionStore{
		sessions: []session.SessionMeta{
			{ID: "sess-1", Title: "Session 1"},
			{ID: "sess-2", Title: "Session 2"},
		},
	}
	w := NewSessionListWatcher(store)

	id, sessions, err := w.Subscribe(nil, "conn1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if id == "" {
		t.Error("expected non-empty subscription ID")
	}

	if len(sessions) != 2 {
		t.Errorf("expected 2 sessions, got %d", len(sessions))
	}

	if !w.HasSubscriptions() {
		t.Error("expected HasSubscriptions to be true")
	}
}

func TestSessionListWatcher_Unsubscribe(t *testing.T) {
	store := &mockSessionStore{}
	w := NewSessionListWatcher(store)

	id, _, _ := w.Subscribe(nil, "conn1")

	if !w.HasSubscriptions() {
		t.Error("expected HasSubscriptions to be true")
	}

	w.Unsubscribe(id)

	if w.HasSubscriptions() {
		t.Error("expected HasSubscriptions to be false")
	}
}

func TestSessionListWatcher_OnSessionChange_NoSubscribers(t *testing.T) {
	store := &mockSessionStore{}
	w := NewSessionListWatcher(store)

	// Should not panic
	w.OnSessionChange(session.SessionChangeEvent{
		Op:      session.OperationCreate,
		Session: session.SessionMeta{ID: "sess-1"},
	})
}

func TestSessionListWatcher_ListenerRegistered(t *testing.T) {
	store := &mockSessionStore{}
	w := NewSessionListWatcher(store)

	if store.listener != w {
		t.Error("expected watcher to be registered as listener")
	}
}

func TestSessionListWatcher_OnSessionChange_AfterStop(t *testing.T) {
	store := &mockSessionStore{}
	w := NewSessionListWatcher(store)
	w.Start()
	w.Stop()

	// Should not block or panic after Stop
	w.OnSessionChange(session.SessionChangeEvent{
		Op:      session.OperationCreate,
		Session: session.SessionMeta{ID: "sess-1"},
	})
}

func TestSessionListWatcher_Subscribe_ListError(t *testing.T) {
	store := &mockSessionStoreWithError{err: errors.New("list failed")}
	w := NewSessionListWatcher(store)

	_, _, err := w.Subscribe(nil, "conn1")
	if err == nil {
		t.Error("expected error")
	}

	if w.HasSubscriptions() {
		t.Error("expected no subscriptions after error")
	}
}
