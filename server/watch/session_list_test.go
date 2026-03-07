package watch

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/pockode/server/process"
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
	for _, s := range m.sessions {
		if s.ID == sessionID {
			return s, true, nil
		}
	}
	return session.SessionMeta{}, false, nil
}

func (m *mockSessionStore) Create(ctx context.Context, sessionID string, agentType session.AgentType, mode session.Mode) (session.SessionMeta, error) {
	return session.SessionMeta{}, nil
}

func (m *mockSessionStore) SetAgentType(ctx context.Context, sessionID string, agentType session.AgentType) error {
	return nil
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

func (m *mockSessionStore) SetNeedsInput(ctx context.Context, sessionID string, needsInput bool) error {
	return nil
}

func (m *mockSessionStore) SetUnread(ctx context.Context, sessionID string, unread bool) error {
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

type mockProcessStateGetter struct{}

func (m *mockProcessStateGetter) GetProcessState(sessionID string) string {
	return "ended"
}

func TestSessionListWatcher_Subscribe(t *testing.T) {
	store := &mockSessionStore{
		sessions: []session.SessionMeta{
			{ID: "sess-1", Title: "Session 1"},
			{ID: "sess-2", Title: "Session 2"},
		},
	}
	w := NewSessionListWatcher(store)
	w.SetProcessStateGetter(&mockProcessStateGetter{})

	id, sessions, err := w.Subscribe(nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if id == "" {
		t.Error("expected non-empty subscription ID")
	}

	if len(sessions) != 2 {
		t.Errorf("expected 2 sessions, got %d", len(sessions))
	}

	// Verify sessions are enriched with state
	for _, s := range sessions {
		if s.State != "ended" {
			t.Errorf("expected state 'ended', got %q", s.State)
		}
	}

	if !w.HasSubscriptions() {
		t.Error("expected HasSubscriptions to be true")
	}
}

func TestSessionListWatcher_Unsubscribe(t *testing.T) {
	store := &mockSessionStore{}
	w := NewSessionListWatcher(store)
	w.SetProcessStateGetter(&mockProcessStateGetter{})

	id, _, _ := w.Subscribe(nil)

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
	w.SetProcessStateGetter(&mockProcessStateGetter{})

	_, _, err := w.Subscribe(nil)
	if err == nil {
		t.Error("expected error")
	}

	if w.HasSubscriptions() {
		t.Error("expected no subscriptions after error")
	}
}

func TestSessionListWatcher_HandleProcessStateChange_NoSubscribers(t *testing.T) {
	store := &mockSessionStore{}
	w := NewSessionListWatcher(store)

	// Should not panic when no subscribers
	w.HandleProcessStateChange(process.StateChangeEvent{
		SessionID: "sess-1",
		State:     process.ProcessStateRunning,
	})
}

type recordingSessionStore struct {
	mockSessionStore
	needsInputCalls []needsInputCall
}

type needsInputCall struct {
	SessionID  string
	NeedsInput bool
}

func (r *recordingSessionStore) SetNeedsInput(_ context.Context, sessionID string, needsInput bool) error {
	r.needsInputCalls = append(r.needsInputCalls, needsInputCall{SessionID: sessionID, NeedsInput: needsInput})
	return nil
}

type recordingSyncer struct {
	calls []syncCall
}

type syncCall struct {
	SessionID  string
	NeedsInput bool
}

func (r *recordingSyncer) SyncNeedsInput(_ context.Context, sessionID string, needsInput bool) {
	r.calls = append(r.calls, syncCall{SessionID: sessionID, NeedsInput: needsInput})
}

func TestHandleProcessStateChange_IdleNeedsInput_SyncsWork(t *testing.T) {
	store := &mockSessionStore{}
	w := NewSessionListWatcher(store)
	syncer := &recordingSyncer{}
	w.SetWorkNeedsInputSyncer(syncer)

	w.HandleProcessStateChange(process.StateChangeEvent{
		SessionID:  "sess-1",
		State:      process.ProcessStateIdle,
		NeedsInput: true,
	})

	if len(syncer.calls) != 1 {
		t.Fatalf("expected 1 sync call, got %d", len(syncer.calls))
	}
	if syncer.calls[0].SessionID != "sess-1" || !syncer.calls[0].NeedsInput {
		t.Errorf("unexpected call: %+v", syncer.calls[0])
	}
}

func TestHandleProcessStateChange_IdleNoNeedsInput_NoSync(t *testing.T) {
	store := &mockSessionStore{}
	w := NewSessionListWatcher(store)
	syncer := &recordingSyncer{}
	w.SetWorkNeedsInputSyncer(syncer)

	w.HandleProcessStateChange(process.StateChangeEvent{
		SessionID:  "sess-1",
		State:      process.ProcessStateIdle,
		NeedsInput: false,
	})

	if len(syncer.calls) != 0 {
		t.Errorf("expected no sync calls for idle without needsInput, got %d", len(syncer.calls))
	}
}

func TestHandleProcessStateChange_Running_DoesNotClearNeedsInput(t *testing.T) {
	store := &recordingSessionStore{}
	w := NewSessionListWatcher(store)
	syncer := &recordingSyncer{}
	w.SetWorkNeedsInputSyncer(syncer)

	w.HandleProcessStateChange(process.StateChangeEvent{
		SessionID: "sess-1",
		State:     process.ProcessStateRunning,
	})

	// Running should NOT clear needs_input — that is done by user events via ClearNeedsInput.
	if len(store.needsInputCalls) != 0 {
		t.Errorf("expected no SetNeedsInput calls on Running, got %d", len(store.needsInputCalls))
	}
	if len(syncer.calls) != 0 {
		t.Errorf("expected no sync calls on Running, got %d", len(syncer.calls))
	}
}

func TestHandleProcessStateChange_Ended_ClearsNeedsInputAndSyncsWork(t *testing.T) {
	store := &recordingSessionStore{}
	w := NewSessionListWatcher(store)
	syncer := &recordingSyncer{}
	w.SetWorkNeedsInputSyncer(syncer)

	w.HandleProcessStateChange(process.StateChangeEvent{
		SessionID: "sess-1",
		State:     process.ProcessStateEnded,
	})

	// NeedsInput must be cleared in the store
	if len(store.needsInputCalls) != 1 {
		t.Fatalf("expected 1 SetNeedsInput call, got %d", len(store.needsInputCalls))
	}
	if store.needsInputCalls[0].SessionID != "sess-1" || store.needsInputCalls[0].NeedsInput {
		t.Errorf("expected SetNeedsInput(sess-1, false), got %+v", store.needsInputCalls[0])
	}

	// Work syncer must be called to clear needs_input
	if len(syncer.calls) != 1 {
		t.Fatalf("expected 1 sync call, got %d", len(syncer.calls))
	}
	if syncer.calls[0].SessionID != "sess-1" || syncer.calls[0].NeedsInput {
		t.Errorf("unexpected call: %+v", syncer.calls[0])
	}
}

func TestHandleProcessStateChange_NoSyncer_NoPanic(t *testing.T) {
	store := &mockSessionStore{}
	w := NewSessionListWatcher(store)

	// No syncer set — should not panic
	w.HandleProcessStateChange(process.StateChangeEvent{
		SessionID:  "sess-1",
		State:      process.ProcessStateIdle,
		NeedsInput: true,
	})
}

func TestSessionListWatcher_DirtyFlag_SyncsAfterDrop(t *testing.T) {
	store := &mockSessionStore{
		sessions: []session.SessionMeta{
			{ID: "sess-1", Title: "Session 1"},
			{ID: "sess-2", Title: "Session 2"},
		},
	}
	w := &SessionListWatcher{
		BaseWatcher: NewBaseWatcher("sl"),
		store:       store,
		eventCh:     make(chan session.SessionChangeEvent, 1),
	}
	store.SetOnChangeListener(w)
	w.SetProcessStateGetter(&mockProcessStateGetter{})

	notifier := &captureNotifier{}
	w.Subscribe(notifier)

	// Simulate the dirty flag being set (as if events were dropped)
	w.dirty.Store(true)

	w.Start()
	defer w.Stop()

	// Send a single event — eventLoop sees dirty=true and sends sync instead
	w.eventCh <- session.SessionChangeEvent{
		Op:      session.OperationUpdate,
		Session: session.SessionMeta{ID: "sess-1"},
	}

	waitFor(t, func() bool { return notifier.count() >= 1 })

	raw := notifier.last()
	var params sessionListSyncParams
	if err := json.Unmarshal(raw, &params); err != nil {
		t.Fatalf("unmarshal sync params: %v", err)
	}
	if params.Operation != "sync" {
		t.Errorf("operation = %q, want %q", params.Operation, "sync")
	}
	if len(params.Sessions) != 2 {
		t.Errorf("expected 2 sessions in sync, got %d", len(params.Sessions))
	}

	if w.dirty.Load() {
		t.Error("dirty flag should be cleared after sync")
	}
}

func TestClearNeedsInput_ClearsStoreAndSyncsWork(t *testing.T) {
	store := &recordingSessionStore{}
	w := NewSessionListWatcher(store)
	syncer := &recordingSyncer{}
	w.SetWorkNeedsInputSyncer(syncer)

	w.ClearNeedsInput("sess-1")

	if len(store.needsInputCalls) != 1 {
		t.Fatalf("expected 1 SetNeedsInput call, got %d", len(store.needsInputCalls))
	}
	if store.needsInputCalls[0].SessionID != "sess-1" || store.needsInputCalls[0].NeedsInput {
		t.Errorf("expected SetNeedsInput(sess-1, false), got %+v", store.needsInputCalls[0])
	}

	if len(syncer.calls) != 1 {
		t.Fatalf("expected 1 sync call, got %d", len(syncer.calls))
	}
	if syncer.calls[0].SessionID != "sess-1" || syncer.calls[0].NeedsInput {
		t.Errorf("unexpected call: %+v", syncer.calls[0])
	}
}

func TestClearNeedsInput_NoSyncer_NoPanic(t *testing.T) {
	store := &recordingSessionStore{}
	w := NewSessionListWatcher(store)

	// No syncer set — should not panic
	w.ClearNeedsInput("sess-1")

	if len(store.needsInputCalls) != 1 {
		t.Fatalf("expected 1 SetNeedsInput call, got %d", len(store.needsInputCalls))
	}
}
