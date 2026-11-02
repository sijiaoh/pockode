package htmlpage

import (
	"strings"
	"testing"
)

func TestApplyEdits(t *testing.T) {
	const page = `<h1>Plan</h1><td>a</td><td>a</td><p>x</p>`
	tests := []struct {
		name    string
		edits   []Edit
		want    string
		wantErr string
	}{
		{name: "unique match", edits: []Edit{{Old: "Plan", New: "Plans"}}, want: `<h1>Plans</h1><td>a</td><td>a</td><p>x</p>`},
		{name: "replace_all", edits: []Edit{{Old: "<td>a</td>", New: "<td>b</td>", ReplaceAll: true}}, want: `<h1>Plan</h1><td>b</td><td>b</td><p>x</p>`},
		{name: "replace_all with one match", edits: []Edit{{Old: "<p>x</p>", New: "", ReplaceAll: true}}, want: `<h1>Plan</h1><td>a</td><td>a</td>`},
		// The second edit is matched against what the first left, so it can
		// rely on the first's result.
		{name: "in order", edits: []Edit{{Old: "<p>x</p>", New: "<p>y</p>"}, {Old: "<p>y</p>", New: "<p>z</p>"}}, want: `<h1>Plan</h1><td>a</td><td>a</td><p>z</p>`},
		// The size is refused before the result is built: 3 matches here, but
		// a short old all over a full page would be gigabytes.
		{name: "result over the limit", edits: []Edit{{Old: "a", New: strings.Repeat("b", MaxHTMLBytes/2), ReplaceAll: true}}, wantErr: "edit 1: the page would be"},
		{name: "result blank", edits: []Edit{{Old: page, New: " \n"}}, wantErr: "the edits leave the page empty"},
		// Refused at the step that grows past the limit, even though a later
		// one would shrink it back: no step builds more than the limit.
		{name: "intermediate over the limit", edits: []Edit{{Old: "<p>x</p>", New: strings.Repeat("b", MaxHTMLBytes)}, {Old: strings.Repeat("b", MaxHTMLBytes), New: ""}}, wantErr: "edit 1: the page would be"},
		{name: "no edits", wantErr: "edits is required"},
		{name: "empty old", edits: []Edit{{Old: "", New: "x"}}, wantErr: "edit 1: old is missing or empty"},
		{name: "no change", edits: []Edit{{Old: "Plan", New: "Plan"}}, wantErr: "edit 1: old and new are the same"},
		{name: "not found", edits: []Edit{{Old: "<h2>", New: "<h3>"}}, wantErr: "edit 1: old was not found"},
		{name: "not unique", edits: []Edit{{Old: "<td>a</td>", New: "<td>b</td>"}}, wantErr: "edit 1: old matches 2 places"},
		{name: "a later edit fails", edits: []Edit{{Old: "Plan", New: "Plans"}, {Old: "<td>a</td>", New: "X"}}, wantErr: "edit 2: old matches 2 places in the page as the edits before it left it"},
		{name: "a later edit misses what an earlier one removed", edits: []Edit{{Old: "<p>x</p>", New: ""}, {Old: "<p>x</p>", New: "y"}}, wantErr: "edit 2: old was not found in the page as the edits before it left it"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ApplyEdits(page, tt.edits)
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("err = %v, want it to mention %q", err, tt.wantErr)
				}
				if got != "" {
					t.Errorf("a failed set returned %q", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("ApplyEdits: %v", err)
			}
			if got != tt.want {
				t.Errorf("got %q, want %q", got, tt.want)
			}
		})
	}
}
