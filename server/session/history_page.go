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
	// record's seq, because a record it could not stamp carries no seq at all and
	// would strand paging at that point.
	NextBeforeSeq HistorySeq
}

// PageHistory returns the newest limit records older than beforeSeq.
//
// beforeSeq is exclusive: NoHistorySeq asks for the newest page, and any other
// value asks for the records that precede the record it names. limit of zero
// means DefaultHistoryPageSize; anything above MaxHistoryPageSize is clamped.
//
// records must be the whole history as GetHistory returned it, because a
// sequence number is a position in exactly that sequence.
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

	end := len(records)
	if beforeSeq != NoHistorySeq {
		if beforeSeq < NoHistorySeq {
			return HistoryPage{}, fmt.Errorf("%w: seq %d is not a record address", ErrInvalidHistoryCursor, beforeSeq)
		}
		if beforeSeq > HistorySeq(len(records)) {
			return HistoryPage{}, fmt.Errorf("%w: seq %d is past the end of a %d record history",
				ErrInvalidHistoryCursor, beforeSeq, len(records))
		}
		// The record at seq s sits at index s-1, so everything older than it is
		// what comes before that index.
		end = beforeSeq.Index()
	}

	start := end - limit
	if start < 0 {
		start = 0
	}

	page := HistoryPage{Records: stampHistorySeq(records[start:end], HistorySeq(start+1))}
	if start > 0 {
		page.HasMore = true
		// Records[0] is at index start, whose seq is start+1.
		page.NextBeforeSeq = HistorySeq(start + 1)
	}
	return page, nil
}
