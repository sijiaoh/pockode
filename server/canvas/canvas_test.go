package canvas

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestIsTool(t *testing.T) {
	tests := []struct {
		name string
		want bool
	}{
		{"mcp__pockode__canvas_render", true},
		{"mcp__pockode__canvas_update", true},
		{"pockode:canvas_render", true},
		{"pockode:canvas_update", true},
		{"mcp__pockode__html_render", false},
		{"canvas_render", false},
		{"mcp__other__canvas_render", false},
		{"other:canvas_update", false},
	}
	for _, tt := range tests {
		if got := IsTool(tt.name); got != tt.want {
			t.Errorf("IsTool(%q) = %v, want %v", tt.name, got, tt.want)
		}
	}
}

// The first line of a result is what the server reads the revision back from
// (docs/canvas-ui.md §9.4), with and without a size and with warnings after it.
func TestResultText_RevisionReadsBack(t *testing.T) {
	tests := []struct {
		name     string
		snap     Snapshot
		warnings []string
		first    string
	}{
		{
			name:  "size known",
			snap:  Snapshot{Revision: 8, DrawnFor: &Size{Width: 390, Height: 664}},
			first: "Canvas revision 8 · drawn for 390×664.",
		},
		{
			name:     "size unknown, with warnings",
			snap:     Snapshot{Revision: 12},
			warnings: []string{"one", "two"},
			first:    "Canvas revision 12 · drawn for an unknown size (",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			text := ResultText(tt.snap, tt.warnings)
			if !strings.HasPrefix(text, tt.first) {
				t.Errorf("result starts %q, want %q", text, tt.first)
			}
			if got := strings.Contains(text, "\nWarnings:\n- one\n- two"); got != (len(tt.warnings) > 0) {
				t.Errorf("warnings block present = %v in %q", got, text)
			}
			rev, ok := RevisionFromResult(text)
			if !ok || rev != tt.snap.Revision {
				t.Errorf("RevisionFromResult = %d, %v; want %d", rev, ok, tt.snap.Revision)
			}
		})
	}
}

func TestRevisionFromResult_RejectsOtherText(t *testing.T) {
	for _, text := range []string{
		"",
		FailureText(7, []string{"There is no region \"x\"."}),
		"Canvas revision x · drawn",
		"Canvas revision 0 · drawn",
		"canvas revision 3 · drawn",
	} {
		if rev, ok := RevisionFromResult(text); ok {
			t.Errorf("RevisionFromResult(%q) = %d, want none", text, rev)
		}
	}
}

func TestForkPoint(t *testing.T) {
	records := []json.RawMessage{
		json.RawMessage(`{"type":"message","content":"hi","canvas_size":{"width":390,"height":664}}`),
		json.RawMessage(`{"type":"tool_result","tool_use_id":"a","canvas_revision":2}`),
		json.RawMessage(`{"type":"message","content":"rotated","canvas_size":{"width":800,"height":360}}`),
		// A later call whose result came back first: the highest revision is the
		// canvas at the cut, not the last one recorded.
		json.RawMessage(`{"type":"tool_result","tool_use_id":"c","canvas_revision":4}`),
		json.RawMessage(`{"type":"tool_result","tool_use_id":"b","canvas_revision":3}`),
		json.RawMessage(`{"type":"message","content":"no size"}`),
		json.RawMessage(`not json`),
	}
	rev, size := ForkPoint(records)
	if rev != 4 {
		t.Errorf("revision = %d, want 4", rev)
	}
	if size == nil || *size != (Size{Width: 800, Height: 360}) {
		t.Errorf("reported size = %+v, want 800×360", size)
	}

	if rev, size := ForkPoint(nil); rev != 0 || size != nil {
		t.Errorf("empty history: %d, %+v; want 0, nil", rev, size)
	}
}
