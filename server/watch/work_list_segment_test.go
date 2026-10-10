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

// updated stamps a row, for the tests about which end of a group the cap eats.
func updated(item rpc.WorkListItem, at time.Time) rpc.WorkListItem {
	item.UpdatedAt = at
	return item
}

func child(id, parent string, t work.WorkType, status work.WorkStatus, activity work.Activity) rpc.WorkListItem {
	item := row(id, t, status, activity)
	item.StoryID = parent
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

	kept, hidden := currentSegment(items, CurrentGroupCap)

	if hidden != (CurrentHidden{}) {
		t.Errorf("hidden = %+v, want nothing held back", hidden)
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

// A task is never a row, however much it needs a person: it travels with its
// story's row, for the roll-up there, and with nothing else. A story that has no
// row here takes its tasks with it — a closed one into the archive, a capped one
// behind "Show earlier work".
func TestCurrentSegment_ATaskGoesOnlyWithItsStorysRow(t *testing.T) {
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	asking := child("asking", "live", work.WorkTypeTask, work.StatusActive, work.ActivityRunning)
	asking.UnansweredQuestions = 1
	items := []rpc.WorkListItem{
		updated(row("live", work.WorkTypeStory, work.StatusActive, work.ActivityRunning), base),
		asking,
		updated(child("stopped", "live", work.WorkTypeTask, work.StatusStopped, work.ActivityStopped), base),
		row("archived", work.WorkTypeStory, work.StatusClosed, work.ActivityClosed),
		child("stuck", "archived", work.WorkTypeTask, work.StatusActive, work.ActivityNeedsPermission),
		updated(row("old-stopped", work.WorkTypeStory, work.StatusStopped, work.ActivityStopped), base),
		updated(child("old-stuck", "old-stopped", work.WorkTypeTask, work.StatusActive, work.ActivityNeedsPermission), base),
		updated(row("new-stopped", work.WorkTypeStory, work.StatusStopped, work.ActivityStopped), base.Add(time.Hour)),
	}

	for _, item := range items {
		if item.Type == work.WorkTypeTask && hasCurrentRow(item) {
			t.Errorf("task %q draws a row of its own", item.ID)
		}
	}

	kept, hidden := currentSegment(items, 1)

	// The stopped task does not count towards *Stopped*: only the two stopped
	// stories do, and the older one is the one that goes.
	if hidden.Stopped != 1 {
		t.Fatalf("stopped hidden = %d, want 1", hidden.Stopped)
	}
	for _, id := range []string{"live", "asking", "stopped", "new-stopped"} {
		if !contains(kept, id) {
			t.Errorf("%q missing from the Current segment: %v", id, ids(kept))
		}
	}
	for _, id := range []string{"archived", "stuck", "old-stopped", "old-stuck"} {
		if contains(kept, id) {
			t.Errorf("%q has no story row here and must not be sent: %v", id, ids(kept))
		}
	}
}

// The cap eats the bottom of the group as the user sees it: rows are listed
// `updated_at` newest first, so what goes is what was touched longest ago —
// never the story somebody edited this morning, whenever it happened to be
// created (docs/list-paging-ui.md §4.1, docs/project-ui.md §2.3).
func TestCurrentSegment_CapDropsTheLeastRecentlyUpdated(t *testing.T) {
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	// Created oldest first, touched in the opposite order: under the creation
	// order this used to drop by, exactly the wrong two would go.
	var items []rpc.WorkListItem
	for i := range 6 {
		items = append(items, updated(
			row(fmt.Sprintf("idle-%d", i), work.WorkTypeStory, work.StatusOpen, work.ActivityOpen),
			base.Add(time.Duration(6-i)*time.Hour),
		))
	}

	kept, hidden := currentSegment(items, 4)

	if hidden.Open != 2 {
		t.Fatalf("open hidden = %d, want 2", hidden.Open)
	}
	if got, want := ids(kept), []string{"idle-0", "idle-1", "idle-2", "idle-3"}; fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("kept %v, want %v", got, want)
	}
}

// The two capped groups are capped apart: each has its own allowance and its
// own hidden count, because each is one heading on screen and a heading's count
// is the rows it received plus the rows held back from *it*.
func TestCurrentSegment_CapsEachGroupOnItsOwn(t *testing.T) {
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	var items []rpc.WorkListItem
	for i := range 4 {
		items = append(items, updated(
			row(fmt.Sprintf("stopped-%d", i), work.WorkTypeStory, work.StatusStopped, work.ActivityStopped),
			base.Add(time.Duration(i)*time.Hour),
		))
	}
	for i := range 3 {
		items = append(items, updated(
			row(fmt.Sprintf("open-%d", i), work.WorkTypeStory, work.StatusOpen, work.ActivityOpen),
			base.Add(time.Duration(i)*time.Hour),
		))
	}

	kept, hidden := currentSegment(items, 2)

	if hidden.Stopped != 2 || hidden.Open != 1 {
		t.Fatalf("hidden = %+v, want 2 stopped and 1 open", hidden)
	}
	if got, want := ids(kept), []string{"stopped-2", "stopped-3", "open-1", "open-2"}; fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("kept %v, want %v", got, want)
	}
}

// *Needs you* and *In progress* are never capped and never truncated: they are
// the two groups the screen exists for. Two rows in each against a cap of one,
// so a cap that reached them would have to drop one of each.
func TestCurrentSegment_CapNeverTouchesTheOtherGroups(t *testing.T) {
	items := []rpc.WorkListItem{
		row("waiting", work.WorkTypeStory, work.StatusActive, work.ActivityNeedsPermission),
		row("asking", work.WorkTypeStory, work.StatusActive, work.ActivityNeedsPermission),
		row("running", work.WorkTypeStory, work.StatusActive, work.ActivityIdle),
		row("busy", work.WorkTypeStory, work.StatusActive, work.ActivityRunning),
		row("idle-a", work.WorkTypeStory, work.StatusOpen, work.ActivityOpen),
		row("idle-b", work.WorkTypeStory, work.StatusStopped, work.ActivityStopped),
	}

	kept, hidden := currentSegment(items, 1)

	if hidden != (CurrentHidden{}) {
		t.Fatalf("hidden = %+v, want nothing held back: the two capped groups are at their cap", hidden)
	}
	for _, id := range []string{"waiting", "asking", "running", "busy", "idle-a", "idle-b"} {
		if !contains(kept, id) {
			t.Errorf("%q must survive the cap, got %v", id, ids(kept))
		}
	}
}

// A cap of zero holds nothing back, which is what "Show earlier work" asks for.
func TestCurrentSegment_NoCapHoldsNothingBack(t *testing.T) {
	var items []rpc.WorkListItem
	for i := range 80 {
		items = append(items, row(fmt.Sprintf("idle-%d", i), work.WorkTypeStory, work.StatusOpen, work.ActivityOpen))
	}

	kept, hidden := currentSegment(items, 0)

	if hidden != (CurrentHidden{}) || len(kept) != 80 {
		t.Errorf("uncapped segment = %d rows, hidden %+v; want 80 and nothing held back", len(kept), hidden)
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

	if hidden != (CurrentHidden{}) {
		t.Errorf("hidden = %+v, want nothing: only recognised groups are capped", hidden)
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
