package watch

import (
	"fmt"
	"sort"

	"github.com/pockode/server/rpc"
	"github.com/pockode/server/session"
	"github.com/pockode/server/work"
)

// NotRunningCap is how many *Not running* rows a subscriber is sent before the
// group arrives short. High enough that an ordinary project never sees the
// control that fetches the rest, low enough to stop the one unbounded group of
// the `Current` segment from being the whole screen.
//
// It is a cap and not a page: one request loads everything it held back, and
// there is no second one (docs/list-paging-ui.md §4.1, §5).
const NotRunningCap = 50

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

// isNotRunningRow reports whether a row belongs to the *Not running* group —
// the one group of `Current` that accumulates and never empties, which is why
// it is the only one capped. Status and type alone decide it, so a row does not
// leave or join the group when its activity moves.
func isNotRunningRow(item rpc.WorkListItem) bool {
	if item.Status == work.StatusStopped {
		return true
	}
	// A row of an unrecognised status or type is counted in no group, so the cap
	// never reaches it — the conservative half of the asymmetry above, and what
	// keeps "rows sent plus rows held back" exactly the group the client draws.
	return item.Status == work.StatusOpen && item.Type == work.WorkTypeStory
}

// currentSegment cuts the whole list down to what the `Current` segment needs:
// every row it draws, plus everything those rows make claims about, minus the
// oldest of *Not running* once that group passes cap. A cap of zero or less
// holds nothing back, which is what "Show earlier work" asks for.
//
// hidden is how many rows were held back, and is what the group's heading adds
// to the rows it received so that its count stays the whole group's
// (docs/list-paging-ui.md §4.1). Closed work is not here at all: the archive is
// a separate, paged list.
//
// The oldest are dropped rather than the newest because this group is in
// creation order and nothing sorts it: the end of it is the work created most
// recently, which is what a user would notice missing within the hour.
//
// Order is the store's throughout, so a work that starts or blocks while the
// list is being read stays where the reader's eye left it
// (docs/project-ui.md §2.3).
func currentSegment(items []rpc.WorkListItem, notRunningCap int) (kept []rpc.WorkListItem, hidden int) {
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
	if notRunningCap > 0 {
		excess := 0
		for _, item := range items {
			if rows[item.ID] && isNotRunningRow(item) {
				excess++
			}
		}
		excess -= notRunningCap
		for _, item := range items {
			if excess <= 0 {
				break
			}
			// Only stories are dropped. Dropping a stopped *task* would save
			// nothing: its story keeps every one of its tasks anyway, for the
			// `{closed}/{total}` on its own row.
			if !rows[item.ID] || !isNotRunningRow(item) || item.Type != work.WorkTypeStory {
				continue
			}
			if holdsRowChild[item.ID] {
				continue
			}
			dropped[item.ID] = true
			excess--
		}
	}

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
	return kept, len(dropped)
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
