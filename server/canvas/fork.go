package canvas

import (
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// ForkBlocked says why a fork from a revision would be refused
// (docs/canvas-ui.md §13.5). Empty when it can be made.
type ForkBlocked string

const (
	// ForkPending: no record names the revision yet, and a canvas call is
	// still in flight, so its result may be on the way.
	ForkPending ForkBlocked = "pending"
	// ForkNoRecord: no record names the revision, and none is coming.
	ForkNoRecord ForkBlocked = "no_record"
	// ForkSuperseded: at the record naming it, the conversation already had a
	// later page, so a cut there would open on that one.
	ForkSuperseded ForkBlocked = "superseded"
	// ForkSubagent: a subagent's call drew it, and neither CLI can reopen its
	// conversation inside a subagent's run.
	ForkSubagent ForkBlocked = "subagent"
)

// ErrForkBlocked is what every ForkBlockedError is.
var ErrForkBlocked = errors.New("cannot fork from this revision")

// ForkBlockedError is a fork from a revision refused, in the words of the
// contract (docs/canvas-ui.md §13.6).
type ForkBlockedError struct {
	Revision int
	Reason   ForkBlocked
	// By is the later revision that superseded this one; ForkSuperseded only.
	By int
}

func (e *ForkBlockedError) Error() string {
	switch e.Reason {
	case ForkSuperseded:
		return fmt.Sprintf("revision %d was replaced by revision %d before its call returned; fork from revision %d", e.Revision, e.By, e.By)
	case ForkSubagent:
		return fmt.Sprintf("revision %d was drawn by a subagent; a fork cannot be cut inside a subagent's run", e.Revision)
	default:
		return fmt.Sprintf("revision %d has no recorded result in this session's history, so there is no point to fork at", e.Revision)
	}
}

func (e *ForkBlockedError) Unwrap() error { return ErrForkBlocked }

// ForkCuts is where a fork from each revision would cut, read from a
// session's history records in one pass.
type ForkCuts struct {
	cuts map[int]forkCut
	// highest is the highest revision any record names.
	highest int
	live    LiveCalls
}

// LiveCalls is what the session's process is doing, asked before the records
// are read (process.Manager.CanvasLive): a call stays in flight until its
// result is recorded, so a revision then missing from the records was either
// still on its way or never coming.
type LiveCalls struct {
	// CallsInFlight: a canvas call's result is not recorded yet.
	CallsInFlight bool
	// TurnOpenedAt is when the open turn began, zero when none is open. A page
	// is applied through the MCP server, which can draw it before the process
	// has read the call's tool_call off the CLI's output, so a page this turn
	// drew that is newer than every recorded one is still taken for one on its
	// way. Only this turn's: an older page with no record stays no_record
	// however long the turn runs.
	TurnOpenedAt time.Time
}

type forkCut struct {
	// index is the tool_result record naming the revision.
	index int
	// highest is the highest revision named at or before index.
	highest  int
	subagent bool
}

// ReadForkCuts reads the records for every tool_result carrying a
// canvas_revision.
func ReadForkCuts(records []json.RawMessage, live LiveCalls) ForkCuts {
	cuts := make(map[int]forkCut)
	highest := 0
	for i, raw := range records {
		var rec struct {
			CanvasRevision  int    `json:"canvas_revision"`
			ParentToolUseID string `json:"parent_tool_use_id"`
		}
		if err := json.Unmarshal(raw, &rec); err != nil || rec.CanvasRevision < 1 {
			continue
		}
		highest = max(highest, rec.CanvasRevision)
		if _, seen := cuts[rec.CanvasRevision]; seen {
			continue
		}
		cuts[rec.CanvasRevision] = forkCut{index: i, highest: highest, subagent: rec.ParentToolUseID != ""}
	}
	return ForkCuts{cuts: cuts, highest: highest, live: live}
}

// Cut is the index of the record a fork from revision, drawn at drawnAt, keeps
// last, or why there is none. The checks are made in the order of
// docs/canvas-ui.md §13.5.
func (f ForkCuts) Cut(revision int, drawnAt time.Time) (int, *ForkBlockedError) {
	cut, ok := f.cuts[revision]
	switch {
	case !ok && (f.live.CallsInFlight || f.drawnThisTurn(revision, drawnAt)):
		return 0, &ForkBlockedError{Revision: revision, Reason: ForkPending}
	case !ok:
		return 0, &ForkBlockedError{Revision: revision, Reason: ForkNoRecord}
	case cut.highest > revision:
		return 0, &ForkBlockedError{Revision: revision, Reason: ForkSuperseded, By: cut.highest}
	case cut.subagent:
		return 0, &ForkBlockedError{Revision: revision, Reason: ForkSubagent}
	}
	return cut.index, nil
}

func (f ForkCuts) drawnThisTurn(revision int, drawnAt time.Time) bool {
	opened := f.live.TurnOpenedAt
	return !opened.IsZero() && !drawnAt.Before(opened) && revision > f.highest
}

// Blocked is Cut's reason alone, empty when the fork can be made.
func (f ForkCuts) Blocked(revision int, drawnAt time.Time) ForkBlocked {
	if _, err := f.Cut(revision, drawnAt); err != nil {
		return err.Reason
	}
	return ""
}

// The line the first input delivered in a fork carries (docs/canvas-ui.md
// §13.6), so an agent that remembers past the cut learns which page is there.
func forkNoteAt(revision int) string {
	return fmt.Sprintf("[Canvas: this session was forked at revision %d, which is on the canvas now; any page you remember drawing after it is not.]", revision)
}

const forkNoteUncopied = "[Canvas: this session was forked, but its canvas could not be copied: the canvas is empty; draw it again with canvas_render.]"

// ListedRevision is a revision as chat.canvas_history lists it: its entry,
// and whether a fork from it would be refused. The reason is read from the
// session's records each time and never stored with the entry.
type ListedRevision struct {
	HistoryEntry
	ForkBlocked ForkBlocked `json:"fork_blocked,omitempty"`
}
