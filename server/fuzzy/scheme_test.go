package fuzzy

import (
	"fmt"
	"slices"
	"sync"
	"testing"
)

func TestSchemeBonuses(t *testing.T) {
	tests := []struct {
		name    string
		text    string
		pattern string
		// Expected scores of a one-character match: scoreMatch plus the
		// position's bonus, doubled for the first pattern character.
		defaultScore int
		pathScore    int
	}{
		{
			name: "after whitespace", text: "foo bar", pattern: "b",
			defaultScore: scoreMatch + (bonusBoundary+2)*bonusFirstCharMultiplier,
			pathScore:    scoreMatch + bonusBoundary*bonusFirstCharMultiplier,
		},
		{
			name: "after a delimiter of the default scheme only", text: "a:b", pattern: "b",
			defaultScore: scoreMatch + (bonusBoundary+1)*bonusFirstCharMultiplier,
			pathScore:    scoreMatch + bonusBoundary*bonusFirstCharMultiplier,
		},
		{
			name: "after a slash", text: "a/b", pattern: "b",
			defaultScore: scoreMatch + (bonusBoundary+1)*bonusFirstCharMultiplier,
			pathScore:    scoreMatch + (bonusBoundary+1)*bonusFirstCharMultiplier,
		},
		{
			// The path scheme reads the start of the text as following a
			// delimiter, the default scheme as following whitespace
			name: "start of text", text: "abc", pattern: "a",
			defaultScore: scoreMatch + (bonusBoundary+2)*bonusFirstCharMultiplier,
			pathScore:    scoreMatch + (bonusBoundary+1)*bonusFirstCharMultiplier,
		},
		{
			// Non-ASCII text classifies its runes outside the ASCII table
			name: "after a slash in non-ASCII text", text: "日/b", pattern: "b",
			defaultScore: scoreMatch + (bonusBoundary+1)*bonusFirstCharMultiplier,
			pathScore:    scoreMatch + (bonusBoundary+1)*bonusFirstCharMultiplier,
		},
	}
	for _, tt := range tests {
		for _, sc := range []struct {
			name   string
			scheme *Scheme
			want   int
		}{
			{"default", DefaultScheme, tt.defaultScore},
			{"path", PathScheme, tt.pathScore},
		} {
			for _, algo := range []struct {
				name string
				fn   Algo
			}{
				{"V1", (*Scheme).FuzzyMatchV1},
				{"V2", (*Scheme).FuzzyMatchV2},
			} {
				t.Run(fmt.Sprintf("%s/%s/%s", tt.name, sc.name, algo.name), func(t *testing.T) {
					chars := ToChars([]byte(tt.text))
					res, _ := algo.fn(sc.scheme, false, false, true, &chars, []rune(tt.pattern), false, nil)
					if res.Score != sc.want {
						t.Errorf("score = %d, want %d", res.Score, sc.want)
					}
				})
			}
		}
	}
}

// Name search and content search score with different schemes at the same
// time; neither may see the other's bonuses. Run with -race.
func TestSchemesConcurrently(t *testing.T) {
	texts := []string{
		"src/components/FileSearch.tsx", "server/search/search.go",
		"web/src/stores/filesSearchStore.ts", "docs/code/work-system.md",
		"a: b, c; d | e", "foo bar baz", "日本語/ファイル.txt", "Só Danço Samba",
	}
	patterns := []string{"fs", "fss", "src", "sea", "b", "ab", "fsst", "go", "日フ", "danco"}
	schemes := []*Scheme{DefaultScheme, PathScheme}

	type outcome struct {
		res Result
		pos []int
	}
	run := func(scheme *Scheme, slab *Slab) []outcome {
		var out []outcome
		for _, text := range texts {
			chars := ToChars([]byte(text))
			for _, p := range patterns {
				pattern := NormalizeRunes([]rune(p))
				res, pos := scheme.FuzzyMatchV2(false, true, true, &chars, pattern, true, slab)
				out = append(out, outcome{res, pos})
			}
		}
		return out
	}

	want := make([][]outcome, len(schemes))
	for i, scheme := range schemes {
		want[i] = run(scheme, nil)
	}
	if slices.EqualFunc(want[0], want[1], func(a, b outcome) bool { return a.res == b.res }) {
		t.Fatal("the schemes score the corpus identically, so the test cannot tell them apart")
	}

	var wg sync.WaitGroup
	for g := range 8 {
		wg.Go(func() {
			i := g % len(schemes)
			slab := NewSlab()
			for range 50 {
				got := run(schemes[i], slab)
				for k := range got {
					if got[k].res != want[i][k].res || !slices.Equal(got[k].pos, want[i][k].pos) {
						t.Errorf("scheme %d, case %d: got %v %v, want %v %v",
							i, k, got[k].res, got[k].pos, want[i][k].res, want[i][k].pos)
						return
					}
				}
			}
		})
	}
	wg.Wait()
}

// Positions count runes the way ranging over the text as a string does, which
// is what a caller converts into highlight offsets of another encoding.
func TestPositionsAreRuneIndices(t *testing.T) {
	tests := []struct {
		name    string
		text    string
		pattern string
		want    []int
	}{
		{name: "ASCII", text: "src/fooBar.go", pattern: "fb", want: []int{4, 7}},
		{name: "multibyte runes before the match", text: "日本/fooBar.go", pattern: "fb", want: []int{3, 6}},
		{name: "matched multibyte runes", text: "docs/日本語.md", pattern: "日語", want: []int{5, 7}},
		{name: "invalid UTF-8 counts one rune per byte", text: "\xff\xfe/fooBar", pattern: "fb", want: []int{3, 6}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			chars := ToChars([]byte(tt.text))
			var runes []rune
			for _, r := range tt.text {
				runes = append(runes, r)
			}
			if chars.Length() != len(runes) {
				t.Fatalf("Length() = %d, ranging over the string yields %d runes", chars.Length(), len(runes))
			}
			for _, algo := range []struct {
				name string
				fn   Algo
			}{
				{"V1", (*Scheme).FuzzyMatchV1},
				{"V2", (*Scheme).FuzzyMatchV2},
			} {
				_, pos := algo.fn(PathScheme, false, false, true, &chars, []rune(tt.pattern), true, NewSlab())
				slices.Sort(pos)
				if !slices.Equal(pos, tt.want) {
					t.Errorf("%s positions = %v, want %v", algo.name, pos, tt.want)
				}
			}
		})
	}
}

func TestNormalizedBounds(t *testing.T) {
	lo, hi := rune(-1), rune(-1)
	for r := range normalized {
		if lo < 0 || r < lo {
			lo = r
		}
		if r > hi {
			hi = r
		}
	}
	if lo != normalizedMin || hi != normalizedMax {
		t.Errorf("normalized keys span [%#x, %#x], constants say [%#x, %#x]", lo, hi, normalizedMin, normalizedMax)
	}
}
