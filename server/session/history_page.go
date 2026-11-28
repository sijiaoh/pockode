package session

import (
	"encoding/json"
	"errors"
	"fmt"
)

// DefaultHistoryPageSize is how many records a client gets when it does not ask
// for a size. A long session's history is mostly tool calls and their results;
// sending all of it costs transport, parsing and memory on a client that will
// only ever render the tail of it.
const DefaultHistoryPageSize = 50

// MaxHistoryPageSize caps what one request can ask for. A larger limit is
// clamped rather than refused: the page a client gets is still correct, and the
// cursor tells it there is more.
const MaxHistoryPageSize = 500

// ErrInvalidHistoryCursor reports a BeforeSeq that names no place in the
// history. Wrapped in a message that says what was asked for.
var ErrInvalidHistoryCursor = errors.New("invalid history cursor")

// ErrInvalidHistoryLimit reports a page size that cannot be honoured. Only a
// negative one: zero and oversized limits have a defined meaning.
var ErrInvalidHistoryLimit = errors.New("invalid history page size")

// HistoryPage is one window onto a session's history, oldest record first.
type HistoryPage struct {
	// Records are stamped with their sequence numbers, as a client always gets
	// them — see HistorySeq.
	Records []json.RawMessage
	// HasMore reports whether records older than this page exist.
	HasMore bool
	// NextBeforeSeq is the cursor for the page before this one: pass it back as
	// BeforeSeq to get the records immediately older than Records[0]. It is
	// NoHistorySeq when HasMore is false.
	//
	// The server computes it instead of letting the client read the first
	// record's seq, because a record that is not a JSON object has nowhere to
	// carry one and would strand paging at that point.
	NextBeforeSeq HistorySeq
}

// PageHistory returns the newest limit records older than beforeSeq.
//
// beforeSeq is exclusive: NoHistorySeq asks for the newest page, and any other
// value asks for the records that precede the record it names. It need not name
// one that still exists — seqs can have gaps (see HistorySeq) — but it cannot be
// past the newest. limit of zero means DefaultHistoryPageSize; anything above
// MaxHistoryPageSize is clamped.
//
// records must be the whole history as GetHistory returned it: a record written
// before seqs were stored is numbered by its place in the whole of it.
func PageHistory(records []json.RawMessage, beforeSeq HistorySeq, limit int) (HistoryPage, error) {
	if limit < 0 {
		return HistoryPage{}, fmt.Errorf("%w: limit %d is negative", ErrInvalidHistoryLimit, limit)
	}
	if limit == 0 {
		limit = DefaultHistoryPageSize
	}
	if limit > MaxHistoryPageSize {
		limit = MaxHistoryPageSize
	}

	seqs := HistorySeqs(records)
	end := len(records)
	if beforeSeq != NoHistorySeq {
		if beforeSeq < NoHistorySeq {
			return HistoryPage{}, fmt.Errorf("%w: seq %d is not a record address", ErrInvalidHistoryCursor, beforeSeq)
		}
		if last := lastHistorySeq(seqs); beforeSeq > last {
			return HistoryPage{}, fmt.Errorf("%w: seq %d is past the newest record, seq %d",
				ErrInvalidHistoryCursor, beforeSeq, last)
		}
		end = olderThan(seqs, beforeSeq)
	}

	start := end - limit
	if start < 0 {
		start = 0
	}
	start = backToSubagentCalls(records, start, end)
	start = backToNumbered(seqs, start)

	page := HistoryPage{Records: stampHistorySeq(records[start:end], seqs[start:end])}
	if start > 0 {
		page.HasMore = true
		page.NextBeforeSeq = seqs[start]
	}
	return page, nil
}

// olderThan returns how many of the records come before seq. A record with no
// seq of its own goes with the numbered record before it, which is what
// backToNumbered keeps a page boundary consistent with.
func olderThan(seqs []HistorySeq, seq HistorySeq) int {
	prev := NoHistorySeq
	for i, s := range seqs {
		if s.Valid() {
			prev = s
		}
		if prev >= seq {
			return i
		}
	}
	return len(seqs)
}

// backToNumbered moves a page's start back onto a record that has a seq. The
// next page's cursor is the seq of this page's first record, and a record with
// none — the warning GetHistory synthesizes, the newest record of all — could
// not be one: a page holding only it would point the next request back at
// itself.
func backToNumbered(seqs []HistorySeq, start int) int {
	for start > 0 && !seqs[start].Valid() {
		start--
	}
	return start
}

// backToSubagentCalls moves a page's start back far enough to hold the call of
// every subagent whose work the page holds, so a page boundary never falls
// between a subagent call and its work.
//
// The client files a child record under its parent's row only when that row is
// loaded, and a child that loaded first stays flat where it arrived even once
// the parent's page comes — a row is never taken out from under the reader
// (docs/tool-call-ui.md#what-is-not-filed). So a boundary there drew the work
// twice for good: counted under the subagent's row, and again as stray
// top-level rows. Moving the boundary is what keeps the client's rule intact.
//
// Bounded by MaxHistoryPageSize: a subagent call further back than that is left
// out, and its work is drawn flat as before. Repeated to a fixed point, because
// a subagent call taken in can itself be a nested subagent's, with its parent
// further back still.
func backToSubagentCalls(records []json.RawMessage, start, end int) int {
	floor := max(end-MaxHistoryPageSize, 0)
	for start > floor {
		missing := missingParents(records[start:end])
		if len(missing) == 0 {
			return start
		}
		earliest := start
		for i := start - 1; i >= floor; i-- {
			if rec := readFiling(records[i]); rec.spawns() && missing[rec.ToolUseID] {
				earliest = i
			}
		}
		if earliest == start {
			return start
		}
		start = earliest
	}
	return start
}

// filing is the part of a record that says where the client files it.
type filing struct {
	Type            string `json:"type"`
	Subtype         string `json:"subtype"`
	ToolUseID       string `json:"tool_use_id"`
	ParentToolUseID string `json:"parent_tool_use_id"`
}

// spawns reports the record a call's row is drawn from: its tool_call, but not
// a later announcement that its work runs again (agent.ToolCallResumed), which
// the client applies to a row already loaded and otherwise drops.
func (f filing) spawns() bool {
	return f.Type == "tool_call" && f.ToolUseID != "" && f.Subtype != "resumed"
}

func readFiling(raw json.RawMessage) filing {
	var rec filing
	if err := json.Unmarshal(raw, &rec); err != nil {
		return filing{}
	}
	return rec
}

// missingParents names the subagent calls the records' children are filed
// under that the records do not announce themselves.
func missingParents(records []json.RawMessage) map[string]bool {
	announced := map[string]bool{}
	missing := map[string]bool{}
	for _, raw := range records {
		rec := readFiling(raw)
		if rec.spawns() {
			announced[rec.ToolUseID] = true
		}
		if rec.ParentToolUseID != "" && !announced[rec.ParentToolUseID] {
			missing[rec.ParentToolUseID] = true
		}
	}
	return missing
}
