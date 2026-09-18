package session

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// DefaultListPageSize is how many rows a client gets when it does not ask for a
// size. A phone sidebar shows about eleven rows, so this is two and a half
// screens: enough that the list's end is not already on screen when the first
// page lands — which would ask for the second page before the user has done
// anything — and small enough that the first paint is not waiting on rows
// nobody scrolls to (docs/list-paging-ui.md §5).
const DefaultListPageSize = 30

// ListResyncPageCap is how many pages a resync may restore. A resync hands back
// what the user had loaded rather than a first page, up to this many pages;
// past it, a client that has to be handed 150 rows to recover is being handed
// back the problem paging exists to remove (docs/list-paging-ui.md §3.4).
const ListResyncPageCap = 5

// MaxListPageSize caps what one request can ask for. Oversized limits are
// clamped rather than refused, exactly as history paging clamps: the page a
// client gets is still correct, and the cursor tells it there is more.
const MaxListPageSize = DefaultListPageSize * ListResyncPageCap

// ErrInvalidListCursor reports a cursor that is not one this server handed out.
// It says nothing about which rows exist: a cursor names a position in the sort
// order, not a row, so a session deleted since it was issued is not an error.
var ErrInvalidListCursor = errors.New("invalid session list cursor")

// ErrInvalidListLimit reports a page size that cannot be honoured. Only a
// negative one: zero and oversized limits have a defined meaning.
var ErrInvalidListLimit = errors.New("invalid session list page size")

// ListCursor is a position in the session list's sort order: the row the client
// can see at the bottom of what it has.
//
// It is a position and not an offset, which is the whole point. `UpdatedAt` is
// the sort key and it moves while the user scrolls, so a page asked for by
// position — "the next 30 after 60" — skips rows and repeats rows as sessions
// bump to the top behind the request. A skipped row here is a conversation the
// user cannot reach by scrolling and has no way to know was skipped
// (docs/list-paging-ui.md §3.3).
//
// It carries the id as well as the timestamp because two sessions can share a
// timestamp, and a cursor that cannot tell them apart either drops one or
// repeats it.
type ListCursor struct {
	UpdatedAt time.Time
	ID        string
}

// String encodes the cursor for the wire. Opaque to clients: they hand it back
// unread, and nothing but this file may take it apart.
func (c ListCursor) String() string {
	return strconv.FormatInt(c.UpdatedAt.UnixNano(), 10) + "." + c.ID
}

// ParseListCursor reads back what String wrote.
func ParseListCursor(s string) (ListCursor, error) {
	nanos, id, found := strings.Cut(s, ".")
	if !found || id == "" {
		return ListCursor{}, fmt.Errorf("%w: %q is not a cursor", ErrInvalidListCursor, s)
	}
	n, err := strconv.ParseInt(nanos, 10, 64)
	if err != nil {
		return ListCursor{}, fmt.Errorf("%w: %q has no timestamp", ErrInvalidListCursor, s)
	}
	return ListCursor{UpdatedAt: time.Unix(0, n), ID: id}, nil
}

// ListOrder is the session list's order, newest first, as a sort.Slice
// comparison over rows.
//
// Total rather than merely descending: sessions written in the same
// millisecond — a fork and its parent, a batch of work sessions — would
// otherwise come back in whichever order the sort happened to leave them, and a
// cursor into an order that is not total cannot say where it is.
//
// Compared on UnixNano rather than with time.After, because the two disagree:
// After reads the monotonic clock when both values carry one, and a session
// read back from disk carries none. The cursor is a wall-clock instant, so the
// order has to be one too.
func ListOrder[T any](rows []T, key func(T) ListCursor) func(i, j int) bool {
	return func(i, j int) bool {
		return key(rows[i]).before(key(rows[j]))
	}
}

// before reports whether c sorts ahead of other — nearer the top of the list.
func (c ListCursor) before(other ListCursor) bool {
	a, b := c.UpdatedAt.UnixNano(), other.UpdatedAt.UnixNano()
	if a != b {
		return a > b
	}
	return c.ID > other.ID
}

// ClampListLimit resolves a requested page size: zero asks for the default,
// anything above the cap is clamped, and a negative one is a caller's mistake.
func ClampListLimit(limit int) (int, error) {
	if limit < 0 {
		return 0, fmt.Errorf("%w: limit %d is negative", ErrInvalidListLimit, limit)
	}
	if limit == 0 {
		return DefaultListPageSize, nil
	}
	if limit > MaxListPageSize {
		return MaxListPageSize, nil
	}
	return limit, nil
}

// PageList returns the first limit rows that sort after cursor.
//
// rows must already be in ListOrder, and — for a list that is narrowed — must
// already be narrowed: a page is cut after the filter, or a page of 30 arrives
// as however many of those 30 survived it.
//
// An empty cursor asks for the first page. Any other cursor asks for what
// follows the position it names, whether or not the row it was taken from still
// exists: that is what makes it survive a list that reorders under it.
func PageList[T any](rows []T, key func(T) ListCursor, cursor string, limit int) ([]T, ListCursor, bool, error) {
	limit, err := ClampListLimit(limit)
	if err != nil {
		return nil, ListCursor{}, false, err
	}

	start := 0
	if cursor != "" {
		after, err := ParseListCursor(cursor)
		if err != nil {
			return nil, ListCursor{}, false, err
		}
		for start < len(rows) && !after.before(key(rows[start])) {
			start++
		}
	}

	end := start + limit
	hasMore := end < len(rows)
	if !hasMore {
		end = len(rows)
	}

	page := rows[start:end]
	next := ListCursor{}
	if hasMore {
		next = key(page[len(page)-1])
	}
	return page, next, hasMore, nil
}
