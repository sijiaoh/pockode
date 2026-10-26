// This file is ported from fzf v0.74.5, src/pattern_test.go
// (https://github.com/junegunn/fzf). Changes from the original: only the
// tests of what pattern.go keeps are ported (parsing, exact, equal, case),
// adapted to the fixed options; the --exact parsing, --nth, cache and
// benchmark tests are left out with the features they test. The tests read
// a term's own case and normalize flags, since a Pattern has no global ones.
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

import "testing"

func TestParseTermsExtended(t *testing.T) {
	terms := parseTerms(
		"aaa 'bbb ^ccc ddd$ !eee !'fff !^ggg !hhh$ | ^iii$ ^xxx | 'yyy | zzz$ | !ZZZ |")
	if len(terms) != 9 ||
		terms[0][0].typ != termFuzzy || terms[0][0].inv ||
		terms[1][0].typ != termExact || terms[1][0].inv ||
		terms[2][0].typ != termPrefix || terms[2][0].inv ||
		terms[3][0].typ != termSuffix || terms[3][0].inv ||
		terms[4][0].typ != termExact || !terms[4][0].inv ||
		terms[5][0].typ != termFuzzy || !terms[5][0].inv ||
		terms[6][0].typ != termPrefix || !terms[6][0].inv ||
		terms[7][0].typ != termSuffix || !terms[7][0].inv ||
		terms[7][1].typ != termEqual || terms[7][1].inv ||
		terms[8][0].typ != termPrefix || terms[8][0].inv ||
		terms[8][1].typ != termExact || terms[8][1].inv ||
		terms[8][2].typ != termSuffix || terms[8][2].inv ||
		terms[8][3].typ != termExact || !terms[8][3].inv {
		t.Errorf("%v", terms)
	}
	for _, termSet := range terms[:8] {
		term := termSet[0]
		if len(term.text) != 3 {
			t.Errorf("%v", term)
		}
	}
}

func TestParseTermsEmpty(t *testing.T) {
	terms := parseTerms("' ^ !' !^")
	if len(terms) != 0 {
		t.Errorf("%v", terms)
	}
}

func TestExact(t *testing.T) {
	pattern := ParsePattern("'abc")
	term := pattern.termSets[0][0]
	chars := ToChars([]byte("aabbcc abc"))
	res, pos := DefaultScheme.ExactMatchNaive(
		term.caseSensitive, term.normalize, true, &chars, term.text, true, nil)
	if res.Start != 7 || res.End != 10 {
		t.Errorf("%v / %d / %d", pattern.termSets, res.Start, res.End)
	}
	if pos != nil {
		t.Errorf("pos is expected to be nil")
	}
}

func TestEqual(t *testing.T) {
	pattern := ParsePattern("^AbC$")
	term := pattern.termSets[0][0]

	match := func(str string, sidxExpected int, eidxExpected int) {
		chars := ToChars([]byte(str))
		res, pos := DefaultScheme.EqualMatch(
			term.caseSensitive, term.normalize, true, &chars, term.text, true, nil)
		if res.Start != sidxExpected || res.End != eidxExpected {
			t.Errorf("%v / %d / %d", pattern.termSets, res.Start, res.End)
		}
		if pos != nil {
			t.Errorf("pos is expected to be nil")
		}
	}
	match("ABC", -1, -1)
	match("AbC", 0, 3)
	match("AbC  ", 0, 3)
	match(" AbC ", 1, 4)
	match("  AbC", 2, 5)
}

func TestCaseSensitivity(t *testing.T) {
	pat1 := ParsePattern("abc").termSets[0][0]
	pat2 := ParsePattern("Abc").termSets[0][0]

	if string(pat1.text) != "abc" || pat1.caseSensitive != false ||
		string(pat2.text) != "Abc" || pat2.caseSensitive != true {
		t.Error("Invalid case conversion")
	}
}
