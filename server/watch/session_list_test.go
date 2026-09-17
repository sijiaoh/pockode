package watch

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/pockode/server/process"
	"github.com/pockode/server/session"
)

type mockSessionStore struct {
	sessions  []session.SessionMeta
	listeners []session.OnChangeListener
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

func (m *mockSessionStore) Create(ctx context.Context, sessionID string, spec session.CreateSpec) (session.SessionMeta, error) {
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

func (m *mockSessionStore) AppendToHistory(ctx context.Context, sessionID string, record any) (session.HistorySeq, error) {
	return session.NoHistorySeq, nil
}

func (m *mockSessionStore) CreateFork(ctx context.Context, sessionID string, fork session.ForkSpec) (session.SessionMeta, error) {
	return session.SessionMeta{}, nil
}

func (m *mockSessionStore) WriteHistory(ctx context.Context, sessionID string, records []json.RawMessage) error {
	return nil
}

func (m *mockSessionStore) Touch(ctx context.Context, sessionID string) error {
	return nil
}

func (m *mockSessionStore) SetMode(ctx context.Context, sessionID string, mode session.Mode) error {
	return nil
}

func (m *mockSessionStore) SetModel(ctx context.Context, sessionID string, model string) error {
	return nil
}

func (m *mockSessionStore) SetEffort(ctx context.Context, sessionID string, effort string) error {
	return nil
}

func (m *mockSessionStore) ApplyTurn(ctx context.Context, sessionID string, in session.TurnInput) (session.TurnTransition, error) {
	return session.TurnTransition{}, nil
}

func (m *mockSessionStore) SetUnread(ctx context.Context, sessionID string, unread bool) error {
	return nil
}

func (m *mockSessionStore) AddUsage(ctx context.Context, sessionID string, report session.UsageReport) error {
	return nil
}

func (m *mockSessionStore) AddOnChangeListener(listener session.OnChangeListener) {
	m.listeners = append(m.listeners, listener)
}

func (m *mockSessionStore) hasListener(l session.OnChangeListener) bool {
	for _, registered := range m.listeners {
		if registered == l {
			return true
		}
	}
	return false
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

	sessions, err := w.Subscribe("client-1", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if len(sessions) != 2 {
		t.Errorf("expected 2 sessions, got %d", len(sessions))
	}

	// A row carries the session's own turn, which a session nothing has run in
	// is the zero value of.
	for _, s := range sessions {
		if s.Turn.Phase != "" || s.Turn.Open {
			t.Errorf("expected an untouched turn, got %+v", s.Turn)
		}
	}

	if !w.HasSubscriptions() {
		t.Error("expected HasSubscriptions to be true")
	}
}

func TestSessionListWatcher_Unsubscribe(t *testing.T) {
	store := &mockSessionStore{}
	w := NewSessionListWatcher(store)

	w.Subscribe("client-1", nil)

	if !w.HasSubscriptions() {
		t.Error("expected HasSubscriptions to be true")
	}

	w.Unsubscribe("client-1")

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

	if !store.hasListener(w) {
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

	_, err := w.Subscribe("client-1", nil)
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

// recordingSessionStore notices any metadata write the watcher makes. Whether a
// session is waiting on the user is not one of them any more — it is derived
// from the turn state the process wrote — so what this catches is the watcher
// growing a write it should not have.
type recordingSessionStore struct {
	mockSessionStore
	turnInputs  []session.TurnInput
	unreadCalls int
}

func (r *recordingSessionStore) SetUnread(context.Context, string, bool) error {
	r.unreadCalls++
	return nil
}

func (r *recordingSessionStore) ApplyTurn(_ context.Context, _ string, in session.TurnInput) (session.TurnTransition, error) {
	r.turnInputs = append(r.turnInputs, in)
	return session.TurnTransition{}, nil
}

// The work layer is not touched from here at all any more: the engine hears a
// settled turn ending, which is the only thing about a session it acts on.
// These two lock that down from the two sides it used to be wrong on.
func TestHandleProcessStateChange_MarksUnreadAndNothingElse(t *testing.T) {
	store := &recordingSessionStore{}
	w := NewSessionListWatcher(store)

	w.HandleProcessStateChange(process.StateChangeEvent{
		SessionID: "sess-1",
		State:     process.ProcessStateIdle,
	})

	if store.unreadCalls != 1 {
		t.Errorf("marked unread %d times, want once", store.unreadCalls)
	}
	if len(store.turnInputs) != 0 {
		t.Errorf("the watcher must not write turn state; the process owns it, got %v", store.turnInputs)
	}
}

func TestHandleProcessStateChange_RunningAndEndedTouchNothing(t *testing.T) {
	for _, state := range []process.ProcessState{process.ProcessStateRunning, process.ProcessStateEnded} {
		t.Run(string(state), func(t *testing.T) {
			store := &recordingSessionStore{}
			w := NewSessionListWatcher(store)

			w.HandleProcessStateChange(process.StateChangeEvent{SessionID: "sess-1", State: state})

			if len(store.turnInputs) != 0 {
				t.Errorf("the watcher must not write turn state, got %v", store.turnInputs)
			}
			if store.unreadCalls != 0 {
				t.Errorf("only an idle process marks a session unread, got %d calls", store.unreadCalls)
			}
		})
	}
}

func TestSessionListWatcher_DirtyFlag_SyncsAfterDrop(t *testing.T) {
	store := &mockSessionStore{
		sessions: []session.SessionMeta{
			{ID: "sess-1", Title: "Session 1"},
			{ID: "sess-2", Title: "Session 2"},
		},
	}
	w := &SessionListWatcher{
		BaseWatcher: NewBaseWatcher(),
		store:       store,
		eventCh:     make(chan session.SessionChangeEvent, 1),
	}
	store.AddOnChangeListener(w)

	notifier := &captureNotifier{}
	w.Subscribe("client-1", notifier)

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

// The row's whole state is the session's turn, and the process writes that to
// the store before it sends this event — so the store's own change notification
// is what carries it. The push that used to sit at the end of this handler was
// for the volatile process state a row no longer has, and a second push of the
// same row is a second answer to "what is this session doing" arriving in an
// order nobody controls.
func TestHandleProcessStateChange_PushesNoRowOfItsOwn(t *testing.T) {
	store := &mockSessionStore{
		sessions: []session.SessionMeta{{ID: "sess-1", Title: "Session 1"}},
	}
	w := NewSessionListWatcher(store)
	notifier := &captureNotifier{}
	if _, err := w.Subscribe("client-1", notifier); err != nil {
		t.Fatalf("subscribe: %v", err)
	}

	w.HandleProcessStateChange(process.StateChangeEvent{
		SessionID: "sess-1",
		State:     process.ProcessStateRunning,
	})

	if notifier.count() != 0 {
		t.Errorf("expected no notification, got %d: %s", notifier.count(), notifier.last())
	}
}

// The other half of the same rule: the store's notification is what reaches the
// client, and the row it carries holds the turn the process just wrote.
func TestSessionListWatcher_RowCarriesTheStoredTurn(t *testing.T) {
	raised := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	blocked := session.SessionMeta{
		ID:    "sess-1",
		Title: "Session 1",
		Turn: session.TurnState{
			Phase:    session.PhaseBlocked,
			Open:     true,
			Blockers: []session.Blocker{{Kind: session.BlockerQuestion, RequestID: "req-1", RaisedAt: raised}},
			Since:    raised,
		},
	}
	store := &mockSessionStore{sessions: []session.SessionMeta{blocked}}
	w := NewSessionListWatcher(store)
	notifier := &captureNotifier{}
	if _, err := w.Subscribe("client-1", notifier); err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	w.Start()
	defer w.Stop()

	w.OnSessionChange(session.SessionChangeEvent{Op: session.OperationUpdate, Session: blocked})

	waitFor(t, func() bool { return notifier.count() >= 1 })

	var params sessionListChangedParams
	if err := json.Unmarshal(notifier.last(), &params); err != nil {
		t.Fatalf("unmarshal params: %v", err)
	}
	if params.Session == nil {
		t.Fatal("expected a row on an update notification")
	}
	if params.Session.Turn.Phase != session.PhaseBlocked {
		t.Errorf("row turn phase = %q, want blocked", params.Session.Turn.Phase)
	}
	if len(params.Session.Turn.Blockers) != 1 ||
		params.Session.Turn.Blockers[0].RequestID != "req-1" {
		t.Errorf("row lost the blocker the card is answered through: %+v", params.Session.Turn)
	}
}
