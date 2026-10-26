// This file is ported from fzf v0.74.5, src/pattern.go
// (https://github.com/junegunn/fzf). Changes from the original:
//
//   - Only the extended search syntax is kept, with fzf's defaults fixed:
//     fuzzy terms by default, FuzzyMatchV2, smart-case, normalization, and
//     forward scanning. The non-extended mode, --exact, the case options,
//     --nth / --delimiter, the denylist and the result cache are left out.
//   - A Pattern is built once and is immutable: the scheme and the slab are
//     arguments of Match, so one Pattern serves every goroutine and scheme.
//   - Match scores a single text and returns the positions of all positive
//     terms merged, sorted and deduplicated, instead of an fzf Result and the
//     raw per-term position lists.
//   - Matches gives Match's verdict alone, finding fuzzy terms with
//     FuzzyMatchV1 instead of FuzzyMatchV2.
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
	"regexp"
	"slices"
	"strings"
)

// fuzzy
// 'exact
// 'exact-boundary'
// ^prefix-exact
// suffix-exact$
// ^equal-exact$
// !inverse-exact
// !'inverse-fuzzy
// !^inverse-prefix-exact
// !inverse-suffix-exact$

type termType int

const (
	termFuzzy termType = iota
	termExact
	termExactBoundary
	termPrefix
	termSuffix
	termEqual
)

var termAlgos = [...]Algo{
	termFuzzy:         (*Scheme).FuzzyMatchV2,
	termExact:         (*Scheme).ExactMatchNaive,
	termExactBoundary: (*Scheme).ExactMatchBoundary,
	termPrefix:        (*Scheme).PrefixMatch,
	termSuffix:        (*Scheme).SuffixMatch,
	termEqual:         (*Scheme).EqualMatch,
}

type term struct {
	typ           termType
	inv           bool
	text          []rune
	caseSensitive bool
	normalize     bool
}

// A termSet is the terms of one OR group ("a | b"): it matches when any of
// them does.
type termSet []term

// Pattern is a parsed query in fzf's extended search syntax. It is immutable,
// so one Pattern is shared by every goroutine matching it.
//
// Space-separated terms must all match, in any order. A term is fuzzy
// unless it is written 'exact, 'exact-on-word-boundaries', ^prefix, suffix$
// or ^equal$; !term excludes texts that contain it exactly (!'term: fuzzily).
// "a | b" matches either term. A space escaped as "\ " is part of a term.
//
// Each term is case-sensitive only if it contains an uppercase letter
// (smart-case, decided per term as in fzf), and a term with no accented
// letter also matches accented ones ("e" matches "é", "é" does not match "e").
type Pattern struct {
	termSets []termSet
}

var splitRegex = regexp.MustCompile(" +")

// ParsePattern parses a query typed by the user. It never fails: like fzf,
// it reads anything it does not recognize as text to match.
func ParsePattern(query string) *Pattern {
	query = strings.TrimLeft(query, " ")
	for strings.HasSuffix(query, " ") && !strings.HasSuffix(query, "\\ ") {
		query = query[:len(query)-1]
	}
	return &Pattern{termSets: parseTerms(query)}
}

func parseTerms(str string) []termSet {
	str = strings.ReplaceAll(str, "\\ ", "\t")
	tokens := splitRegex.Split(str, -1)
	sets := []termSet{}
	set := termSet{}
	switchSet := false
	afterBar := false
	for _, token := range tokens {
		typ, inv, text := termFuzzy, false, strings.ReplaceAll(token, "\t", " ")
		lowerText := strings.ToLower(text)
		caseSensitive := text != lowerText
		normalizeTerm := lowerText == string(NormalizeRunes([]rune(lowerText)))
		if !caseSensitive {
			text = lowerText
		}

		if len(set) > 0 && !afterBar && text == "|" {
			switchSet = false
			afterBar = true
			continue
		}
		afterBar = false

		if strings.HasPrefix(text, "!") {
			inv = true
			typ = termExact
			text = text[1:]
		}

		if text != "$" && strings.HasSuffix(text, "$") {
			typ = termSuffix
			text = text[:len(text)-1]
		}

		if len(text) > 2 && strings.HasPrefix(text, "'") && strings.HasSuffix(text, "'") {
			typ = termExactBoundary
			text = text[1 : len(text)-1]
		} else if strings.HasPrefix(text, "'") {
			// Flip exactness
			if !inv {
				typ = termExact
			} else {
				typ = termFuzzy
			}
			text = text[1:]
		} else if strings.HasPrefix(text, "^") {
			if typ == termSuffix {
				typ = termEqual
			} else {
				typ = termPrefix
			}
			text = text[1:]
		}

		if len(text) > 0 {
			if switchSet {
				sets = append(sets, set)
				set = termSet{}
			}
			textRunes := []rune(text)
			if normalizeTerm {
				textRunes = NormalizeRunes(textRunes)
			}
			set = append(set, term{
				typ:           typ,
				inv:           inv,
				text:          textRunes,
				caseSensitive: caseSensitive,
				normalize:     normalizeTerm})
			switchSet = true
		}
	}
	if len(set) > 0 {
		sets = append(sets, set)
	}
	return sets
}

// IsEmpty reports whether the query has no terms, in which case every text
// matches with score 0.
func (p *Pattern) IsEmpty() bool {
	return len(p.termSets) == 0
}

// Match reports whether text matches every term set, with the sum of the
// positive terms' scores (an excluding term adds nothing). With withPos it
// also returns the rune indices of the matched characters, ascending and
// without duplicates; an exact term contributes its whole span.
//
// slab is the calling goroutine's own (NewSlab) and may be nil.
func (p *Pattern) Match(scheme *Scheme, text *Chars, withPos bool, slab *Slab) (score int, positions []int, ok bool) {
	return p.match(scheme, text, withPos, slab, (*Scheme).FuzzyMatchV2)
}

// Matches reports whether text matches, exactly as Match's ok does, at a
// fraction of the cost: a fuzzy term occurs in a text exactly when its best
// occurrence does, so the greedy FuzzyMatchV1 decides it in linear time where
// FuzzyMatchV2 fills a score matrix. Use it to reject texts before scoring
// them when most of what is matched does not match, such as the lines of a
// file, and in particular for a query of several terms, where Match would
// score the first term in full only for a later one to fail.
func (p *Pattern) Matches(scheme *Scheme, text *Chars, slab *Slab) bool {
	_, _, ok := p.match(scheme, text, false, slab, (*Scheme).FuzzyMatchV1)
	return ok
}

func (p *Pattern) match(scheme *Scheme, text *Chars, withPos bool, slab *Slab, fuzzyAlgo Algo) (score int, positions []int, ok bool) {
	for _, termSet := range p.termSets {
		matched := false
		for _, term := range termSet {
			algo := termAlgos[term.typ]
			if term.typ == termFuzzy {
				algo = fuzzyAlgo
			}
			res, pos := algo(scheme, term.caseSensitive, term.normalize, true, text, term.text, withPos && !term.inv, slab)
			if res.Start >= 0 {
				if term.inv {
					continue
				}
				score += res.Score
				matched = true
				if withPos {
					if pos != nil {
						positions = append(positions, pos...)
					} else {
						for idx := res.Start; idx < res.End; idx++ {
							positions = append(positions, idx)
						}
					}
				}
				break
			} else if term.inv {
				matched = true
				continue
			}
		}
		if !matched {
			return 0, nil, false
		}
	}
	slices.Sort(positions)
	return score, slices.Compact(positions), true
}
