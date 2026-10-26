package fuzzy

import (
	"fmt"
	"slices"
	"sync"
	"testing"
)

func match(t *testing.T, scheme *Scheme, query, text string) (int, []int, bool) {
	t.Helper()
	chars := ToChars([]byte(text))
	return ParsePattern(query).Match(scheme, &chars, true, NewSlab())
}

func TestPatternMatches(t *testing.T) {
	tests := []struct {
		query string
		text  string
		want  bool
	}{
		// Every term must match, in any order.
		{"fsstore", "web/src/lib/filesSearchStore.ts", true},
		{"store files", "web/src/lib/filesSearchStore.ts", true},
		{"store xyz", "web/src/lib/filesSearchStore.ts", false},

		{"'fss", "filesSearchStore.ts", false},
		{"'sse", "filesSearchStore.ts", true},
		{"'arch'", "filesSearchStore.ts", false},
		{"'search'", "files search store", true},
		{"^web", "web/src/app.ts", true},
		{"^src", "web/src/app.ts", false},
		{".ts$", "web/src/app.ts", true},
		{"app$", "web/src/app.ts", false},
		{"^app.ts$", "app.ts", true},
		{"^app$", "app.ts", false},

		{"app !test", "web/src/app.ts", true},
		{"app !test", "web/src/app.test.ts", false},
		// An excluding term is exact unless flipped back with '.
		{"app !tst", "web/src/app.test.ts", true},
		{"app !'tst", "web/src/app.test.ts", false},
		{"!^web", "web/src/app.ts", false},
		{"!.ts$", "web/src/app.go", true},
		{"!test", "anything", true},

		{"^web | ^server", "server/main.go", true},
		{"^web | ^server", "docs/main.md", false},
		{"main ^web | ^server", "server/main.go", true},
		// As in fzf, a leading bar is text and a trailing one is dropped.
		{"| main", "server/main.go", false},
		{"| main", "server/main|.go", true},
		{"main |", "server/main.go", true},

		{`my\ file`, "docs/my file.md", true},
		{`'y\ f`, "docs/my file.md", true},
		{`'y\ f`, "docs/myfile.md", false},

		// A lone $ is a fuzzy term for "$".
		{"$", "price: $5", true},
		{"$", "price", false},
	}
	for _, tt := range tests {
		t.Run(tt.query+" / "+tt.text, func(t *testing.T) {
			if _, _, ok := match(t, DefaultScheme, tt.query, tt.text); ok != tt.want {
				t.Errorf("matched = %v, want %v", ok, tt.want)
			}
		})
	}
}

func TestPatternSmartCase(t *testing.T) {
	tests := []struct {
		query string
		text  string
		want  bool
	}{
		{"store", "filesSearchStore.ts", true},
		{"STORE", "filesSearchStore.ts", false},
		{"Store", "filesSearchStore.ts", true},
		{"SSStore", "filesSearchStore.ts", false},
		{"'Store", "filesstore.ts", false},
		// Smart-case is decided per term, as in fzf.
		{"files Store", "FILES/Store.ts", true},
		{"Files store", "files/STORE.ts", false},
		// An uppercase letter in an excluding term makes it case-sensitive too.
		{"!Test", "app.test.ts", true},
		{"!test", "app.Test.ts", false},
	}
	for _, tt := range tests {
		t.Run(tt.query+" / "+tt.text, func(t *testing.T) {
			if _, _, ok := match(t, DefaultScheme, tt.query, tt.text); ok != tt.want {
				t.Errorf("matched = %v, want %v", ok, tt.want)
			}
		})
	}
}

func TestPatternNormalize(t *testing.T) {
	if _, _, ok := match(t, DefaultScheme, "cafe", "Café.md"); !ok {
		t.Error("an unaccented term should match accented text")
	}
	if _, _, ok := match(t, DefaultScheme, "café", "cafe.md"); ok {
		t.Error("an accented term should match only accented text")
	}
}

func TestPatternPositions(t *testing.T) {
	tests := []struct {
		query string
		text  string
		want  []int
	}{
		{"fss", "files/search/store", []int{0, 6, 13}},
		{"'arch", "filesSearchStore", []int{7, 8, 9, 10}},
		{"^fi le$", "file", []int{0, 1, 2, 3}},
		{"ar ch", "search", []int{2, 3, 4, 5}},
		// Overlapping terms report each position once.
		{"'sea 'arc", "search", []int{0, 1, 2, 3, 4}},
		// An excluding term marks nothing.
		{"app !test", "src/app.ts", []int{4, 5, 6}},
		// Rune indices, not byte indices.
		{"'日本", "こんにちは日本", []int{5, 6}},
		{"", "anything", nil},
	}
	for _, tt := range tests {
		t.Run(tt.query+" / "+tt.text, func(t *testing.T) {
			_, pos, ok := match(t, DefaultScheme, tt.query, tt.text)
			if !ok {
				t.Fatal("did not match")
			}
			if !slices.Equal(pos, tt.want) {
				t.Errorf("positions = %v, want %v", pos, tt.want)
			}
		})
	}

	chars := ToChars([]byte("filesSearchStore"))
	if _, pos, _ := ParsePattern("fss 'arch").Match(DefaultScheme, &chars, false, nil); pos != nil {
		t.Errorf("positions without withPos = %v, want nil", pos)
	}
}

func TestPatternScore(t *testing.T) {
	text := "web/src/lib/filesSearchStore.ts"
	chars := ToChars([]byte(text))
	single := func(algo Algo, pattern string) int {
		res, _ := algo(DefaultScheme, false, true, true, &chars, []rune(pattern), false, nil)
		return res.Score
	}

	score, _, _ := match(t, DefaultScheme, "fss 'store !test", text)
	want := single((*Scheme).FuzzyMatchV2, "fss") + single((*Scheme).ExactMatchNaive, "store")
	if score != want {
		t.Errorf("score = %d, want the positive terms' sum %d", score, want)
	}

	if score, _, ok := match(t, DefaultScheme, "  ", text); !ok || score != 0 {
		t.Errorf("empty query: score %d, matched %v; want 0, true", score, ok)
	}
	if !ParsePattern(" ' ! ").IsEmpty() || ParsePattern("a").IsEmpty() {
		t.Error("IsEmpty is wrong")
	}
}

func TestPatternScheme(t *testing.T) {
	// The path scheme rewards a match at the start of a path component more
	// than one after a space; the default scheme the other way round.
	query := "b"
	afterSlash, afterSpace := "aa/bb", "aa bb"
	for _, tt := range []struct {
		scheme   *Scheme
		name     string
		slashWin bool
	}{
		{PathScheme, "path", true},
		{DefaultScheme, "default", false},
	} {
		slash, _, _ := match(t, tt.scheme, query, afterSlash)
		space, _, _ := match(t, tt.scheme, query, afterSpace)
		if (slash > space) != tt.slashWin {
			t.Errorf("%s scheme: after slash %d, after space %d", tt.name, slash, space)
		}
	}
}

// One Pattern is shared by goroutines matching with different schemes, each
// with its own slab, and gives the same results as a sequential run.
func TestPatternConcurrent(t *testing.T) {
	pattern := ParsePattern("src 'Store !test | ^web .ts$")
	texts := []string{
		"web/src/lib/filesSearchStore.ts",
		"web/src/lib/filesSearchStore.test.ts",
		"server/src/Store.ts",
		"docs/store.md",
		"web/src/a b/Store.ts",
	}
	schemes := []*Scheme{DefaultScheme, PathScheme}
	run := func(slab *Slab) string {
		out := ""
		for _, scheme := range schemes {
			for _, text := range texts {
				chars := ToChars([]byte(text))
				score, pos, ok := pattern.Match(scheme, &chars, true, slab)
				out += fmt.Sprint(score, pos, ok, ";")
			}
		}
		return out
	}
	want := run(NewSlab())

	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			slab := NewSlab()
			for range 50 {
				if got := run(slab); got != want {
					t.Errorf("concurrent run = %s, want %s", got, want)
					return
				}
			}
		}()
	}
	wg.Wait()
}
