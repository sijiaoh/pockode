package fuzzy

import (
	"math/rand/v2"
	"strings"
	"testing"
)

// randomCase draws a query in the extended syntax and a few lines of text from
// small alphabets, so terms, operators and the characters that only match
// after lowercasing or normalization ("K" is the Kelvin sign) collide often.
func randomCase(rng *rand.Rand) (query string, lines []string) {
	draw := func(alphabet []string, n int) string {
		var b strings.Builder
		for range n {
			b.WriteString(alphabet[rng.IntN(len(alphabet))])
		}
		return b.String()
	}
	textChars := []string{"a", "b", "c", "A", "B", "k", "é", "K", "-", " "}
	termChars := []string{"a", "b", "c", "A", "k", "K", "é"}
	prefixes := []string{"", "", "'", "^", "!", "!'"}
	suffixes := []string{"", "", "$", "'"}

	terms := make([]string, 1+rng.IntN(3))
	for i := range terms {
		terms[i] = prefixes[rng.IntN(len(prefixes))] + draw(termChars, 1+rng.IntN(3)) + suffixes[rng.IntN(len(suffixes))]
	}
	if rng.IntN(4) == 0 {
		terms = append(terms, "|", draw(termChars, 1+rng.IntN(2)))
	}
	lines = make([]string, 1+rng.IntN(3))
	for i := range lines {
		lines[i] = draw(textChars, rng.IntN(10))
	}
	return strings.Join(terms, " "), lines
}

func TestMatchesAgreesWithMatch(t *testing.T) {
	rng := rand.New(rand.NewPCG(1, 2))
	slab := NewSlab()
	for range 50000 {
		query, lines := randomCase(rng)
		pattern := ParsePattern(query)
		chars := ToChars([]byte(lines[0]))
		_, _, want := pattern.Match(DefaultScheme, &chars, false, slab)
		if got := pattern.Matches(DefaultScheme, &chars, slab); got != want {
			t.Fatalf("query %q text %q: Matches = %v, Match ok = %v", query, lines[0], got, want)
		}
	}
}

// MayMatchWithin may let a text through that no line matches, but must never
// reject one that some line does.
func TestMayMatchWithinNeverRejectsAMatch(t *testing.T) {
	rng := rand.New(rand.NewPCG(3, 4))
	for range 50000 {
		query, lines := randomCase(rng)
		pattern := ParsePattern(query)
		for _, line := range lines {
			chars := ToChars([]byte(line))
			if _, _, ok := pattern.Match(DefaultScheme, &chars, false, nil); !ok {
				continue
			}
			text := strings.Join(lines, "\n")
			if !pattern.MayMatchWithin([]byte(text)) {
				t.Fatalf("query %q rejected %q, whose line %q matches", query, text, line)
			}
			break
		}
	}
}

func TestMayMatchWithin(t *testing.T) {
	tests := []struct {
		query string
		text  string
		want  bool
	}{
		// The terms may be found on different lines; only a line can match.
		{"search timeout", "search\ntimeout\n", true},
		{"search timeout", "search\n", false},
		{"stmo", "searchTimeout", true},
		{"tmos", "searchTimeout", false},
		{"'Timeout", "searchtimeout", false},
		{"'timeout", "searchTIMEOUT", true},
		{"^time", "x time", true},
		{"out$", "outer", true},
		{"'tim'", "timer", true},
		{"zzz | time", "timeout", true},
		{"zzz | yyy", "timeout", false},
		// An exclusion is satisfied by a line that lacks it.
		{"!timeout", "timeout", true},
		{"time !x", "timeout", true},
		// Non-ASCII text is never rejected: normalization and lowercasing can
		// match it from ASCII terms no byte search would find.
		{"cafe", "café", true},
		{"k", "K", true},
		{"zzz", "é", true},
		{"é", "e", false},
	}
	for _, tt := range tests {
		t.Run(tt.query+" / "+tt.text, func(t *testing.T) {
			if got := ParsePattern(tt.query).MayMatchWithin([]byte(tt.text)); got != tt.want {
				t.Errorf("got %v, want %v", got, tt.want)
			}
		})
	}
}
