package search

import (
	"bytes"
	"regexp"
	"testing"
)

func TestMatcherFind(t *testing.T) {
	tests := []struct {
		name          string
		query         string
		caseSensitive bool
		text          string
		want          []Range
	}{
		{name: "no match", query: "zzz", text: "hello world"},
		{name: "single match", query: "world", text: "hello world", want: []Range{{6, 11}}},
		{name: "at start", query: "he", text: "hello", want: []Range{{0, 2}}},
		{name: "at end", query: "lo", text: "hello", want: []Range{{3, 5}}},
		{name: "whole text", query: "hello", text: "hello", want: []Range{{0, 5}}},
		{name: "query longer than text", query: "hellothere", text: "hello"},
		{
			name: "repeated non-overlapping", query: "aa", text: "aaaa",
			want: []Range{{0, 2}, {2, 4}},
		},
		{
			name: "fold matches any casing", query: "NeEdLe", text: "a needle and a NEEDLE",
			want: []Range{{2, 8}, {15, 21}},
		},
		{
			name: "case sensitive skips other casing", query: "NEEDLE", caseSensitive: true,
			text: "needle NEEDLE", want: []Range{{7, 13}},
		},
		{
			// Offsets must stay byte-based so the client can slice Text with them.
			name: "offsets are bytes past multibyte runes", query: "needle", text: "日本語 needle",
			want: []Range{{10, 16}},
		},
		{
			// A non-ASCII query takes the regexp path, which folds Unicode.
			name: "non-ascii query folds case", query: "ÉCOLE", text: "une école ici",
			want: []Range{{4, 10}},
		},
		{
			name: "candidate byte that does not start a match", query: "abc", text: "aXabc",
			want: []Range{{2, 5}},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			m, err := newMatcher(tt.query, tt.caseSensitive)
			if err != nil {
				t.Fatalf("newMatcher failed: %v", err)
			}

			got := m.find([]byte(tt.text), maxRangesPerLine)
			if len(got) != len(tt.want) {
				t.Fatalf("got %+v, want %+v", got, tt.want)
			}
			for i := range got {
				if got[i] != tt.want[i] {
					t.Fatalf("got %+v, want %+v", got, tt.want)
				}
			}

			if want := len(tt.want) > 0; m.matchString(tt.text) != want {
				t.Errorf("matchString = %v, want %v", !want, want)
			}
		})
	}
}

func TestMatcherFindRespectsLimit(t *testing.T) {
	m, err := newMatcher("a", false)
	if err != nil {
		t.Fatalf("newMatcher failed: %v", err)
	}
	if got := len(m.find(bytes.Repeat([]byte("a"), 100), 3)); got != 3 {
		t.Errorf("got %d ranges, want 3", got)
	}
}

// The ASCII fast path must agree with the regexp it replaces, since that is the
// behavior the API documents for case-insensitive search.
func TestMatcherFoldAgreesWithRegexp(t *testing.T) {
	texts := []string{
		"", "a", "A", "needle", "NEEDLE", "NeEdLe",
		"no match here", "xxxNEEDLExxx", "needleneedle", "nnneedle",
		"日本語 NEEDLE テスト", "N", "ne", "neeDLE needle NEEDLE",
	}

	for _, query := range []string{"needle", "N", "ne", "NEEDLE"} {
		m, err := newMatcher(query, false)
		if err != nil {
			t.Fatalf("newMatcher failed: %v", err)
		}
		re := regexp.MustCompile("(?i)" + regexp.QuoteMeta(query))

		for _, text := range texts {
			want := re.FindAllStringIndex(text, maxRangesPerLine)
			got := m.find([]byte(text), maxRangesPerLine)
			if len(got) != len(want) {
				t.Errorf("query %q text %q: got %+v, want %+v", query, text, got, want)
				continue
			}
			for i := range got {
				if got[i].Start != want[i][0] || got[i].End != want[i][1] {
					t.Errorf("query %q text %q: got %+v, want %+v", query, text, got, want)
					break
				}
			}
		}
	}
}
