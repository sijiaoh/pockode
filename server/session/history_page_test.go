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
