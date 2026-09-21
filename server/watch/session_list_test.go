package watch

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/pockode/server/process"
	"github.com/pockode/server/session"
	"github.com/pockode/server/work"
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
	w := NewSessionListWatcher(store, nil)

	snapshot, err := w.Subscribe("client-1", nil, SessionListFilter{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	sessions := snapshot.Sessions

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
	w := NewSessionListWatcher(store, nil)

	w.Subscribe("client-1", nil, SessionListFilter{})

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
	w := NewSessionListWatcher(store, nil)

	// Should not panic
	w.OnSessionChange(session.SessionChangeEvent{
		Op:      session.OperationCreate,
		Session: session.SessionMeta{ID: "sess-1"},
	})
}

func TestSessionListWatcher_ListenerRegistered(t *testing.T) {
	store := &mockSessionStore{}
	w := NewSessionListWatcher(store, nil)

	if !store.hasListener(w) {
		t.Error("expected watcher to be registered as listener")
	}
}

func TestSessionListWatcher_OnSessionChange_AfterStop(t *testing.T) {
	store := &mockSessionStore{}
	w := NewSessionListWatcher(store, nil)
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
	w := NewSessionListWatcher(store, nil)

	_, err := w.Subscribe("client-1", nil, SessionListFilter{})
	if err == nil {
		t.Error("expected error")
	}

	if w.HasSubscriptions() {
		t.Error("expected no subscriptions after error")
	}
}

func TestSessionListWatcher_HandleProcessStateChange_NoSubscribers(t *testing.T) {
	store := &mockSessionStore{}
	w := NewSessionListWatcher(store, nil)

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
	w := NewSessionListWatcher(store, nil)

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
			w := NewSessionListWatcher(store, nil)

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
		eventCh:     make(chan sessionListEvent, 1),
		works:       newSessionWorkIndex(nil),
	}
	store.AddOnChangeListener(w)

	notifier := &captureNotifier{}
	w.Subscribe("client-1", notifier, SessionListFilter{})

	// Simulate the dirty flag being set (as if events were dropped)
	w.dirty.Store(true)

	w.Start()
	defer w.Stop()

	// Send a single event — eventLoop sees dirty=true and sends sync instead
	w.eventCh <- sessionListEvent{session: &session.SessionChangeEvent{
		Op:      session.OperationUpdate,
		Session: session.SessionMeta{ID: "sess-1"},
	}}

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
	w := NewSessionListWatcher(store, nil)
	notifier := &captureNotifier{}
	if _, err := w.Subscribe("client-1", notifier, SessionListFilter{}); err != nil {
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
			Blockers: []session.Blocker{{Kind: session.BlockerPermission, RequestID: "req-1", RaisedAt: raised}},
			Since:    raised,
		},
	}
	store := &mockSessionStore{sessions: []session.SessionMeta{blocked}}
	w := NewSessionListWatcher(store, nil)
	notifier := &captureNotifier{}
	if _, err := w.Subscribe("client-1", notifier, SessionListFilter{}); err != nil {
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

// stubWorkSource is the work index as the session list reads it: session id →
// work id, and nothing else.
type stubWorkSource struct {
	works   []work.Work
	listErr error
}

func (s *stubWorkSource) List() ([]work.Work, error) {
	if s.listErr != nil {
		return nil, s.listErr
	}
	return s.works, nil
}

func (s *stubWorkSource) FindBySessionID(sessionID string) (work.Work, bool, error) {
	for _, w := range s.works {
		if w.SessionID == sessionID {
			return w, true, nil
		}
	}
	return work.Work{}, false, nil
}

// failingWorkSource fails the lookup for one session, which is the read a
// notification for that session depends on. Fixed at construction: the watcher
// reads it from its own goroutine.
type failingWorkSource struct {
	*stubWorkSource
	failFor string
}

func (f *failingWorkSource) FindBySessionID(sessionID string) (work.Work, bool, error) {
	if sessionID == f.failFor {
		return work.Work{}, false, errors.New("index unreadable")
	}
	return f.stubWorkSource.FindBySessionID(sessionID)
}

func sessionsWithOneWorkSession() (*mockSessionStore, *stubWorkSource) {
	store := &mockSessionStore{
		sessions: []session.SessionMeta{
			{ID: "sess-chat", Title: "Chat"},
			{ID: "sess-work", Title: "Work"},
		},
	}
	works := &stubWorkSource{
		works: []work.Work{{ID: "work-1", SessionID: "sess-work"}},
	}
	return store, works
}

// A row says which work item its session runs. That is what a client used to
// need the whole work list to find out, which is why it could not be right
// until the whole of that list had arrived.
func TestSessionListWatcher_Subscribe_RowsCarryTheirWorkID(t *testing.T) {
	store, works := sessionsWithOneWorkSession()
	w := NewSessionListWatcher(store, works)

	snapshot, err := w.Subscribe("client-1", nil, SessionListFilter{})
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	items := snapshot.Sessions

	byID := map[string]string{}
	for _, item := range items {
		byID[item.ID] = item.WorkID
	}
	if byID["sess-work"] != "work-1" {
		t.Errorf("work session's row work_id = %q, want %q", byID["sess-work"], "work-1")
	}
	if byID["sess-chat"] != "" {
		t.Errorf("plain chat session's row carries work_id %q, want none", byID["sess-chat"])
	}
}

func TestSessionListWatcher_Subscribe_ExcludeWorkSessions(t *testing.T) {
	store, works := sessionsWithOneWorkSession()
	w := NewSessionListWatcher(store, works)

	snapshot, err := w.Subscribe("client-1", nil, SessionListFilter{ExcludeWorkSessions: true})
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	items := snapshot.Sessions

	if len(items) != 1 || items[0].ID != "sess-chat" {
		t.Fatalf("expected only the plain chat session, got %+v", items)
	}
}

// The filter is refused rather than half-applied: a work index that cannot be
// read is not the same as a project with no work in it, and answering as if it
// were would show the user every task session at once.
func TestSessionListWatcher_Subscribe_WorkIndexError(t *testing.T) {
	store, works := sessionsWithOneWorkSession()
	works.listErr = errors.New("index unreadable")
	w := NewSessionListWatcher(store, works)

	if _, err := w.Subscribe("client-1", nil, SessionListFilter{ExcludeWorkSessions: true}); err == nil {
		t.Error("expected an error")
	}
	if w.HasSubscriptions() {
		t.Error("expected no subscription left behind after the error")
	}
}

// Two subscribers of the same list, one of which asked not to see work
// sessions: the row is news to one and must not exist for the other.
func TestSessionListWatcher_Change_IsFilteredPerSubscriber(t *testing.T) {
	store, works := sessionsWithOneWorkSession()
	w := NewSessionListWatcher(store, works)
	all := &captureNotifier{}
	plain := &captureNotifier{}
	if _, err := w.Subscribe("all", all, SessionListFilter{}); err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	if _, err := w.Subscribe("plain", plain, SessionListFilter{ExcludeWorkSessions: true}); err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	w.Start()
	defer w.Stop()

	w.OnSessionChange(session.SessionChangeEvent{
		Op:      session.OperationUpdate,
		Session: session.SessionMeta{ID: "sess-work", Title: "Work"},
	})

	waitFor(t, func() bool { return all.count() >= 1 && plain.count() >= 1 })

	var kept sessionListChangedParams
	if err := json.Unmarshal(all.last(), &kept); err != nil {
		t.Fatalf("unmarshal params: %v", err)
	}
	if kept.Session == nil || kept.Session.WorkID != "work-1" {
		t.Errorf("unfiltered subscriber got %+v, want the row with its work id", kept)
	}

	var dropped sessionListChangedParams
	if err := json.Unmarshal(plain.last(), &dropped); err != nil {
		t.Fatalf("unmarshal params: %v", err)
	}
	if dropped.Operation != string(session.OperationDelete) || dropped.SessionID != "sess-work" {
		t.Errorf("filtering subscriber got %+v, want the row retracted", dropped)
	}
}

// A work item changing is the only thing that can put a work id on a row: the
// session itself does not move when the relation does.
func TestSessionListWatcher_HandleWorkChange_PushesTheSessionsRow(t *testing.T) {
	store, works := sessionsWithOneWorkSession()
	w := NewSessionListWatcher(store, works)
	notifier := &captureNotifier{}
	if _, err := w.Subscribe("client-1", notifier, SessionListFilter{}); err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	w.Start()
	defer w.Stop()

	w.HandleWorkChange(work.ChangeEvent{
		Op:   work.OperationUpdate,
		Work: work.Work{ID: "work-1", SessionID: "sess-work"},
	})

	waitFor(t, func() bool { return notifier.count() >= 1 })

	var params sessionListChangedParams
	if err := json.Unmarshal(notifier.last(), &params); err != nil {
		t.Fatalf("unmarshal params: %v", err)
	}
	if params.Session == nil || params.Session.ID != "sess-work" {
		t.Fatalf("expected the work's session row, got %+v", params)
	}
	if params.Session.WorkID != "work-1" {
		t.Errorf("row work_id = %q, want %q", params.Session.WorkID, "work-1")
	}
}

// A deleted work leaves its session — for as long as it is still there — a
// plain chat session, so the row is rebuilt from the store rather than from the
// event, which still carries the relation as it was.
func TestSessionListWatcher_HandleWorkChange_DeleteClearsTheRowsWorkID(t *testing.T) {
	store, works := sessionsWithOneWorkSession()
	w := NewSessionListWatcher(store, works)
	notifier := &captureNotifier{}
	if _, err := w.Subscribe("client-1", notifier, SessionListFilter{}); err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	w.Start()
	defer w.Stop()

	deleted := works.works[0]
	works.works = nil

	w.HandleWorkChange(work.ChangeEvent{Op: work.OperationDelete, Work: deleted})

	waitFor(t, func() bool { return notifier.count() >= 1 })

	var params sessionListChangedParams
	if err := json.Unmarshal(notifier.last(), &params); err != nil {
		t.Fatalf("unmarshal params: %v", err)
	}
	if params.Session == nil || params.Session.WorkID != "" {
		t.Errorf("expected a row with no work id, got %+v", params.Session)
	}
}

// A work is given its session id before that session exists: the claim happens
// first, the session is created after. There is no row to push yet, and the
// session's own create event carries the relation.
func TestSessionListWatcher_HandleWorkChange_IgnoresWorkWithoutASession(t *testing.T) {
	for _, event := range []work.ChangeEvent{
		{Op: work.OperationCreate, Work: work.Work{ID: "work-2"}},
		{Op: work.OperationUpdate, Work: work.Work{ID: "work-3", SessionID: "sess-missing"}},
	} {
		store, works := sessionsWithOneWorkSession()
		w := NewSessionListWatcher(store, works)
		notifier := &captureNotifier{}
		if _, err := w.Subscribe("client-1", notifier, SessionListFilter{}); err != nil {
			t.Fatalf("subscribe: %v", err)
		}
		w.Start()

		w.HandleWorkChange(event)
		// Nothing arrives for the event above, so a second event that does notify
		// is what says the first has been handled — the loop takes them in order.
		w.OnSessionChange(session.SessionChangeEvent{
			Op:      session.OperationUpdate,
			Session: session.SessionMeta{ID: "sess-chat"},
		})

		waitFor(t, func() bool { return notifier.count() >= 1 })
		if notifier.count() != 1 {
			t.Errorf("work %+v notified a row of its own: %s", event.Work, notifier.last())
		}
		w.Stop()
	}
}

func TestSessionListWatcher_Sync_IsFilteredPerSubscriber(t *testing.T) {
	store, works := sessionsWithOneWorkSession()
	w := &SessionListWatcher{
		BaseWatcher: NewBaseWatcher(),
		store:       store,
		works:       newSessionWorkIndex(works),
		eventCh:     make(chan sessionListEvent, 1),
	}
	store.AddOnChangeListener(w)

	all := &captureNotifier{}
	plain := &captureNotifier{}
	w.Subscribe("all", all, SessionListFilter{})
	w.Subscribe("plain", plain, SessionListFilter{ExcludeWorkSessions: true})

	w.dirty.Store(true)
	w.Start()
	defer w.Stop()

	w.eventCh <- sessionListEvent{session: &session.SessionChangeEvent{
		Op:      session.OperationUpdate,
		Session: session.SessionMeta{ID: "sess-chat"},
	}}

	waitFor(t, func() bool { return all.count() >= 1 && plain.count() >= 1 })

	var full, filtered sessionListSyncParams
	if err := json.Unmarshal(all.last(), &full); err != nil {
		t.Fatalf("unmarshal sync params: %v", err)
	}
	if err := json.Unmarshal(plain.last(), &filtered); err != nil {
		t.Fatalf("unmarshal sync params: %v", err)
	}
	if len(full.Sessions) != 2 {
		t.Errorf("unfiltered sync carried %d sessions, want 2", len(full.Sessions))
	}
	if len(filtered.Sessions) != 1 || filtered.Sessions[0].ID != "sess-chat" {
		t.Errorf("filtered sync carried %+v, want only the plain chat session", filtered.Sessions)
	}
}

// A work index that cannot be read is not news about the session, and there is
// nothing truthful to say about it: answering "belongs to no work" would put a
// task session into the list of every subscriber that asked not to see one.
func TestSessionListWatcher_Change_SkipsWhenTheWorkIndexCannotBeRead(t *testing.T) {
	store, works := sessionsWithOneWorkSession()
	failing := &failingWorkSource{stubWorkSource: works, failFor: "sess-work"}
	w := NewSessionListWatcher(store, failing)
	notifier := &captureNotifier{}
	if _, err := w.Subscribe("client-1", notifier, SessionListFilter{ExcludeWorkSessions: true}); err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	w.Start()
	defer w.Stop()

	w.OnSessionChange(session.SessionChangeEvent{
		Op:      session.OperationUpdate,
		Session: session.SessionMeta{ID: "sess-work", Title: "Work"},
	})
	// Nothing arrives for that one, so an event whose lookup works is the barrier
	// saying it has been handled — the loop takes them in order.
	w.OnSessionChange(session.SessionChangeEvent{
		Op:      session.OperationUpdate,
		Session: session.SessionMeta{ID: "sess-chat", Title: "Chat"},
	})

	waitFor(t, func() bool { return notifier.count() >= 1 })

	var params sessionListChangedParams
	if err := json.Unmarshal(notifier.last(), &params); err != nil {
		t.Fatalf("unmarshal params: %v", err)
	}
	if notifier.count() != 1 || params.Session == nil || params.Session.ID != "sess-chat" {
		t.Errorf("the unreadable lookup put something on the wire: %d notifications, all %s",
			notifier.count(), notifier.all())
	}
}

// A running work session is touched several times a turn. The first push tells
// a filtering subscriber to drop the row in case it still has one; the rest
// cannot put back a row that has already gone, so they are not sent at all —
// while the subscriber that wants those rows keeps getting every one of them.
func TestSessionListWatcher_Change_RetractsAWorkSessionOnce(t *testing.T) {
	store, works := sessionsWithOneWorkSession()
	w := NewSessionListWatcher(store, works)
	all := &captureNotifier{}
	plain := &captureNotifier{}
	if _, err := w.Subscribe("all", all, SessionListFilter{}); err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	if _, err := w.Subscribe("plain", plain, SessionListFilter{ExcludeWorkSessions: true}); err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	w.Start()
	defer w.Stop()

	for range 3 {
		w.OnSessionChange(session.SessionChangeEvent{
			Op:      session.OperationUpdate,
			Session: session.SessionMeta{ID: "sess-work", Title: "Work"},
		})
	}

	waitFor(t, func() bool { return all.count() >= 3 })

	if got := plain.count(); got != 1 {
		t.Errorf("filtering subscriber was sent %d notifications, want 1: %s", got, plain.all())
	}
	if got := all.count(); got != 3 {
		t.Errorf("unfiltered subscriber was sent %d notifications, want 3", got)
	}
}
