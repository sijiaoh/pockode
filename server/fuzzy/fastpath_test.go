// This file is ported from fzf v0.74.5, src/algo/fastpath_equiv_test.go
// (https://github.com/junegunn/fzf). The fast paths are switched off by a
// parameter of fuzzyMatchV2 instead of fzf's package-level test hooks, so
// these may run in parallel with anything.
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

// Equivalence tests for the single- and two-character fast paths against the
// general FuzzyMatchV2 algorithm, which serves as the reference.
//
// Two complementary strategies:
//   - Exhaustive: every string up to a fixed length over an alphabet that
//     covers all ASCII character classes, so every local scoring branch is
//     exercised (not merely sampled).
//   - Fuzz: coverage-guided, arbitrary length, to reach cases the bounded
//     exhaustive sweep cannot (e.g. long gaps where a high score decays).

import (
	"slices"
	"testing"
)

// One char of each ASCII class that affects scoring: lower, upper, delimiter,
// number, non-word, whitespace.
var equivAlphabet = []byte{'a', 'B', '/', '1', '_', ' '}

func samePos(a, b []int) bool {
	return (a == nil) == (b == nil) && slices.Equal(a, b)
}

// compareFastPath runs a single input/pattern/params pair through both the
// fast path and the general algorithm and fails on any difference.
func compareFastPath(t *testing.T, chars *Chars, pattern []rune, cs, norm, fwd, wp bool, slab *Slab) {
	t.Helper()
	rg, pg := DefaultScheme.fuzzyMatchV2(cs, norm, fwd, chars, pattern, wp, slab, false)
	rt, pt := DefaultScheme.FuzzyMatchV2(cs, norm, fwd, chars, pattern, wp, slab)
	if rg != rt || !samePos(pg, pt) {
		t.Fatalf("mismatch item=%q pat=%q cs=%v norm=%v fwd=%v wp=%v: general %v %v vs fast %v %v",
			chars.String(), string(pattern), cs, norm, fwd, wp, rg, pg, rt, pt)
	}
}

// lowerPattern lowercases the pattern for case-insensitive search, matching
// the Algo contract (fzf pre-lowercases it in BuildPattern).
func lowerPattern(p []rune, cs bool) []rune {
	if cs {
		return p
	}
	out := make([]rune, len(p))
	for i, c := range p {
		if c >= 'A' && c <= 'Z' {
			c += 32
		}
		out[i] = c
	}
	return out
}

func runExhaustive(t *testing.T, patLen, maxLen int) {
	// All patterns of length patLen over the alphabet
	var pats [][]rune
	var genPat func(cur []rune)
	genPat = func(cur []rune) {
		if len(cur) == patLen {
			pats = append(pats, append([]rune(nil), cur...))
			return
		}
		for _, c := range equivAlphabet {
			genPat(append(cur, rune(c)))
		}
	}
	genPat(nil)

	slab := NewSlab()
	buf := make([]byte, 0, maxLen)
	var rec func(depth int)
	rec = func(depth int) {
		chars := ToChars(append([]byte(nil), buf...))
		// normalize is not varied: normalizeRune is the identity below 0xC0,
		// and the general algorithm skips normalization on its ASCII branch,
		// so it cannot change the result for the ASCII-only fast path. The
		// fuzz test exercises normalize=true as a guard against that changing.
		for _, cs := range []bool{false, true} {
			for _, fwd := range []bool{true, false} {
				for _, wp := range []bool{false, true} {
					for _, p := range pats {
						compareFastPath(t, &chars, lowerPattern(p, cs), cs, false, fwd, wp, slab)
					}
				}
			}
		}
		if depth == maxLen {
			return
		}
		for _, c := range equivAlphabet {
			buf = append(buf, c)
			rec(depth + 1)
			buf = buf[:len(buf)-1]
		}
	}
	rec(0)
}

func TestFuzzyMatchV2SingleExhaustive(t *testing.T) {
	runExhaustive(t, 1, 6)
}

func TestFuzzyMatchV2TwoExhaustive(t *testing.T) {
	runExhaustive(t, 2, 6)
}

func fuzzFastPath(f *testing.F, patLen int) {
	inputs := []string{"core_color/view/server.txt", "a                        b",
		"XyZ/123_abc.def", "aaaaaaaaaaaaaaaaaaaaaaaa"}
	// Seed patterns of the right length; wrong-length seeds are rejected below
	// and would waste the corpus.
	seedPats := map[int][]string{1: {"c", "a", "/"}, 2: {"co", "ab", "z1", "aa"}}[patLen]
	for _, in := range inputs {
		for _, p := range seedPats {
			f.Add(in, p)
		}
	}
	slab := &Slab{i16: make([]int16, 200*1024), i32: make([]int32, 4096)}
	f.Fuzz(func(t *testing.T, input, pat string) {
		r := []rune(pat)
		if len(r) != patLen {
			return
		}
		for _, c := range r {
			if c >= 128 {
				return
			}
		}
		chars := ToChars([]byte(input))
		if !chars.IsBytes() {
			return
		}
		for _, cs := range []bool{false, true} {
			for _, norm := range []bool{false, true} {
				for _, fwd := range []bool{true, false} {
					for _, wp := range []bool{false, true} {
						compareFastPath(t, &chars, lowerPattern(r, cs), cs, norm, fwd, wp, slab)
					}
				}
			}
		}
	})
}

func FuzzFuzzyMatchV2Single(f *testing.F) { fuzzFastPath(f, 1) }
func FuzzFuzzyMatchV2Two(f *testing.F)    { fuzzFastPath(f, 2) }
