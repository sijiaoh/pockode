package watch

import (
	"fmt"
	"testing"
	"time"

	"github.com/pockode/server/rpc"
	"github.com/pockode/server/work"
)

func row(id string, t work.WorkType, status work.WorkStatus, activity work.Activity) rpc.WorkListItem {
	return rpc.WorkListItem{ID: id, Type: t, Status: status, Activity: activity}
}

func child(id, parent string, t work.WorkType, status work.WorkStatus, activity work.Activity) rpc.WorkListItem {
	item := row(id, t, status, activity)
	item.ParentID = parent
	return item
}

func ids(items []rpc.WorkListItem) []string {
	out := make([]string, len(items))
	for i, item := range items {
		out[i] = item.ID
	}
	return out
}

func contains(items []rpc.WorkListItem, id string) bool {
	for _, item := range items {
		if item.ID == id {
			return true
		}
	}
	return false
}

// The `Current` segment carries the rows it draws and everything those rows
// make claims about — no more, and above all no less: a story's row states
// `{closed}/{total} tasks` over children that get no rows of their own
// (docs/list-paging-ui.md §2.2).
func TestCurrentSegment_CarriesWhatItsRowsSpeakFor(t *testing.T) {
	items := []rpc.WorkListItem{
		row("story", work.WorkTypeStory, work.StatusActive, work.ActivityIdle),
		child("done", "story", work.WorkTypeTask, work.StatusClosed, work.ActivityClosed),
		child("quiet", "story", work.WorkTypeTask, work.StatusActive, work.ActivityRunning),
		row("archived", work.WorkTypeStory, work.StatusClosed, work.ActivityClosed),
		child("archived-task", "archived", work.WorkTypeTask, work.StatusClosed, work.ActivityClosed),
	}

	kept, hidden := currentSegment(items, NotRunningCap)

	if hidden != 0 {
		t.Errorf("hidden = %d, want 0", hidden)
	}
	for _, id := range []string{"story", "done", "quiet"} {
		if !contains(kept, id) {
			t.Errorf("%q missing from the Current segment: %v", id, ids(kept))
		}
	}
	for _, id := range []string{"archived", "archived-task"} {
		if contains(kept, id) {
			t.Errorf("%q is closed and belongs to the archive, not to Current: %v", id, ids(kept))
		}
	}
}

// A task that left its story prints `in: <parent title>`, and can only get that
// word from the parent — even when the parent is closed and has no row here.
func TestCurrentSegment_CarriesTheParentATaskRowNames(t *testing.T) {
	items := []rpc.WorkListItem{
		row("archived", work.WorkTypeStory, work.StatusClosed, work.ActivityClosed),
		child("stuck", "archived", work.WorkTypeTask, work.StatusActive, work.ActivityNeedsMessage),
	}

	kept, _ := currentSegment(items, NotRunningCap)

	if !contains(kept, "stuck") || !contains(kept, "archived") {
		t.Errorf("a task row must arrive with its parent, got %v", ids(kept))
	}
}

// The cap takes rows off the *front* of *Not running*: that group is in
// creation order, and the end of it is the work created most recently — the
// rows a user would notice missing within the hour (docs/list-paging-ui.md
// §4.1).
func TestCurrentSegment_CapDropsTheOldestNotRunningRows(t *testing.T) {
	var items []rpc.WorkListItem
	for i := range 6 {
		items = append(items, row(fmt.Sprintf("idle-%d", i), work.WorkTypeStory, work.StatusOpen, work.ActivityOpen))
	}

	kept, hidden := currentSegment(items, 4)

	if hidden != 2 {
		t.Fatalf("hidden = %d, want 2", hidden)
	}
	if got, want := ids(kept), []string{"idle-2", "idle-3", "idle-4", "idle-5"}; fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("kept %v, want %v", got, want)
	}
}

// *Needs you* and *In progress* are never capped and never truncated: they are
// the two groups the screen exists for.
func TestCurrentSegment_CapNeverTouchesTheOtherGroups(t *testing.T) {
	items := []rpc.WorkListItem{
		row("waiting", work.WorkTypeStory, work.StatusActive, work.ActivityNeedsMessage),
		row("running", work.WorkTypeStory, work.StatusActive, work.ActivityIdle),
		row("idle-a", work.WorkTypeStory, work.StatusOpen, work.ActivityOpen),
		row("idle-b", work.WorkTypeStory, work.StatusStopped, work.ActivityStopped),
	}

	kept, hidden := currentSegment(items, 1)

	if hidden != 1 {
		t.Fatalf("hidden = %d, want 1", hidden)
	}
	for _, id := range []string{"waiting", "running", "idle-b"} {
		if !contains(kept, id) {
			t.Errorf("%q must survive the cap, got %v", id, ids(kept))
		}
	}
}

// Dropping a story drops its tasks with it, so a story whose own task is a row
// is not droppable at all — the row would go with it, and *Needs you* is never
// truncated.
func TestCurrentSegment_CapSpares_AStoryWhoseTaskIsARow(t *testing.T) {
	items := []rpc.WorkListItem{
		row("oldest", work.WorkTypeStory, work.StatusStopped, work.ActivityStopped),
		child("stuck", "oldest", work.WorkTypeTask, work.StatusActive, work.ActivityNeedsAnswer),
		row("newer", work.WorkTypeStory, work.StatusOpen, work.ActivityOpen),
	}

	kept, hidden := currentSegment(items, 1)

	if hidden != 1 {
		t.Fatalf("hidden = %d, want 1", hidden)
	}
	if !contains(kept, "oldest") || !contains(kept, "stuck") {
		t.Errorf("a story holding a row must survive the cap, got %v", ids(kept))
	}
	if contains(kept, "newer") {
		t.Errorf("the droppable story should have gone instead, got %v", ids(kept))
	}
}

// A cap of zero holds nothing back, which is what "Show earlier work" asks for.
func TestCurrentSegment_NoCapHoldsNothingBack(t *testing.T) {
	var items []rpc.WorkListItem
	for i := range 80 {
		items = append(items, row(fmt.Sprintf("idle-%d", i), work.WorkTypeStory, work.StatusOpen, work.ActivityOpen))
	}

	kept, hidden := currentSegment(items, 0)

	if hidden != 0 || len(kept) != 80 {
		t.Errorf("uncapped segment = %d rows, hidden %d; want 80 and 0", len(kept), hidden)
	}
}

// A status this build does not know must not be one more way for a work item to
// disappear: it keeps its row, and the cap — which counts groups it can name —
// never reaches it.
func TestCurrentSegment_KeepsAnUnrecognisedStatus(t *testing.T) {
	items := []rpc.WorkListItem{
		row("odd", work.WorkTypeStory, work.WorkStatus("wedged"), work.ActivityIdle),
		row("idle", work.WorkTypeStory, work.StatusOpen, work.ActivityOpen),
	}

	kept, hidden := currentSegment(items, 1)

	if hidden != 0 {
		t.Errorf("hidden = %d, want 0: only recognised groups are capped", hidden)
	}
	if !contains(kept, "odd") {
		t.Errorf("an unrecognised status must keep its row, got %v", ids(kept))
	}
}

func closedStory(id string, updatedAt time.Time) rpc.WorkListItem {
	item := row(id, work.WorkTypeStory, work.StatusClosed, work.ActivityClosed)
	item.UpdatedAt = updatedAt
	return item
}

// The archive is the closed stories, newest first, cut into pages — and a page
// arrives with the tasks its rows speak for.
func TestArchiveSegment_PagesNewestFirstWithTheTasksItsRowsSpeakFor(t *testing.T) {
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	items := []rpc.WorkListItem{
		closedStory("old", base),
		closedStory("mid", base.Add(time.Hour)),
		closedStory("new", base.Add(2*time.Hour)),
		child("new-task", "new", work.WorkTypeTask, work.StatusClosed, work.ActivityClosed),
		row("open", work.WorkTypeStory, work.StatusOpen, work.ActivityOpen),
	}

	page, next, hasMore, err := archiveSegment(items, "", 2)
	if err != nil {
		t.Fatalf("archiveSegment: %v", err)
	}
	if got, want := ids(page), []string{"new", "mid", "new-task"}; fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("page 1 = %v, want %v", got, want)
	}
	if !hasMore {
		t.Fatal("expected a second page")
	}

	page2, _, hasMore2, err := archiveSegment(items, next.String(), 2)
	if err != nil {
		t.Fatalf("archiveSegment page 2: %v", err)
	}
	if got, want := ids(page2), []string{"old"}; fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("page 2 = %v, want %v", got, want)
	}
	if hasMore2 {
		t.Error("expected page 2 to be the last")
	}
}

// Walking back is the client handing back a cursor it already used, which is
// what lets the server stay one-directional and the pager say `Page 2` rather
// than `Page 2 of 7`.
func TestArchiveSegment_AUsedCursorWalksBackToTheSamePage(t *testing.T) {
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	var items []rpc.WorkListItem
	for i := range 5 {
		items = append(items, closedStory(fmt.Sprintf("s%d", i), base.Add(time.Duration(i)*time.Hour)))
	}

	first, next, _, err := archiveSegment(items, "", 2)
	if err != nil {
		t.Fatalf("archiveSegment: %v", err)
	}
	if _, _, _, err := archiveSegment(items, next.String(), 2); err != nil {
		t.Fatalf("archiveSegment page 2: %v", err)
	}
	again, _, _, err := archiveSegment(items, "", 2)
	if err != nil {
		t.Fatalf("archiveSegment back to page 1: %v", err)
	}
	if fmt.Sprint(ids(again)) != fmt.Sprint(ids(first)) {
		t.Errorf("page 1 revisited = %v, want %v", ids(again), ids(first))
	}
}

func TestClampArchiveLimit(t *testing.T) {
	if got, _ := clampArchiveLimit(0); got != ArchivePageSize {
		t.Errorf("zero limit = %d, want the default %d", got, ArchivePageSize)
	}
	if _, err := clampArchiveLimit(-1); err == nil {
		t.Error("a negative limit is the caller's mistake and must be refused")
	}
	if got, _ := clampArchiveLimit(1 << 20); got <= 0 || got > 1<<20 {
		t.Errorf("an oversized limit must be clamped, got %d", got)
	}
}
