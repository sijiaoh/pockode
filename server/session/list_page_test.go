package session

import (
	"errors"
	"sort"
	"testing"
	"time"
)

func row(id string, updatedAt time.Time) SessionMeta {
	return SessionMeta{ID: id, UpdatedAt: updatedAt}
}

func ids(rows []SessionMeta) []string {
	out := make([]string, len(rows))
	for i, r := range rows {
		out[i] = r.ID
	}
	return out
}

func equal(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// Newest first, and — where that is a tie — an order at all. A cursor into an
// order that is not total cannot say where it is.
func TestListOrder_IsTotal(t *testing.T) {
	at := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	rows := []SessionMeta{
		row("b", at),
		row("c", at.Add(time.Hour)),
		row("a", at),
	}

	sort.Slice(rows, ListOrder(rows, SessionMeta.Cursor))

	if want := []string{"c", "b", "a"}; !equal(ids(rows), want) {
		t.Errorf("order = %v, want %v", ids(rows), want)
	}
}

func TestPageList_WalksTheWholeList(t *testing.T) {
	at := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	rows := make([]SessionMeta, 0, 7)
	for i := range 7 {
		rows = append(rows, row(string(rune('a'+i)), at.Add(-time.Duration(i)*time.Minute)))
	}

	var seen []string
	cursor := ""
	for range 10 {
		page, next, hasMore, err := PageList(rows, SessionMeta.Cursor, cursor, 3)
		if err != nil {
			t.Fatalf("page: %v", err)
		}
		seen = append(seen, ids(page)...)
		if !hasMore {
			if next != (ListCursor{}) {
				t.Errorf("last page carries a cursor: %v", next)
			}
			break
		}
		cursor = next.String()
	}

	if want := []string{"a", "b", "c", "d", "e", "f", "g"}; !equal(seen, want) {
		t.Errorf("walked %v, want %v", seen, want)
	}
}

// The reason the cursor is a position and not an offset: the sort key moves
// while the user scrolls. Everything the reader has already seen is bumped to
// the top between two pages, and the next page still picks up exactly where
// they were — no row skipped, no row twice (docs/list-paging-ui.md §3.3).
func TestPageList_RowsBumpedToTheTopNeitherSkipNorRepeat(t *testing.T) {
	at := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	rows := make([]SessionMeta, 0, 6)
	for i := range 6 {
		rows = append(rows, row(string(rune('a'+i)), at.Add(-time.Duration(i)*time.Minute)))
	}

	first, next, hasMore, err := PageList(rows, SessionMeta.Cursor, "", 2)
	if err != nil || !hasMore {
		t.Fatalf("first page: %v hasMore=%v", err, hasMore)
	}
	// Copied: the page is a window onto rows, and rows is about to re-sort.
	firstIDs := ids(first)
	cursor := next.String()

	// The two rows the reader has seen are touched by a running agent, and the
	// whole list re-sorts around them.
	touched := at.Add(time.Hour)
	rows[0].UpdatedAt = touched
	rows[1].UpdatedAt = touched.Add(time.Minute)
	sort.Slice(rows, ListOrder(rows, SessionMeta.Cursor))

	second, _, _, err := PageList(rows, SessionMeta.Cursor, cursor, 2)
	if err != nil {
		t.Fatalf("second page: %v", err)
	}

	if want := []string{"c", "d"}; !equal(ids(second), want) {
		t.Errorf("second page = %v, want %v — offset paging is what skips rows here", ids(second), want)
	}
	if want := []string{"a", "b"}; !equal(firstIDs, want) {
		t.Errorf("first page = %v, want %v", firstIDs, want)
	}
}

// A cursor names a position, not a row, so the row it was taken from can be
// deleted without stranding the client that holds it.
func TestPageList_CursorSurvivesTheRowItNames(t *testing.T) {
	at := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	rows := []SessionMeta{
		row("a", at),
		row("b", at.Add(-time.Minute)),
		row("c", at.Add(-2*time.Minute)),
	}

	cursor := rows[1].Cursor().String()
	rows = []SessionMeta{rows[0], rows[2]}

	page, _, _, err := PageList(rows, SessionMeta.Cursor, cursor, 10)
	if err != nil {
		t.Fatalf("page: %v", err)
	}
	if want := []string{"c"}; !equal(ids(page), want) {
		t.Errorf("page = %v, want %v", ids(page), want)
	}
}

func TestPageList_Limits(t *testing.T) {
	at := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	rows := make([]SessionMeta, 0, MaxListPageSize+DefaultListPageSize+1)
	for i := range cap(rows) {
		rows = append(rows, row(string(rune('a'+i%26))+string(rune('a'+i/26)), at.Add(-time.Duration(i)*time.Minute)))
	}

	page, _, _, err := PageList(rows, SessionMeta.Cursor, "", 0)
	if err != nil || len(page) != DefaultListPageSize {
		t.Errorf("default page = %d rows (err %v), want %d", len(page), err, DefaultListPageSize)
	}

	page, _, _, err = PageList(rows, SessionMeta.Cursor, "", MaxListPageSize*10)
	if err != nil || len(page) != MaxListPageSize {
		t.Errorf("oversized page = %d rows (err %v), want it clamped to %d", len(page), err, MaxListPageSize)
	}

	if _, _, _, err := PageList(rows, SessionMeta.Cursor, "", -1); !errors.Is(err, ErrInvalidListLimit) {
		t.Errorf("negative limit err = %v, want ErrInvalidListLimit", err)
	}
}

func TestParseListCursor(t *testing.T) {
	original := ListCursor{UpdatedAt: time.Now().Truncate(0), ID: "sess.with.dots"}

	parsed, err := ParseListCursor(original.String())
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if !parsed.UpdatedAt.Equal(original.UpdatedAt) || parsed.ID != original.ID {
		t.Errorf("round trip = %+v, want %+v", parsed, original)
	}

	for _, bad := range []string{"not-a-cursor", "", "123.", "abc.sess-1"} {
		if _, err := ParseListCursor(bad); !errors.Is(err, ErrInvalidListCursor) {
			t.Errorf("ParseListCursor(%q) err = %v, want ErrInvalidListCursor", bad, err)
		}
	}
}
