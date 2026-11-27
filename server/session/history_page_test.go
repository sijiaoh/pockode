package session

import (
	"encoding/json"
	"errors"
	"fmt"
	"testing"
)

func historyOf(n int) []json.RawMessage {
	records := make([]json.RawMessage, n)
	for i := range records {
		records[i] = json.RawMessage(fmt.Sprintf(`{"type":"text","content":"m%d"}`, i+1))
	}
	return records
}

// seqsOf reads back the addresses the page handed out, which is the only thing
// a client can quote to ask for the page before it.
func seqsOf(t *testing.T, records []json.RawMessage) []HistorySeq {
	t.Helper()
	seqs := make([]HistorySeq, len(records))
	for i, raw := range records {
		var rec struct {
			Seq HistorySeq `json:"seq"`
		}
		if err := json.Unmarshal(raw, &rec); err != nil {
			t.Fatalf("record %d is not an object: %v", i, err)
		}
		seqs[i] = rec.Seq
	}
	return seqs
}

// TestPageHistory covers the boundaries a client walks: the first page it gets
// when it subscribes, a page in the middle, the page that reaches the top, and
// a history with nothing in it.
func TestPageHistory(t *testing.T) {
	tests := []struct {
		name         string
		records      int
		beforeSeq    HistorySeq
		limit        int
		wantSeqs     []HistorySeq
		wantHasMore  bool
		wantNextsSeq HistorySeq
	}{
		{
			name: "newest page", records: 10, beforeSeq: NoHistorySeq, limit: 3,
			wantSeqs: []HistorySeq{8, 9, 10}, wantHasMore: true, wantNextsSeq: 8,
		},
		{
			name: "middle page", records: 10, beforeSeq: 8, limit: 3,
			wantSeqs: []HistorySeq{5, 6, 7}, wantHasMore: true, wantNextsSeq: 5,
		},
		{
			name: "page that reaches the top is short", records: 10, beforeSeq: 3, limit: 5,
			wantSeqs: []HistorySeq{1, 2}, wantHasMore: false, wantNextsSeq: NoHistorySeq,
		},
		{
			name: "exactly the top", records: 10, beforeSeq: 4, limit: 3,
			wantSeqs: []HistorySeq{1, 2, 3}, wantHasMore: false, wantNextsSeq: NoHistorySeq,
		},
		{
			name: "cursor on the first record has nothing before it", records: 10, beforeSeq: 1, limit: 3,
			wantSeqs: nil, wantHasMore: false, wantNextsSeq: NoHistorySeq,
		},
		{
			name: "history shorter than one page", records: 2, beforeSeq: NoHistorySeq, limit: 50,
			wantSeqs: []HistorySeq{1, 2}, wantHasMore: false, wantNextsSeq: NoHistorySeq,
		},
		{
			name: "empty history", records: 0, beforeSeq: NoHistorySeq, limit: 50,
			wantSeqs: nil, wantHasMore: false, wantNextsSeq: NoHistorySeq,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			page, err := PageHistory(historyOf(tt.records), tt.beforeSeq, tt.limit)
			if err != nil {
				t.Fatalf("PageHistory failed: %v", err)
			}

			got := seqsOf(t, page.Records)
			if len(got) != len(tt.wantSeqs) {
				t.Fatalf("page holds %v, want %v", got, tt.wantSeqs)
			}
			for i := range got {
				if got[i] != tt.wantSeqs[i] {
					t.Fatalf("page holds %v, want %v", got, tt.wantSeqs)
				}
			}
			if page.HasMore != tt.wantHasMore {
				t.Errorf("HasMore = %v, want %v", page.HasMore, tt.wantHasMore)
			}
			if page.NextBeforeSeq != tt.wantNextsSeq {
				t.Errorf("NextBeforeSeq = %d, want %d", page.NextBeforeSeq, tt.wantNextsSeq)
			}
		})
	}
}

// TestPageHistoryWalksTheWholeHistoryExactlyOnce is the property the paging
// contract exists for: following the cursors from the newest page to the top
// reproduces the history in order, with nothing repeated and nothing skipped.
func TestPageHistoryWalksTheWholeHistoryExactlyOnce(t *testing.T) {
	const total = 23
	records := historyOf(total)

	var seen []HistorySeq
	before := NoHistorySeq
	for pages := 0; ; pages++ {
		if pages > total {
			t.Fatal("paging did not terminate")
		}
		page, err := PageHistory(records, before, 5)
		if err != nil {
			t.Fatalf("PageHistory(before=%d) failed: %v", before, err)
		}
		seen = append(seqsOf(t, page.Records), seen...)
		if !page.HasMore {
			break
		}
		before = page.NextBeforeSeq
	}

	if len(seen) != total {
		t.Fatalf("walked %d records, want %d", len(seen), total)
	}
	for i, seq := range seen {
		if seq != HistorySeq(i+1) {
			t.Fatalf("record %d has seq %d: the walk repeated or skipped a record", i, seq)
		}
	}
}

// TestPageHistoryHoldsTheSubagentCallsOfItsChildren: a page never begins
// between a subagent call and its work. The client files a child only under a
// loaded row and leaves one that loaded first flat for good, so a boundary
// there drew the work twice — under the subagent's row and as stray top-level
// rows (measured: a 61-record Claude session whose newest page began after
// subagent B's call and before its second child).
func TestPageHistoryHoldsTheSubagentCallsOfItsChildren(t *testing.T) {
	call := func(id, parent string) json.RawMessage {
		return json.RawMessage(fmt.Sprintf(`{"type":"tool_call","tool_use_id":%q,"parent_tool_use_id":%q}`, id, parent))
	}
	text := func(n int) json.RawMessage {
		return json.RawMessage(fmt.Sprintf(`{"type":"text","content":"m%d"}`, n))
	}
	records := []json.RawMessage{
		text(1),
		call("outer", ""), // seq 2
		text(3),
		call("nested", "outer"),   // seq 4
		call("leaf", "nested"),    // seq 5
		call("resumed-later", ""), // seq 6
		text(7),
		text(8),
		call("child", "resumed-later"), // seq 9
		text(10),
	}

	tests := []struct {
		name      string
		beforeSeq HistorySeq
		limit     int
		wantFirst HistorySeq
	}{
		{name: "no child in the page", beforeSeq: NoHistorySeq, limit: 1, wantFirst: 10},
		{name: "a child's call is taken in", beforeSeq: NoHistorySeq, limit: 2, wantFirst: 6},
		{name: "a nested call's own parent too", beforeSeq: 6, limit: 1, wantFirst: 2},
		{name: "a call already in the page", beforeSeq: NoHistorySeq, limit: 5, wantFirst: 6},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			page, err := PageHistory(records, tt.beforeSeq, tt.limit)
			if err != nil {
				t.Fatalf("PageHistory failed: %v", err)
			}
			if got := seqsOf(t, page.Records); len(got) == 0 || got[0] != tt.wantFirst {
				t.Fatalf("page holds %v, want it to start at %d", got, tt.wantFirst)
			}
			if page.NextBeforeSeq != tt.wantFirst && page.HasMore {
				t.Errorf("NextBeforeSeq = %d, want the page's own start %d", page.NextBeforeSeq, tt.wantFirst)
			}
		})
	}
}

// A resumed subagent is announced again (agent.ToolCallResumed), and the
// client draws nothing from that announcement when the spawn is not loaded: the
// page reaches back to the spawn.
func TestPageHistoryReachesPastAResumedAnnouncement(t *testing.T) {
	records := []json.RawMessage{
		json.RawMessage(`{"type":"tool_call","tool_use_id":"spawn"}`),
		json.RawMessage(`{"type":"text","content":"between"}`),
		json.RawMessage(`{"type":"tool_call","tool_use_id":"spawn","subtype":"resumed"}`),
		json.RawMessage(`{"type":"text","content":"more work","parent_tool_use_id":"spawn"}`),
	}
	page, err := PageHistory(records, NoHistorySeq, 2)
	if err != nil {
		t.Fatalf("PageHistory failed: %v", err)
	}
	if got := seqsOf(t, page.Records); len(got) == 0 || got[0] != 1 {
		t.Errorf("page holds %v, want it to start at the spawn", got)
	}
}

// A subagent call further back than one page can hold is left out: its work
// goes flat, as before, rather than the page growing without bound.
func TestPageHistorySubagentCallBeyondTheCap(t *testing.T) {
	records := []json.RawMessage{json.RawMessage(`{"type":"tool_call","tool_use_id":"far"}`)}
	records = append(records, historyOf(MaxHistoryPageSize)...)
	records = append(records, json.RawMessage(`{"type":"text","parent_tool_use_id":"far"}`))

	page, err := PageHistory(records, NoHistorySeq, 1)
	if err != nil {
		t.Fatalf("PageHistory failed: %v", err)
	}
	if got := seqsOf(t, page.Records); len(got) != 1 {
		t.Errorf("page holds %d records, want only the one asked for", len(got))
	}
}

// TestPageHistoryRejectsInvalidCursor: a cursor naming no record must fail
// loudly. Answering with the newest page instead would silently restart the
// client's scrollback from the bottom.
func TestPageHistoryRejectsInvalidCursor(t *testing.T) {
	for _, beforeSeq := range []HistorySeq{-1, 11, 999} {
		_, err := PageHistory(historyOf(10), beforeSeq, 5)
		if !errors.Is(err, ErrInvalidHistoryCursor) {
			t.Errorf("PageHistory(before=%d) error = %v, want ErrInvalidHistoryCursor", beforeSeq, err)
		}
	}
}

func TestPageHistoryLimitBounds(t *testing.T) {
	if _, err := PageHistory(historyOf(3), NoHistorySeq, -1); err == nil {
		t.Error("a negative limit was accepted")
	}

	page, err := PageHistory(historyOf(DefaultHistoryPageSize+10), NoHistorySeq, 0)
	if err != nil {
		t.Fatalf("PageHistory failed: %v", err)
	}
	if len(page.Records) != DefaultHistoryPageSize {
		t.Errorf("limit 0 returned %d records, want the default %d", len(page.Records), DefaultHistoryPageSize)
	}

	page, err = PageHistory(historyOf(MaxHistoryPageSize+10), NoHistorySeq, MaxHistoryPageSize*2)
	if err != nil {
		t.Fatalf("PageHistory failed: %v", err)
	}
	if len(page.Records) != MaxHistoryPageSize {
		t.Errorf("an oversized limit returned %d records, want the cap %d", len(page.Records), MaxHistoryPageSize)
	}
}

// TestPageHistoryKeepsSynthesizedWarningUnaddressed: the record GetHistory
// appends for damaged lines is not in the file, so it must keep seq 0 while the
// real records around it keep the addresses their positions give them.
func TestPageHistoryKeepsSynthesizedWarningUnaddressed(t *testing.T) {
	records := append(historyOf(3), json.RawMessage(`{"type":"warning","seq":0}`))

	page, err := PageHistory(records, NoHistorySeq, 2)
	if err != nil {
		t.Fatalf("PageHistory failed: %v", err)
	}

	got := seqsOf(t, page.Records)
	if len(got) != 2 || got[0] != 3 || got[1] != NoHistorySeq {
		t.Fatalf("page holds seqs %v, want [3 0]", got)
	}
	if page.NextBeforeSeq != 3 {
		t.Errorf("NextBeforeSeq = %d, want 3 (the oldest record of this page)", page.NextBeforeSeq)
	}
}
