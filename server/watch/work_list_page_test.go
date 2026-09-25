package watch

import (
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/pockode/server/rpc"
	"github.com/pockode/server/session"
	"github.com/pockode/server/work"
)

func openStory(id string) work.Work {
	return work.Work{ID: id, Status: work.StatusOpen, Title: id}
}

func closedStoryWork(id string, updatedAt time.Time) work.Work {
	return work.Work{
		ID: id, Status: work.StatusClosed,
		Title: id, UpdatedAt: updatedAt,
	}
}

func TestWorkListWatcher_SubscribeCapsNotRunningAndSaysHowMuchItHeldBack(t *testing.T) {
	store := &mockWorkStore{}
	for i := range CurrentGroupCap + 3 {
		store.works = append(store.works, openStory(fmt.Sprintf("s%02d", i)))
	}
	w := NewWorkListWatcher(store, nil)

	snapshot, err := w.Subscribe("client-1", nil)
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}

	if len(snapshot.Items) != CurrentGroupCap {
		t.Errorf("sent %d rows, want the cap %d", len(snapshot.Items), CurrentGroupCap)
	}
	if snapshot.Hidden.Open != 3 {
		t.Errorf("hidden = %d, want 3", snapshot.Hidden.Open)
	}
	// The count the heading shows is rows + hidden, so it is the whole group's
	// either way (docs/list-paging-ui.md §4.1).
	if len(snapshot.Items)+snapshot.Hidden.Open != CurrentGroupCap+3 {
		t.Error("rows plus hidden must be the whole group")
	}
}

// The work whose agent is waiting on a person is the one thing the cap must
// never be able to hide: the Project tab's attention dot is an absence of a
// signal, so a hidden row would tell the user there is nothing to do
// (docs/list-paging-ui.md §2.1, check 1).
func TestWorkListWatcher_SubscribeNeverHidesWorkThatNeedsTheUser(t *testing.T) {
	store := &mockWorkStore{}
	store.works = append(store.works, work.Work{
		ID: "waiting", Status: work.StatusActive,
		Title: "waiting", SessionID: "s-waiting",
	})
	for i := range CurrentGroupCap * 2 {
		store.works = append(store.works, openStory(fmt.Sprintf("s%02d", i)))
	}
	w := NewWorkListWatcher(store, (&turnSourceStub{}).set("s-waiting", session.TurnState{
		Phase: session.PhaseBlocked, Open: true,
		Blockers: []session.Blocker{{Kind: session.BlockerPermission, RequestID: "req-1"}},
	}))

	snapshot, err := w.Subscribe("client-1", nil)
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}

	var found bool
	for _, item := range snapshot.Items {
		if item.ID == "waiting" {
			found = true
			if !item.Activity.NeedsUser() {
				t.Errorf("activity = %q, want one that needs the user", item.Activity)
			}
		}
	}
	if !found {
		t.Fatal("the work waiting on the user was capped out of the list")
	}
}

func TestWorkListWatcher_EarlierHoldsNothingBack(t *testing.T) {
	store := &mockWorkStore{}
	for i := range CurrentGroupCap + 5 {
		store.works = append(store.works, openStory(fmt.Sprintf("s%02d", i)))
	}
	w := NewWorkListWatcher(store, nil)
	if _, err := w.Subscribe("client-1", nil); err != nil {
		t.Fatalf("subscribe: %v", err)
	}

	items, err := w.Earlier("client-1")
	if err != nil {
		t.Fatalf("earlier: %v", err)
	}
	if len(items) != CurrentGroupCap+5 {
		t.Errorf("earlier returned %d rows, want the whole group %d", len(items), CurrentGroupCap+5)
	}
}

func TestWorkListWatcher_ArchivePagesClosedWorkOnly(t *testing.T) {
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	store := &mockWorkStore{works: []work.Work{
		openStory("live"),
		closedStoryWork("old", base),
		closedStoryWork("new", base.Add(time.Hour)),
	}}
	w := NewWorkListWatcher(store, nil)
	if _, err := w.Subscribe("client-1", nil); err != nil {
		t.Fatalf("subscribe: %v", err)
	}

	page, err := w.Archive("client-1", "", 1)
	if err != nil {
		t.Fatalf("archive: %v", err)
	}
	if got := ids(page.Items); fmt.Sprint(got) != fmt.Sprint([]string{"new"}) {
		t.Fatalf("page 1 = %v, want [new]", got)
	}
	if !page.HasMore || page.NextCursor == "" {
		t.Fatal("expected a second page and a cursor to reach it")
	}

	page2, err := w.Archive("client-1", page.NextCursor, 1)
	if err != nil {
		t.Fatalf("archive page 2: %v", err)
	}
	if got := ids(page2.Items); fmt.Sprint(got) != fmt.Sprint([]string{"old"}) {
		t.Errorf("page 2 = %v, want [old]", got)
	}
	if page2.HasMore || page2.NextCursor != "" {
		t.Error("the last page must not offer a next one")
	}
}

// A page asked for under an id the server has dropped is invalid params, not a
// transient failure: retrying it can only fail the same way, so the client's
// answer is to subscribe afresh.
func TestWorkListWatcher_PageRefusesAnUnknownSubscription(t *testing.T) {
	w := NewWorkListWatcher(&mockWorkStore{}, nil)

	if _, err := w.Archive("gone", "", 0); !errors.Is(err, ErrSubscriptionNotFound) {
		t.Errorf("archive error = %v, want ErrSubscriptionNotFound", err)
	}
	if _, err := w.Earlier("gone"); !errors.Is(err, ErrSubscriptionNotFound) {
		t.Errorf("earlier error = %v, want ErrSubscriptionNotFound", err)
	}
}

// Reading a page answers one client and pushes nothing, so it must not record
// those rows as sent — that would suppress the notification telling every other
// subscriber about a change this read happened to see first.
func TestWorkListWatcher_ReadingAPageDoesNotSwallowTheNextNotification(t *testing.T) {
	store := &mockWorkStore{works: []work.Work{{
		ID: "w1", Status: work.StatusActive,
		Title: "w1", SessionID: "s1",
	}}}
	turns := &turnSourceStub{}
	w := NewWorkListWatcher(store, turns)
	w.Start()
	defer w.Stop()

	notifier := &captureNotifier{}
	if _, err := w.Subscribe("client-1", notifier); err != nil {
		t.Fatalf("subscribe: %v", err)
	}

	// The change the subscriber has not been told about yet, read by a page
	// request before any notification goes out.
	running := session.TurnState{Phase: session.PhaseRunning, Open: true}
	turns.set("s1", running)
	if _, err := w.Archive("client-1", "", 0); err != nil {
		t.Fatalf("archive: %v", err)
	}

	// The push that carries it. It is deduplicated against what was last *sent*,
	// so the page read must not have counted as a send.
	w.OnSessionChange(session.SessionChangeEvent{
		Op:      session.OperationUpdate,
		Session: session.SessionMeta{ID: "s1", Turn: running},
	})
	waitForNotification(t, notifier, 1)

	var params workListChangedParams
	if err := json.Unmarshal(notifier.last(), &params); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if params.Work == nil || params.Work.Activity != work.ActivityRunning {
		t.Errorf("notification = %+v, want the running row", params.Work)
	}
}

// The sync after a dropped event is the `Current` segment, capped like any
// other, and it says how much it held back.
func TestWorkListWatcher_SyncSendsTheCappedCurrentSegment(t *testing.T) {
	store := &mockWorkStore{}
	for i := range CurrentGroupCap + 2 {
		store.works = append(store.works, openStory(fmt.Sprintf("s%02d", i)))
	}
	store.works = append(store.works, closedStoryWork("archived", time.Now()))
	w := NewWorkListWatcher(store, nil)
	w.Start()
	defer w.Stop()

	notifier := &captureNotifier{}
	if _, err := w.Subscribe("client-1", notifier); err != nil {
		t.Fatalf("subscribe: %v", err)
	}

	w.dirty.Store(true)
	w.OnWorkChange(work.ChangeEvent{Op: work.OperationUpdate, Work: store.works[0]})
	waitForNotification(t, notifier, 1)

	var params struct {
		Operation  string             `json:"operation"`
		Works      []rpc.WorkListItem `json:"works"`
		OpenHidden int                `json:"open_hidden"`
	}
	if err := json.Unmarshal(notifier.last(), &params); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if params.Operation != "sync" {
		t.Fatalf("operation = %q, want sync", params.Operation)
	}
	if len(params.Works) != CurrentGroupCap {
		t.Errorf("sync carried %d rows, want the cap %d", len(params.Works), CurrentGroupCap)
	}
	if params.OpenHidden != 2 {
		t.Errorf("hidden = %d, want 2", params.OpenHidden)
	}
	if contains(params.Works, "archived") {
		t.Error("closed work belongs to the archive, not to a sync of Current")
	}
}

func waitForNotification(t *testing.T, notifier *captureNotifier, want int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if notifier.count() >= want {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("expected %d notifications, got %d", want, notifier.count())
}
