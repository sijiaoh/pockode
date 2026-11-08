package htmlpage

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
)

// newSession makes the directory a real session has by the time its agent
// draws anything.
func newSession(t *testing.T, dataDir, sessionID string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(dataDir, "sessions", sessionID), 0o755); err != nil {
		t.Fatal(err)
	}
}

func mustAppend(t *testing.T, s *Store, dataDir, sessionID string, d Draft) Page {
	t.Helper()
	page, err := s.Append(dataDir, sessionID, d)
	if err != nil {
		t.Fatalf("Append: %v", err)
	}
	return page
}

func TestAppendNumbersPagesPerSessionAndReadsThemBack(t *testing.T) {
	dataDir := t.TempDir()
	newSession(t, dataDir, "a")
	newSession(t, dataDir, "b")
	s := NewStore()

	p1 := mustAppend(t, s, dataDir, "a", Draft{Title: "One", HTML: "<p>1</p>"})
	p2 := mustAppend(t, s, dataDir, "a", Draft{Title: "Two", HTML: "<p>2</p>", Base: "p1"})
	other := mustAppend(t, s, dataDir, "b", Draft{Title: "Other", HTML: "<p>b</p>"})

	if p1.ID != "p1" || p2.ID != "p2" || other.ID != "p1" {
		t.Fatalf("ids = %s, %s, %s; want p1, p2 and a fresh p1 in the other session", p1.ID, p2.ID, other.ID)
	}

	got, err := Get(dataDir, "a", "p2")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.Title != "Two" || got.HTML != "<p>2</p>" || got.Base != "p1" || got.CreatedAt.IsZero() {
		t.Errorf("Get(p2) = %+v", got)
	}

	list, err := List(dataDir, "a")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	want := []Summary{{ID: "p1", Title: "One"}, {ID: "p2", Title: "Two"}}
	if !reflect.DeepEqual(list, want) {
		t.Errorf("List = %+v, want %+v", list, want)
	}
}

// Numbering is by number, not by name: p10 comes after p9, not after p1.
func TestListOrdersPastNine(t *testing.T) {
	dataDir := t.TempDir()
	newSession(t, dataDir, "a")
	s := NewStore()
	for i := 1; i <= 11; i++ {
		mustAppend(t, s, dataDir, "a", Draft{Title: fmt.Sprint(i), HTML: "x"})
	}
	list, err := List(dataDir, "a")
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 11 || list[9].ID != "p10" || list[10].ID != "p11" {
		t.Errorf("List = %+v", list)
	}
}

func TestAppendInParallelGivesEachPageItsOwnID(t *testing.T) {
	dataDir := t.TempDir()
	newSession(t, dataDir, "a")
	s := NewStore()

	const n = 20
	ids := make(chan string, n)
	var wg sync.WaitGroup
	for i := range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			page, err := s.Append(dataDir, "a", Draft{Title: fmt.Sprint(i), HTML: "x"})
			if err != nil {
				t.Error(err)
				return
			}
			ids <- page.ID
		}()
	}
	wg.Wait()
	close(ids)

	seen := map[string]bool{}
	for id := range ids {
		if seen[id] {
			t.Errorf("id %s handed out twice", id)
		}
		seen[id] = true
	}
	if len(seen) != n {
		t.Errorf("%d distinct ids, want %d", len(seen), n)
	}
}

func TestAppendRefuses(t *testing.T) {
	dataDir := t.TempDir()
	newSession(t, dataDir, "a")
	s := NewStore()

	tests := []struct {
		name    string
		draft   Draft
		wantErr string
	}{
		{name: "empty html", draft: Draft{Title: "T"}, wantErr: "html is required"},
		{name: "whitespace html", draft: Draft{Title: "T", HTML: " \n\t"}, wantErr: "html is required"},
		{name: "no title", draft: Draft{HTML: "<p>x</p>"}, wantErr: "title is required"},
		{name: "over the limit", draft: Draft{Title: "T", HTML: strings.Repeat("a", MaxHTMLBytes+1)}, wantErr: "256KB"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := s.Append(dataDir, "a", tt.draft); err == nil || !strings.Contains(err.Error(), tt.wantErr) {
				t.Errorf("err = %v, want it to mention %q", err, tt.wantErr)
			}
		})
	}
	if _, err := s.Append(dataDir, "a", Draft{Title: "T", HTML: strings.Repeat("a", MaxHTMLBytes)}); err != nil {
		t.Errorf("a page exactly at the limit was refused: %v", err)
	}
	// A refused draft takes no number.
	if list, _ := List(dataDir, "a"); len(list) != 1 || list[0].ID != "p1" {
		t.Errorf("List = %+v, want only the accepted page as p1", list)
	}
}

// A session deleted while a call was on its way must not have its directory
// brought back by the page.
func TestAppendToADeletedSessionLeavesNothingBehind(t *testing.T) {
	dataDir := t.TempDir()
	_, err := NewStore().Append(dataDir, "gone", Draft{Title: "T", HTML: "x"})
	if !errors.Is(err, ErrSessionGone) {
		t.Fatalf("err = %v, want ErrSessionGone", err)
	}
	if _, err := os.Stat(filepath.Join(dataDir, "sessions", "gone")); !os.IsNotExist(err) {
		t.Errorf("session directory exists after the refused write: %v", err)
	}
}

func TestGetNotFound(t *testing.T) {
	dataDir := t.TempDir()
	newSession(t, dataDir, "a")
	mustAppend(t, NewStore(), dataDir, "a", Draft{Title: "T", HTML: "x"})

	// Ids that are not page ids never become a path.
	for _, id := range []string{"p2", "", "1", "p0", "p01", "p-1", "p+1", "p 1", "../a", "p1/../p1"} {
		if _, err := Get(dataDir, "a", id); !errors.Is(err, ErrNotFound) {
			t.Errorf("Get(%q) err = %v, want ErrNotFound", id, err)
		}
	}
}

func TestCloneCopiesThePagesUpToTheCut(t *testing.T) {
	dataDir := t.TempDir()
	newSession(t, dataDir, "src")
	newSession(t, dataDir, "dst")
	s := NewStore()
	for i := 1; i <= 3; i++ {
		mustAppend(t, s, dataDir, "src", Draft{Title: fmt.Sprint(i), HTML: "x"})
	}

	if err := Clone(dataDir, "src", "dst", 2); err != nil {
		t.Fatalf("Clone: %v", err)
	}
	list, _ := List(dataDir, "dst")
	if want := []Summary{{ID: "p1", Title: "1"}, {ID: "p2", Title: "2"}}; !reflect.DeepEqual(list, want) {
		t.Errorf("fork's pages = %+v, want %+v", list, want)
	}
	// The source's p3 is not the fork's, and the id is not handed out again:
	// the fork's agent may remember it.
	if _, err := Get(dataDir, "dst", "p3"); !errors.Is(err, ErrNotFound) {
		t.Errorf("fork's p3: err = %v, want ErrNotFound", err)
	}
	if next := mustAppend(t, s, dataDir, "dst", Draft{Title: "new", HTML: "y"}); next.ID != "p4" {
		t.Errorf("fork's next page = %s, want p4", next.ID)
	}
	// A fork of the fork inherits the floor too.
	newSession(t, dataDir, "dst2")
	if err := Clone(dataDir, "dst", "dst2", 0); err != nil {
		t.Fatal(err)
	}
	if next := mustAppend(t, s, dataDir, "dst2", Draft{Title: "x", HTML: "y"}); next.ID != "p5" {
		t.Errorf("second fork's next page = %s, want p5", next.ID)
	}
}

// A fork cut at the last page is the source as it was: no floor, no gap.
func TestCloneThroughTheLastPageLeavesNoGap(t *testing.T) {
	dataDir := t.TempDir()
	newSession(t, dataDir, "src")
	s := NewStore()
	mustAppend(t, s, dataDir, "src", Draft{Title: "1", HTML: "x"})
	if err := Clone(dataDir, "src", "dst", 1); err != nil {
		t.Fatal(err)
	}
	if next := mustAppend(t, s, dataDir, "dst", Draft{Title: "2", HTML: "x"}); next.ID != "p2" {
		t.Errorf("fork's next page = %s, want p2", next.ID)
	}
}

func TestCloneOfASessionWithNoPages(t *testing.T) {
	dataDir := t.TempDir()
	if err := Clone(dataDir, "src", "dst", 0); err != nil {
		t.Errorf("Clone with nothing to copy: %v", err)
	}
	if err := Clone(dataDir, "src", "dst", 3); err != nil {
		t.Errorf("Clone from a session with no page directory: %v", err)
	}
}

func TestIDFromResult(t *testing.T) {
	tests := []struct {
		result string
		want   string
	}{
		{ResultLead("p3") + ` "Plans" is shown to the user`, "p3"},
		{ResultLead("p12"), "p12"},
		{"Page p0 is shown", ""},
		{"Page p is shown", ""},
		{"page p3", ""},
		{"Page 3", ""},
		{"Some output\nPage p3", ""},
	}
	for _, tt := range tests {
		got, ok := IDFromResult(tt.result)
		if got != tt.want || ok != (tt.want != "") {
			t.Errorf("IDFromResult(%q) = %q, %v; want %q", tt.result, got, ok, tt.want)
		}
	}
}

func TestIsPageTool(t *testing.T) {
	for name, want := range map[string]bool{
		"mcp__pockode__html_render": true,
		"pockode:html_render":       true,
		"html_render":               false,
		"mcp__other__html_render":   false,
		"other:html_render":         false,
		"mcp__pockode__work_get":    false,
		"mcp__pockode__html_edit":   true,
		"pockode:html_edit":         true,
		// Reads a page rather than storing one: its result names no new page.
		"mcp__pockode__html_get": false,
	} {
		if got := IsPageTool(name); got != want {
			t.Errorf("IsPageTool(%q) = %v, want %v", name, got, want)
		}
	}
}

func TestHighestInRecords(t *testing.T) {
	records := []json.RawMessage{
		json.RawMessage(`{"type":"tool_result","html_page":"p2"}`),
		json.RawMessage(`{"type":"text","content":"\"html_page\" is mentioned here"}`),
		json.RawMessage(`{"type":"tool_result","html_page":"p10"}`),
		json.RawMessage(`{"type":"tool_result","html_page":"bogus"}`),
		json.RawMessage(`not json "html_page"`),
	}
	if got := HighestInRecords(records); got != 10 {
		t.Errorf("HighestInRecords = %d, want 10", got)
	}
	if got := HighestInRecords(nil); got != 0 {
		t.Errorf("HighestInRecords(nil) = %d, want 0", got)
	}
}
