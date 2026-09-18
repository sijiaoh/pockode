package watch

import (
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/pockode/server/session"
	"github.com/pockode/server/work"
)

// manySessions builds n sessions in the order FileStore.List returns them:
// newest first, which is what the watcher's paging is cut along.
func manySessions(n int) *mockSessionStore {
	at := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	sessions := make([]session.SessionMeta, 0, n)
	for i := range n {
		sessions = append(sessions, session.SessionMeta{
			ID:        fmt.Sprintf("sess-%03d", i),
			Title:     fmt.Sprintf("Session %d", i),
			UpdatedAt: at.Add(-time.Duration(i) * time.Minute),
		})
	}
	return &mockSessionStore{sessions: sessions}
}

func TestSessionListWatcher_Subscribe_ReturnsOnePage(t *testing.T) {
	w := NewSessionListWatcher(manySessions(session.DefaultListPageSize+5), nil)

	snapshot, err := w.Subscribe("client-1", nil, SessionListFilter{})
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}

	if len(snapshot.Sessions) != session.DefaultListPageSize {
		t.Errorf("snapshot carried %d rows, want one page of %d", len(snapshot.Sessions), session.DefaultListPageSize)
	}
	if !snapshot.HasMore || snapshot.NextCursor == "" {
		t.Errorf("snapshot says hasMore=%v cursor=%q, want a cursor onto the rest", snapshot.HasMore, snapshot.NextCursor)
	}
}

// A list that fits in one page says so, and says it without a cursor: "there is
// no next page" is one value on the wire, not two.
func TestSessionListWatcher_Subscribe_ShortListHasNoCursor(t *testing.T) {
	w := NewSessionListWatcher(manySessions(3), nil)

	snapshot, err := w.Subscribe("client-1", nil, SessionListFilter{})
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}

	if snapshot.HasMore || snapshot.NextCursor != "" {
		t.Errorf("hasMore=%v cursor=%q, want neither", snapshot.HasMore, snapshot.NextCursor)
	}
}

func TestSessionListWatcher_Page_ContinuesFromTheSnapshot(t *testing.T) {
	w := NewSessionListWatcher(manySessions(session.DefaultListPageSize+5), nil)

	snapshot, err := w.Subscribe("client-1", nil, SessionListFilter{})
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}

	page, err := w.Page("client-1", snapshot.NextCursor, 0)
	if err != nil {
		t.Fatalf("page: %v", err)
	}

	if len(page.Sessions) != 5 {
		t.Fatalf("second page carried %d rows, want the remaining 5", len(page.Sessions))
	}
	if want := fmt.Sprintf("sess-%03d", session.DefaultListPageSize); page.Sessions[0].ID != want {
		t.Errorf("second page starts at %q, want the row after the snapshot's last", page.Sessions[0].ID)
	}
	if page.HasMore || page.NextCursor != "" {
		t.Errorf("last page says hasMore=%v cursor=%q, want neither", page.HasMore, page.NextCursor)
	}
}

// A page is cut after the filter, not before it: cut first, a page of 30 would
// arrive as however many of those 30 were not work sessions.
func TestSessionListWatcher_Page_IsCutAfterTheFilter(t *testing.T) {
	store := manySessions(session.DefaultListPageSize*2 + 10)
	works := &stubWorkSource{}
	for i := range session.DefaultListPageSize {
		if i%2 == 0 {
			works.works = append(works.works, work.Work{
				ID:        fmt.Sprintf("work-%d", i),
				SessionID: fmt.Sprintf("sess-%03d", i),
			})
		}
	}
	w := NewSessionListWatcher(store, works)

	snapshot, err := w.Subscribe("client-1", nil, SessionListFilter{ExcludeWorkSessions: true})
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}

	if len(snapshot.Sessions) != session.DefaultListPageSize {
		t.Errorf("filtered snapshot carried %d rows, want a full page of %d",
			len(snapshot.Sessions), session.DefaultListPageSize)
	}
	for _, row := range snapshot.Sessions {
		if row.WorkID != "" {
			t.Fatalf("filtered page carries the work session %q", row.ID)
		}
	}
}

// The page is the subscription's, so it cannot disagree with the snapshot about
// what belongs in the list — and a subscription that is not open has no list.
func TestSessionListWatcher_Page_RefusesAnUnknownSubscription(t *testing.T) {
	w := NewSessionListWatcher(manySessions(3), nil)

	if _, err := w.Page("never-subscribed", "", 0); !errors.Is(err, ErrSubscriptionNotFound) {
		t.Errorf("err = %v, want ErrSubscriptionNotFound", err)
	}
}

func TestSessionListWatcher_Page_RefusesAMalformedCursor(t *testing.T) {
	w := NewSessionListWatcher(manySessions(3), nil)
	if _, err := w.Subscribe("client-1", nil, SessionListFilter{}); err != nil {
		t.Fatalf("subscribe: %v", err)
	}

	if _, err := w.Page("client-1", "not-a-cursor", 0); !errors.Is(err, session.ErrInvalidListCursor) {
		t.Errorf("err = %v, want ErrInvalidListCursor", err)
	}
}

// A resync replaces the whole list, so it has to hand back what the reader had:
// a first page would strand someone five pages down past the end of a list that
// just got shorter under them (docs/list-paging-ui.md §3.4).
func TestSessionListWatcher_Sync_RestoresWhatTheSubscriberHadLoaded(t *testing.T) {
	store := manySessions(session.MaxListPageSize + 50)
	w := &SessionListWatcher{
		BaseWatcher: NewBaseWatcher(),
		store:       store,
		works:       newSessionWorkIndex(nil),
		eventCh:     make(chan sessionListEvent, 1),
	}
	store.AddOnChangeListener(w)

	deep := &captureNotifier{}
	shallow := &captureNotifier{}
	snapshot, err := w.Subscribe("deep", deep, SessionListFilter{})
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	if _, err := w.Subscribe("shallow", shallow, SessionListFilter{}); err != nil {
		t.Fatalf("subscribe: %v", err)
	}

	cursor := snapshot.NextCursor
	for range 2 {
		page, err := w.Page("deep", cursor, 0)
		if err != nil {
			t.Fatalf("page: %v", err)
		}
		cursor = page.NextCursor
	}

	w.dirty.Store(true)
	w.Start()
	defer w.Stop()
	w.eventCh <- sessionListEvent{session: &session.SessionChangeEvent{
		Op:      session.OperationUpdate,
		Session: session.SessionMeta{ID: "sess-000"},
	}}

	waitFor(t, func() bool { return deep.count() >= 1 && shallow.count() >= 1 })

	var deepSync, shallowSync sessionListSyncParams
	if err := json.Unmarshal(deep.last(), &deepSync); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if err := json.Unmarshal(shallow.last(), &shallowSync); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if want := session.DefaultListPageSize * 3; len(deepSync.Sessions) != want {
		t.Errorf("deep subscriber got %d rows back, want the %d it had", len(deepSync.Sessions), want)
	}
	if want := session.DefaultListPageSize; len(shallowSync.Sessions) != want {
		t.Errorf("shallow subscriber got %d rows back, want the %d it had", len(shallowSync.Sessions), want)
	}
	if !deepSync.HasMore || deepSync.NextCursor == "" {
		t.Error("a resync that does not reach the end of the list must still say where it stopped")
	}
}

// Past the cap, the reader is put back at the top rather than handed 150+ rows:
// a client that needs that to recover is being handed back the problem paging
// exists to remove.
func TestSessionListWatcher_Sync_CapsWhatItRestores(t *testing.T) {
	store := manySessions(session.MaxListPageSize + 100)
	w := &SessionListWatcher{
		BaseWatcher: NewBaseWatcher(),
		store:       store,
		works:       newSessionWorkIndex(nil),
		eventCh:     make(chan sessionListEvent, 1),
	}
	store.AddOnChangeListener(w)

	notifier := &captureNotifier{}
	snapshot, err := w.Subscribe("client-1", notifier, SessionListFilter{})
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	cursor := snapshot.NextCursor
	for range session.ListResyncPageCap + 1 {
		page, err := w.Page("client-1", cursor, 0)
		if err != nil {
			t.Fatalf("page: %v", err)
		}
		cursor = page.NextCursor
	}

	w.dirty.Store(true)
	w.Start()
	defer w.Stop()
	w.eventCh <- sessionListEvent{session: &session.SessionChangeEvent{
		Op:      session.OperationUpdate,
		Session: session.SessionMeta{ID: "sess-000"},
	}}

	waitFor(t, func() bool { return notifier.count() >= 1 })

	var sync sessionListSyncParams
	if err := json.Unmarshal(notifier.last(), &sync); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(sync.Sessions) != session.MaxListPageSize {
		t.Errorf("resync carried %d rows, want it capped at %d", len(sync.Sessions), session.MaxListPageSize)
	}
}

// The sidebar's unread badge is an "is there any" over the whole list, and a
// page cannot answer that: an unread session is one an agent finished with
// while nobody was looking, which is exactly the session nobody has scrolled to
// (docs/list-paging-ui.md §2.1).
func TestSessionListWatcher_UnreadIsOverTheWholeListNotThePage(t *testing.T) {
	store := manySessions(session.DefaultListPageSize + 5)
	store.sessions[len(store.sessions)-1].Unread = true
	w := NewSessionListWatcher(store, nil)

	snapshot, err := w.Subscribe("client-1", nil, SessionListFilter{})
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}

	for _, row := range snapshot.Sessions {
		if row.Unread {
			t.Fatal("the unread session is inside the first page; the test proves nothing")
		}
	}
	if !snapshot.HasUnread {
		t.Error("snapshot says nothing is unread, but a session past the first page is")
	}
}

// Under the filter the badge answers for the list the user can see: a work
// session nobody is shown must not light it.
func TestSessionListWatcher_UnreadRespectsTheFilter(t *testing.T) {
	store, works := sessionsWithOneWorkSession()
	store.sessions[1].Unread = true // sess-work
	w := NewSessionListWatcher(store, works)

	all, err := w.Subscribe("all", nil, SessionListFilter{})
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	plain, err := w.Subscribe("plain", nil, SessionListFilter{ExcludeWorkSessions: true})
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}

	if !all.HasUnread {
		t.Error("unfiltered snapshot says nothing is unread, but the work session is")
	}
	if plain.HasUnread {
		t.Error("filtered snapshot lights the badge for a session it does not show")
	}
}

// Every notification carries the flag, because the event that makes a session
// unread is an event about a session the reader may never have loaded.
func TestSessionListWatcher_ChangeCarriesTheUnreadFlag(t *testing.T) {
	store := manySessions(2)
	w := NewSessionListWatcher(store, nil)
	notifier := &captureNotifier{}
	if _, err := w.Subscribe("client-1", notifier, SessionListFilter{}); err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	w.Start()
	defer w.Stop()

	store.sessions[1].Unread = true
	w.OnSessionChange(session.SessionChangeEvent{
		Op:      session.OperationUpdate,
		Session: store.sessions[1],
	})

	waitFor(t, func() bool { return notifier.count() >= 1 })

	var params sessionListChangedParams
	if err := json.Unmarshal(notifier.last(), &params); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if params.HasUnread == nil || !*params.HasUnread {
		t.Errorf("has_unread = %v, want true", params.HasUnread)
	}
}
