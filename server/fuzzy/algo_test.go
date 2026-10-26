// This file is ported from fzf v0.74.5, src/algo/algo_test.go
// (https://github.com/junegunn/fzf), against DefaultScheme, which is what
// fzf's tests initialize. The scheme's bonuses stand in for fzf's globals of
// the same names.
//
// The MIT License (MIT)
//
// Copyright (c) 2013-2026 Junegunn Choi
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

package fuzzy

import (
	"math"
	"sort"
	"strings"
	"testing"
)

var (
	bonusBoundaryWhite     = DefaultScheme.bonusBoundaryWhite
	bonusBoundaryDelimiter = DefaultScheme.bonusBoundaryDelimiter
)

var (
	FuzzyMatchV1       Algo = (*Scheme).FuzzyMatchV1
	FuzzyMatchV2       Algo = (*Scheme).FuzzyMatchV2
	ExactMatchNaive    Algo = (*Scheme).ExactMatchNaive
	ExactMatchBoundary Algo = (*Scheme).ExactMatchBoundary
	PrefixMatch        Algo = (*Scheme).PrefixMatch
	SuffixMatch        Algo = (*Scheme).SuffixMatch
	EqualMatch         Algo = (*Scheme).EqualMatch
)

func assertMatch(t *testing.T, fun Algo, caseSensitive, forward bool, input, pattern string, sidx int, eidx int, score int) {
	assertMatch2(t, fun, caseSensitive, false, forward, input, pattern, sidx, eidx, score)
}

func assertMatch2(t *testing.T, fun Algo, caseSensitive, normalize, forward bool, input, pattern string, sidx int, eidx int, score int) {
	if !caseSensitive {
		pattern = strings.ToLower(pattern)
	}
	chars := ToChars([]byte(input))
	res, pos := fun(DefaultScheme, caseSensitive, normalize, forward, &chars, []rune(pattern), true, nil)
	var start, end int
	if len(pos) == 0 {
		start = res.Start
		end = res.End
	} else {
		sort.Ints(pos)
		start = pos[0]
		end = pos[len(pos)-1] + 1
	}
	if start != sidx {
		t.Errorf("Invalid start index: %d (expected: %d, %s / %s)", start, sidx, input, pattern)
	}
	if end != eidx {
		t.Errorf("Invalid end index: %d (expected: %d, %s / %s)", end, eidx, input, pattern)
	}
	if res.Score != score {
		t.Errorf("Invalid score: %d (expected: %d, %s / %s)", res.Score, score, input, pattern)
	}
}

func TestFuzzyMatch(t *testing.T) {
	for _, fn := range []Algo{FuzzyMatchV1, FuzzyMatchV2} {
		for _, forward := range []bool{true, false} {
			assertMatch(t, fn, false, forward, "fooBarbaz1", "oBZ", 2, 9,
				scoreMatch*3+bonusCamel123+scoreGapStart+scoreGapExtension*3)
			assertMatch(t, fn, false, forward, "foo bar baz", "fbb", 0, 9,
				scoreMatch*3+int(bonusBoundaryWhite)*bonusFirstCharMultiplier+
					int(bonusBoundaryWhite)*2+2*scoreGapStart+4*scoreGapExtension)
			assertMatch(t, fn, false, forward, "/AutomatorDocument.icns", "rdoc", 9, 13,
				scoreMatch*4+bonusCamel123+bonusConsecutive*2)
			assertMatch(t, fn, false, forward, "/man1/zshcompctl.1", "zshc", 6, 10,
				scoreMatch*4+int(bonusBoundaryDelimiter)*bonusFirstCharMultiplier+int(bonusBoundaryDelimiter)*3)
			assertMatch(t, fn, false, forward, "/.oh-my-zsh/cache", "zshc", 8, 13,
				scoreMatch*4+bonusBoundary*bonusFirstCharMultiplier+bonusBoundary*2+scoreGapStart+int(bonusBoundaryDelimiter))
			// Non-word character at start of input is treated as a strong boundary
			assertMatch(t, fn, false, forward, ".vimrc", ".vimrc", 0, 6,
				scoreMatch*6+int(bonusBoundaryWhite)*(bonusFirstCharMultiplier+5))
			// Non-word character right after a delimiter inherits the delimiter boundary
			assertMatch(t, fn, false, forward, "/.vimrc", ".vimrc", 1, 7,
				scoreMatch*6+int(bonusBoundaryDelimiter)*(bonusFirstCharMultiplier+5))
			// Non-word character in the middle of a word stays at bonusNonWord
			assertMatch(t, fn, false, forward, "a.vimrc", ".vimrc", 1, 7,
				scoreMatch*6+bonusBoundary*(bonusFirstCharMultiplier+5))
			assertMatch(t, fn, false, forward, "ab0123 456", "12356", 3, 10,
				scoreMatch*5+bonusConsecutive*3+scoreGapStart+scoreGapExtension)
			assertMatch(t, fn, false, forward, "abc123 456", "12356", 3, 10,
				scoreMatch*5+bonusCamel123*bonusFirstCharMultiplier+bonusCamel123*2+bonusConsecutive+scoreGapStart+scoreGapExtension)
			assertMatch(t, fn, false, forward, "foo/bar/baz", "fbb", 0, 9,
				scoreMatch*3+int(bonusBoundaryWhite)*bonusFirstCharMultiplier+
					int(bonusBoundaryDelimiter)*2+2*scoreGapStart+4*scoreGapExtension)
			assertMatch(t, fn, false, forward, "fooBarBaz", "fbb", 0, 7,
				scoreMatch*3+int(bonusBoundaryWhite)*bonusFirstCharMultiplier+
					bonusCamel123*2+2*scoreGapStart+2*scoreGapExtension)
			assertMatch(t, fn, false, forward, "foo barbaz", "fbb", 0, 8,
				scoreMatch*3+int(bonusBoundaryWhite)*bonusFirstCharMultiplier+int(bonusBoundaryWhite)+
					scoreGapStart*2+scoreGapExtension*3)
			assertMatch(t, fn, false, forward, "fooBar Baz", "foob", 0, 4,
				scoreMatch*4+int(bonusBoundaryWhite)*bonusFirstCharMultiplier+int(bonusBoundaryWhite)*3)
			assertMatch(t, fn, false, forward, "xFoo-Bar Baz", "foo-b", 1, 6,
				scoreMatch*5+bonusCamel123*bonusFirstCharMultiplier+bonusCamel123*2+
					bonusNonWord+bonusBoundary)

			assertMatch(t, fn, true, forward, "fooBarbaz", "oBz", 2, 9,
				scoreMatch*3+bonusCamel123+scoreGapStart+scoreGapExtension*3)
			assertMatch(t, fn, true, forward, "Foo/Bar/Baz", "FBB", 0, 9,
				scoreMatch*3+int(bonusBoundaryWhite)*bonusFirstCharMultiplier+int(bonusBoundaryDelimiter)*2+
					scoreGapStart*2+scoreGapExtension*4)
			assertMatch(t, fn, true, forward, "FooBarBaz", "FBB", 0, 7,
				scoreMatch*3+int(bonusBoundaryWhite)*bonusFirstCharMultiplier+bonusCamel123*2+
					scoreGapStart*2+scoreGapExtension*2)
			assertMatch(t, fn, true, forward, "FooBar Baz", "FooB", 0, 4,
				scoreMatch*4+int(bonusBoundaryWhite)*bonusFirstCharMultiplier+int(bonusBoundaryWhite)*2+
					max(bonusCamel123, int(bonusBoundaryWhite)))

			// Consecutive bonus updated
			assertMatch(t, fn, true, forward, "foo-bar", "o-ba", 2, 6,
				scoreMatch*4+bonusBoundary*3)

			// Non-match
			assertMatch(t, fn, true, forward, "fooBarbaz", "oBZ", -1, -1, 0)
			assertMatch(t, fn, true, forward, "Foo Bar Baz", "fbb", -1, -1, 0)
			assertMatch(t, fn, true, forward, "fooBarbaz", "fooBarbazz", -1, -1, 0)
		}
	}
}

func TestFuzzyMatchBackward(t *testing.T) {
	assertMatch(t, FuzzyMatchV1, false, true, "foobar fb", "fb", 0, 4,
		scoreMatch*2+int(bonusBoundaryWhite)*bonusFirstCharMultiplier+
			scoreGapStart+scoreGapExtension)
	assertMatch(t, FuzzyMatchV1, false, false, "foobar fb", "fb", 7, 9,
		scoreMatch*2+int(bonusBoundaryWhite)*bonusFirstCharMultiplier+int(bonusBoundaryWhite))
}

func TestExactMatchNaive(t *testing.T) {
	for _, dir := range []bool{true, false} {
		assertMatch(t, ExactMatchNaive, true, dir, "fooBarbaz", "oBA", -1, -1, 0)
		assertMatch(t, ExactMatchNaive, true, dir, "fooBarbaz", "fooBarbazz", -1, -1, 0)

		assertMatch(t, ExactMatchNaive, false, dir, "fooBarbaz", "oBA", 2, 5,
			scoreMatch*3+bonusCamel123+bonusConsecutive)
		assertMatch(t, ExactMatchNaive, false, dir, "/AutomatorDocument.icns", "rdoc", 9, 13,
			scoreMatch*4+bonusCamel123+bonusConsecutive*2)
		assertMatch(t, ExactMatchNaive, false, dir, "/man1/zshcompctl.1", "zshc", 6, 10,
			scoreMatch*4+int(bonusBoundaryDelimiter)*(bonusFirstCharMultiplier+3))
		assertMatch(t, ExactMatchNaive, false, dir, "/.oh-my-zsh/cache", "zsh/c", 8, 13,
			scoreMatch*5+bonusBoundary*(bonusFirstCharMultiplier+3)+int(bonusBoundaryDelimiter))
	}
}

func TestExactMatchNaiveBackward(t *testing.T) {
	assertMatch(t, ExactMatchNaive, false, true, "foobar foob", "oo", 1, 3,
		scoreMatch*2+bonusConsecutive)
	assertMatch(t, ExactMatchNaive, false, false, "foobar foob", "oo", 8, 10,
		scoreMatch*2+bonusConsecutive)
}

func TestPrefixMatch(t *testing.T) {
	score := scoreMatch*3 + int(bonusBoundaryWhite)*bonusFirstCharMultiplier + int(bonusBoundaryWhite)*2

	for _, dir := range []bool{true, false} {
		assertMatch(t, PrefixMatch, true, dir, "fooBarbaz", "Foo", -1, -1, 0)
		assertMatch(t, PrefixMatch, false, dir, "fooBarBaz", "baz", -1, -1, 0)
		assertMatch(t, PrefixMatch, false, dir, "fooBarbaz", "Foo", 0, 3, score)
		assertMatch(t, PrefixMatch, false, dir, "foOBarBaZ", "foo", 0, 3, score)
		assertMatch(t, PrefixMatch, false, dir, "f-oBarbaz", "f-o", 0, 3, score)

		assertMatch(t, PrefixMatch, false, dir, " fooBar", "foo", 1, 4, score)
		assertMatch(t, PrefixMatch, false, dir, " fooBar", " fo", 0, 3, score)
		assertMatch(t, PrefixMatch, false, dir, "     fo", "foo", -1, -1, 0)
	}
}

func TestSuffixMatch(t *testing.T) {
	for _, dir := range []bool{true, false} {
		assertMatch(t, SuffixMatch, true, dir, "fooBarbaz", "Baz", -1, -1, 0)
		assertMatch(t, SuffixMatch, false, dir, "fooBarbaz", "Foo", -1, -1, 0)

		assertMatch(t, SuffixMatch, false, dir, "fooBarbaz", "baz", 6, 9,
			scoreMatch*3+bonusConsecutive*2)
		assertMatch(t, SuffixMatch, false, dir, "fooBarBaZ", "baz", 6, 9,
			(scoreMatch+bonusCamel123)*3+bonusCamel123*(bonusFirstCharMultiplier-1))

		// Strip trailing white space from the string
		assertMatch(t, SuffixMatch, false, dir, "fooBarbaz ", "baz", 6, 9,
			scoreMatch*3+bonusConsecutive*2)

		// Only when the pattern doesn't end with a space
		assertMatch(t, SuffixMatch, false, dir, "fooBarbaz ", "baz ", 6, 10,
			scoreMatch*4+bonusConsecutive*2+int(bonusBoundaryWhite))
	}
}

func TestEmptyPattern(t *testing.T) {
	for _, dir := range []bool{true, false} {
		assertMatch(t, FuzzyMatchV1, true, dir, "foobar", "", 0, 0, 0)
		assertMatch(t, FuzzyMatchV2, true, dir, "foobar", "", 0, 0, 0)
		assertMatch(t, ExactMatchNaive, true, dir, "foobar", "", 0, 0, 0)
		assertMatch(t, PrefixMatch, true, dir, "foobar", "", 0, 0, 0)
		assertMatch(t, SuffixMatch, true, dir, "foobar", "", 6, 6, 0)
	}
}

func TestNormalize(t *testing.T) {
	caseSensitive := false
	normalize := true
	forward := true
	test := func(input, pattern string, sidx, eidx, score int, funs ...Algo) {
		for _, fun := range funs {
			assertMatch2(t, fun, caseSensitive, normalize, forward,
				input, pattern, sidx, eidx, score)
		}
	}
	test("Só Danço Samba", "So", 0, 2, 62, FuzzyMatchV1, FuzzyMatchV2, PrefixMatch, ExactMatchNaive)
	test("Só Danço Samba", "sodc", 0, 7, 97, FuzzyMatchV1, FuzzyMatchV2)
	test("Danço", "danco", 0, 5, 140, FuzzyMatchV1, FuzzyMatchV2, PrefixMatch, SuffixMatch, ExactMatchNaive, EqualMatch)
}

func TestLongString(t *testing.T) {
	bytes := make([]byte, math.MaxUint16*2)
	for i := range bytes {
		bytes[i] = 'x'
	}
	bytes[math.MaxUint16] = 'z'
	assertMatch(t, FuzzyMatchV2, true, true, string(bytes), "zx", math.MaxUint16, math.MaxUint16+2, scoreMatch*2+bonusConsecutive)
}

func TestLongStringWithNormalize(t *testing.T) {
	bytes := make([]byte, 30000)
	for i := range bytes {
		bytes[i] = 'x'
	}
	unicodeString := string(bytes) + " Minímal example"
	assertMatch2(t, FuzzyMatchV1, false, true, false, unicodeString, "minim", 30001, 30006, 140)
}

func TestResultPositionsWithReusedSlab(t *testing.T) {
	// Backtrace positions in equal-score ties must not depend on data
	// a previous match left in the slab
	pattern := []rune("co/")
	target := ToChars([]byte("core_color/view/server.txt"))
	_, freshPos := DefaultScheme.FuzzyMatchV2(false, false, true, &target, pattern, true, NewSlab())

	slab := NewSlab()
	dirty := ToChars([]byte("completion/keybinding/client/handler/writer_index.txt"))
	DefaultScheme.FuzzyMatchV2(false, false, true, &dirty, pattern, true, slab)
	_, reusedPos := DefaultScheme.FuzzyMatchV2(false, false, true, &target, pattern, true, slab)

	if len(freshPos) != len(reusedPos) {
		t.Fatalf("position count mismatch: %v vs %v", freshPos, reusedPos)
	}
	for i := range freshPos {
		if freshPos[i] != reusedPos[i] {
			t.Errorf("positions differ with reused slab: %v vs %v", freshPos, reusedPos)
			break
		}
	}
}

// TestFuzzyMatchV2TwoEquivalence verifies that the two-character fast path
// produces the same Result and positions as the general algorithm across
// case sensitivity, direction, and withPos, using a reused slab to surface
// any stale-data reads in the backtrace.
func TestFuzzyMatchV2TwoEquivalence(t *testing.T) {
	words := []string{"src", "main", "core", "config", "parser", "render", "server",
		"client", "index", "handler", "util", "list", "cache", "reader"}
	exts := []string{".go", ".rb", ".py", ".md", ".c", ".txt"}
	// Deterministic corpus (LCG), plus adversarial short/repeated items
	corpus := []Chars{}
	seed := uint32(12345)
	next := func(n int) int { seed = seed*1664525 + 1013904223; return int(seed>>8) % n }
	for i := 0; i < 4000; i++ {
		depth := 2 + next(4)
		s := ""
		for d := 0; d < depth; d++ {
			if d > 0 {
				s += "/"
			}
			s += words[next(len(words))]
			if next(5) == 0 {
				s += "_" + words[next(len(words))]
			}
		}
		s += exts[next(len(exts))]
		corpus = append(corpus, ToChars([]byte(s)))
	}
	for _, s := range []string{"", "a", "ab", "aa", "aXb", "a/b", "//", "..", "abcabc",
		"AaBb", "x.y.z", "a_b_c", "CoreCore", "  co"} {
		corpus = append(corpus, ToChars([]byte(s)))
	}

	pats := []string{"co", "ab", "aa", "//", "..", "sr", "a/", "_c", "oo", "Ab",
		"z.", "b.", "1a", "ll", "re", "er", "Co"}
	slab := NewSlab()
	for _, cs := range []bool{false, true} {
		for _, fwd := range []bool{true, false} {
			for _, wp := range []bool{false, true} {
				for _, p := range pats {
					pattern := []rune(p)
					for j := range corpus {
						rg, pg := DefaultScheme.fuzzyMatchV2(cs, false, fwd, &corpus[j], pattern, wp, slab, false)
						rt, pt := DefaultScheme.FuzzyMatchV2(cs, false, fwd, &corpus[j], pattern, wp, slab)
						if rg != rt {
							t.Fatalf("Result cs=%v fwd=%v wp=%v pat=%q item=%q: general %v vs two %v",
								cs, fwd, wp, p, corpus[j].String(), rg, rt)
						}
						if !samePos(pg, pt) {
							t.Fatalf("Pos cs=%v fwd=%v wp=%v pat=%q item=%q: general %v vs two %v",
								cs, fwd, wp, p, corpus[j].String(), pg, pt)
						}
					}
				}
			}
		}
	}
}
