package canvas

import (
	"encoding/json"
	"testing"
	"time"
)

// The reasons a fork from a revision is refused, checked in the order of
// docs/canvas-ui.md §13.5.
func TestForkCuts(t *testing.T) {
	records := []json.RawMessage{
		json.RawMessage(`{"type":"message","content":"draw"}`),
		json.RawMessage(`not json`),
		json.RawMessage(`{"type":"tool_result","tool_use_id":"b","canvas_revision":2}`),
		json.RawMessage(`{"type":"tool_result","tool_use_id":"d","canvas_revision":4}`),
		json.RawMessage(`{"type":"tool_result","tool_use_id":"c","canvas_revision":3}`),
		json.RawMessage(`{"type":"tool_result","tool_use_id":"e","canvas_revision":5,"parent_tool_use_id":"t"}`),
		// Superseded and a subagent's at once: superseded is checked first.
		json.RawMessage(`{"type":"tool_result","tool_use_id":"f","canvas_revision":7}`),
		json.RawMessage(`{"type":"tool_result","tool_use_id":"g","canvas_revision":6,"parent_tool_use_id":"t"}`),
	}

	tests := []struct {
		name     string
		inFlight bool
		turn     bool
		// early: the page was drawn before the open turn began.
		early    bool
		revision int
		index    int
		reason   ForkBlocked
		by       int
	}{
		{"recorded", false, false, false, 2, 2, "", 0},
		{"no record, nothing running", false, false, false, 1, 0, ForkNoRecord, 0},
		{"no record, a call in flight", true, false, false, 1, 0, ForkPending, 0},
		{"recorded, a call in flight", true, false, false, 2, 2, "", 0},
		// Drawn before its tool_call was read: newer than every record, by the
		// turn running now.
		{"newest, no record, drawn this turn", false, true, false, 8, 0, ForkPending, 0},
		{"newest, no record, drawn before this turn", false, true, true, 8, 0, ForkNoRecord, 0},
		{"older, no record, drawn this turn", false, true, false, 1, 0, ForkNoRecord, 0},
		{"a later page returned first", false, false, false, 3, 0, ForkSuperseded, 4},
		{"the later page itself", false, false, false, 4, 3, "", 0},
		{"a subagent's", false, false, false, 5, 0, ForkSubagent, 0},
		{"superseded before subagent", false, false, false, 6, 0, ForkSuperseded, 7},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			opened := time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)
			live := LiveCalls{CallsInFlight: tt.inFlight}
			if tt.turn {
				live.TurnOpenedAt = opened
			}
			drawnAt := opened.Add(time.Second)
			if tt.early {
				drawnAt = opened.Add(-time.Second)
			}
			cuts := ReadForkCuts(records, live)
			index, err := cuts.Cut(tt.revision, drawnAt)
			if tt.reason == "" {
				if err != nil || index != tt.index {
					t.Errorf("Cut(%d) = %d, %v; want %d", tt.revision, index, err, tt.index)
				}
				return
			}
			if err == nil || err.Reason != tt.reason || err.By != tt.by {
				t.Errorf("Cut(%d) error = %+v, want %s by %d", tt.revision, err, tt.reason, tt.by)
			}
			if got := cuts.Blocked(tt.revision, drawnAt); got != tt.reason {
				t.Errorf("Blocked(%d) = %q, want %q", tt.revision, got, tt.reason)
			}
		})
	}
}
