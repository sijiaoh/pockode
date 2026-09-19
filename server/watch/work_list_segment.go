package watch

import (
	"fmt"
	"sort"

	"github.com/pockode/server/rpc"
	"github.com/pockode/server/session"
	"github.com/pockode/server/work"
)

// CurrentGroupCap is how many rows of *one* capped group a subscriber is sent
// before that group arrives short. High enough that an ordinary project never
// sees the control that fetches the rest, low enough to stop either of the two
// groups that accumulate from being the whole screen.
//
// One number for both groups on purpose: there is no reason for *Stopped* and
// *Not running* to hold different amounts, and two numbers would be two things
// to explain.
//
// It is a cap and not a page: one request loads everything it held back, and
// there is no second one (docs/list-paging-ui.md §4.1, §5).
const CurrentGroupCap = 50

// ArchivePageSize is one page of the closed archive: about two screens, short
// enough to read as one page. The pager is fixed above the bottom bar, so page
// size is not constrained by how far the user has to scroll to reach it
// (docs/list-paging-ui.md §5).
const ArchivePageSize = 20

// clampArchiveLimit resolves a requested archive page size. Same shape as
// session.ClampListLimit — zero takes the default, oversized is clamped rather
// than refused — with this list's own default.
func clampArchiveLimit(limit int) (int, error) {
	if limit < 0 {
		return 0, fmt.Errorf("%w: limit %d is negative", session.ErrInvalidListLimit, limit)
	}
	if limit == 0 {
		return ArchivePageSize, nil
	}
	if limit > session.MaxListPageSize {
		return session.MaxListPageSize, nil
	}
	return limit, nil
}

// hasCurrentRow reports whether a work item is drawn as a row of its own in the
// `Current` segment.
//
// It mirrors `rowGroup` in web/src/components/Project/WorkListOverlay.tsx, and
// has to: a cap is a decision about what to *fetch*, so the side doing the
// fetching is the side that has to know which items are rows. Everything else
// in the segment is sent because a row makes a claim about it — a story's tasks
// for its `{closed}/{total}`, a task's story for its `in: <title>` — and is
// counted nowhere (docs/list-paging-ui.md §2.2).
// The two sides are deliberately not exact mirrors where they disagree about a
// value neither recognises: here a row is kept, there it is not drawn. Sending
// a row the client does not draw costs one row; withholding one it would have
// drawn makes a work item unreachable, and a status nobody recognises — a
// hand-edited or corrupted index — must not be one more way for that to happen
// (the same rule as work.ValidateProgress).
func hasCurrentRow(item rpc.WorkListItem) bool {
	switch item.Status {
	case work.StatusClosed:
		return false
	case work.StatusActive:
		// A task earns a row only by needing a person; everything else about it
		// is rolled up into its story's row.
		return item.Activity.NeedsUser() || item.Type != work.WorkTypeTask
	case work.StatusOpen:
		return item.Type != work.WorkTypeTask
	}
	// Stopped, and anything unrecognised.
	return true
}

// The two groups of `Current` that accumulate and never empty by themselves,
// which is why they are the two that are capped. Status and type alone decide
// membership, so a row does not leave or join a group when its activity moves.
//
// They are separate predicates rather than one because the client draws them as
// two groups with two headings, and a heading's count is "rows received plus
// rows held back" — one hidden number spanning two headings would make at least
// one of them wrong (docs/list-paging-ui.md §4.1).
//
// A row of an unrecognised status or type belongs to neither, so the cap never
// reaches it — the conservative half of the asymmetry above, and what keeps
// "rows sent plus rows held back" exactly the group the client draws.

// isStoppedRow reports whether a row belongs to the *Stopped* group. Stories
// and tasks alike: the group's membership rule is the status, and a stopped
// task has a row of its own (hasCurrentRow).
func isStoppedRow(item rpc.WorkListItem) bool {
	return item.Status == work.StatusStopped
}

// isOpenRow reports whether a row belongs to the *Not running* group, which
// since *Stopped* left it holds open stories and nothing else.
func isOpenRow(item rpc.WorkListItem) bool {
	return item.Status == work.StatusOpen && item.Type == work.WorkTypeStory
}

// CurrentHidden is how many rows each capped group of `Current` had held back.
// One field per group the client draws, because each group's heading adds its
// own number to the rows it received.
type CurrentHidden struct {
	Stopped int
	Open    int
}

// currentSegment cuts the whole list down to what the `Current` segment needs:
// every row it draws, plus everything those rows make claims about, minus the
// least recently updated of each capped group once that group passes cap. A cap
// of zero or less holds nothing back, which is what "Show earlier work" asks
// for.
//
// hidden is how many rows each capped group lost, and is what that group's
// heading adds to the rows it received so that its count stays the whole
// group's (docs/list-paging-ui.md §4.1). Closed work is not here at all: the
// archive is a separate, paged list.
//
// The cut follows the order the client shows, `updated_at` newest first, so the
// rows dropped are the ones off the bottom of the group — the same rule the
// archive's pages are cut by, and the only one under which a work the user just
// touched cannot vanish (docs/project-ui.md §2.3).
//
// The order of what is *kept* is still the store's: the client sorts, and
// sorting here as well would be a second place to change it.
func currentSegment(items []rpc.WorkListItem, groupCap int) (kept []rpc.WorkListItem, hidden CurrentHidden) {
	rows := make(map[string]bool, len(items))
	for _, item := range items {
		if hasCurrentRow(item) {
			rows[item.ID] = true
		}
	}

	// A story whose own task is a row cannot be dropped: the task would go with
	// it, and *Needs you* is never truncated. Recorded before anything is
	// dropped, so which stories are droppable does not depend on the order the
	// drops happen in.
	holdsRowChild := make(map[string]bool, len(items))
	for _, item := range items {
		if item.ParentID != "" && rows[item.ID] {
			holdsRowChild[item.ParentID] = true
		}
	}

	dropped := make(map[string]bool)
	capGroup := func(group func(rpc.WorkListItem) bool) int {
		if groupCap <= 0 {
			return 0
		}
		excess := 0
		// Only stories are droppable. Dropping a stopped *task* would save
		// nothing: its story keeps every one of its tasks anyway, for the
		// `{closed}/{total}` on its own row — which is also why the *Stopped*
		// group's cap only ever bites on stopped stories.
		var droppable []rpc.WorkListItem
		for _, item := range items {
			if !rows[item.ID] || !group(item) {
				continue
			}
			excess++
			if item.Type == work.WorkTypeStory && !holdsRowChild[item.ID] {
				droppable = append(droppable, item)
			}
		}
		excess -= groupCap
		if excess <= 0 {
			return 0
		}
		// Sorted into the order the client lists them in — which is the
		// archive's own order, borrowed rather than restated so that the two
		// segments cannot drift apart on a tie — and eaten from the end, so
		// what goes is always the tail of what the user sees.
		sort.Slice(droppable, session.ListOrder(droppable, rpc.WorkListItem.Cursor))
		n := 0
		for i := len(droppable) - 1; i >= 0 && n < excess; i-- {
			dropped[droppable[i].ID] = true
			n++
		}
		return n
	}
	hidden = CurrentHidden{Stopped: capGroup(isStoppedRow), Open: capGroup(isOpenRow)}

	// Allocated rather than appended to from nil, so an empty project is sent
	// `[]`, which a client can iterate, and not `null`, which it cannot.
	kept = make([]rpc.WorkListItem, 0, len(items))
	for _, item := range items {
		if dropped[item.ID] {
			continue
		}
		switch {
		case rows[item.ID]:
		case item.ParentID != "" && rows[item.ParentID] && !dropped[item.ParentID]:
			// A task kept for the roll-up on its story's row.
		case holdsRowChild[item.ID]:
			// A story kept for the name its task's row prints.
		default:
			continue
		}
		kept = append(kept, item)
	}
	return kept, hidden
}

// archiveSegment returns one page of the closed archive: the closed stories
// that follow cursor, newest first, and the tasks those rows speak for.
//
// Closed stories alone are rows here. A closed task under an open story is not
// in the archive at all — it is counted on its story's row, in `Current` — and
// a task under a closed story comes with the page and is drawn nowhere
// (docs/list-paging-ui.md §4.2).
func archiveSegment(items []rpc.WorkListItem, cursor string, limit int) ([]rpc.WorkListItem, session.ListCursor, bool, error) {
	limit, err := clampArchiveLimit(limit)
	if err != nil {
		return nil, session.ListCursor{}, false, err
	}

	stories := make([]rpc.WorkListItem, 0, len(items))
	for _, item := range items {
		if item.Type == work.WorkTypeStory && item.Status == work.StatusClosed {
			stories = append(stories, item)
		}
	}
	// "When did this finish" is the only question the archive is asked, and the
	// order has to be total for a cursor into it to say where it is
	// (session.ListOrder).
	sort.Slice(stories, session.ListOrder(stories, rpc.WorkListItem.Cursor))

	page, next, hasMore, err := session.PageList(stories, rpc.WorkListItem.Cursor, cursor, limit)
	if err != nil {
		return nil, session.ListCursor{}, false, err
	}

	onPage := make(map[string]bool, len(page))
	for _, item := range page {
		onPage[item.ID] = true
	}
	rows := make([]rpc.WorkListItem, 0, len(page))
	rows = append(rows, page...)
	for _, item := range items {
		if item.ParentID != "" && onPage[item.ParentID] {
			rows = append(rows, item)
		}
	}
	return rows, next, hasMore, nil
}
