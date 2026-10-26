// This file is ported from fzf v0.74.5, src/algo/algo.go
// (https://github.com/junegunn/fzf). Changes from the original:
//
//   - The scoring scheme is an immutable Scheme value the caller picks per
//     call, instead of package-level state that algo.Init rewrites, so
//     searches with different schemes can run concurrently. The path scheme
//     treats only '/' as a delimiter on every platform.
//   - The match functions are methods on *Scheme and return positions as
//     []int instead of *[]int.
//   - The fast-path test hooks are a parameter of an unexported function
//     instead of package-level variables, so there is no mutable global.
//   - Performance-only code is left out: the SIMD byte scans (replaced by
//     their pure Go fallback), the rune-array prefilter, and the debug dump.
//     None of them changes a result.
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

/*

Algorithm
---------

FuzzyMatchV1 finds the first "fuzzy" occurrence of the pattern within the given
text in O(n) time where n is the length of the text. Once the position of the
last character is located, it traverses backwards to see if there's a shorter
substring that matches the pattern.

    a_____b___abc__  To find "abc"
    *-----*-----*>   1. Forward scan
             <***    2. Backward scan

The algorithm is simple and fast, but as it only sees the first occurrence,
it is not guaranteed to find the occurrence with the highest score.

    a_____b__c__abc
    *-----*--*  ***

FuzzyMatchV2 implements a modified version of Smith-Waterman algorithm to find
the optimal solution (highest score) according to the scoring criteria. Unlike
the original algorithm, omission or mismatch of a character in the pattern is
not allowed.

Performance
-----------

The new V2 algorithm is slower than V1 as it examines all occurrences of the
pattern instead of stopping immediately after finding the first one. The time
complexity of the algorithm is O(nm) if a match is found and O(n) otherwise
where n is the length of the item and m is the length of the pattern. Thus, the
performance overhead may not be noticeable for a query with high selectivity.
However, if the performance is more important than the quality of the result,
you can still choose v1 algorithm with --algo=v1.

Scoring criteria
----------------

- We prefer matches at special positions, such as the start of a word, or
  uppercase character in camelCase words.

- That is, we prefer an occurrence of the pattern with more characters
  matching at special positions, even if the total match length is longer.
    e.g. "fuzzyfinder" vs. "fuzzy-finder" on "ff"
                            ````````````
- Also, if the first character in the pattern appears at one of the special
  positions, the bonus point for the position is multiplied by a constant
  as it is extremely likely that the first character in the typed pattern
  has more significance than the rest.
    e.g. "fo-bar" vs. "foob-r" on "br"
          ``````
- But since fzf is still a fuzzy finder, not an acronym finder, we should also
  consider the total length of the matched substring. This is why we have the
  gap penalty. The gap penalty increases as the length of the gap (distance
  between the matching characters) increases, so the effect of the bonus is
  eventually cancelled at some point.
    e.g. "fuzzyfinder" vs. "fuzzy-blurry-finder" on "ff"
          ```````````
- Consequently, it is crucial to find the right balance between the bonus
  and the gap penalty. The parameters were chosen that the bonus is cancelled
  when the gap size increases beyond 8 characters.

- The bonus mechanism can have the undesirable side effect where consecutive
  matches are ranked lower than the ones with gaps.
    e.g. "foobar" vs. "foo-bar" on "foob"
                       ```````
- To correct this anomaly, we also give extra bonus point to each character
  in a consecutive matching chunk.
    e.g. "foobar" vs. "foo-bar" on "foob"
          ``````
- The amount of consecutive bonus is primarily determined by the bonus of the
  first character in the chunk.
    e.g. "foobar" vs. "out-of-bound" on "oob"
                       ````````````
*/

import (
	"bytes"
	"strings"
	"unicode"
	"unicode/utf8"
)

const whiteChars = " \t\n\v\f\r\x85\xA0"

func indexAt(index int, max int, forward bool) int {
	if forward {
		return index
	}
	return max - index - 1
}

// Result contains the results of running a match function. Start and End are
// rune indices into the text; Start is -1 if there is no match.
type Result struct {
	// TODO int32 should suffice
	Start int
	End   int
	Score int
}

const (
	scoreMatch        = 16
	scoreGapStart     = -3
	scoreGapExtension = -1

	// We prefer matches at the beginning of a word, but the bonus should not be
	// too great to prevent the longer acronym matches from always winning over
	// shorter fuzzy matches. The bonus point here was specifically chosen that
	// the bonus is cancelled when the gap between the acronyms grows over
	// 8 characters, which is approximately the average length of the words found
	// in web2 dictionary and my file system.
	bonusBoundary = scoreMatch / 2

	// Although bonus point for non-word characters is non-contextual, we need it
	// for computing bonus points for consecutive chunks starting with a non-word
	// character.
	bonusNonWord = scoreMatch / 2

	// Edge-triggered bonus for matches in camelCase words.
	// Compared to word-boundary case, they don't accompany single-character gaps
	// (e.g. FooBar vs. foo-bar), so we deduct bonus point accordingly.
	bonusCamel123 = bonusBoundary + scoreGapExtension

	// Minimum bonus point given to characters in consecutive chunks.
	// Note that bonus points for consecutive matches shouldn't have needed if we
	// used fixed match score as in the original algorithm.
	bonusConsecutive = -(scoreGapStart + scoreGapExtension)

	// The first character in the typed pattern usually has more significance
	// than the rest so it's important that it appears at special positions where
	// bonus points are given, e.g. "to-go" vs. "ongoing" on "og" or on "ogo".
	// The amount of the extra bonus should be limited so that the gap penalty is
	// still respected.
	bonusFirstCharMultiplier = 2
)

type charClass int

const (
	charWhite charClass = iota
	charNonWord
	charDelimiter
	charLower
	charUpper
	charLetter
	charNumber
)

// Scheme is a set of bonus points for the positions a match can land on. It
// is immutable, so one value is shared by every goroutine that scores with it.
// Its zero value scores nothing as a boundary; use DefaultScheme or
// PathScheme.
type Scheme struct {
	// Extra bonus for word boundary after whitespace character or beginning of the string
	bonusBoundaryWhite int16

	// Extra bonus for word boundary after slash, colon, semi-colon, and comma
	bonusBoundaryDelimiter int16

	initialCharClass charClass
	delimiterChars   string

	// A minor optimization that can give 15%+ performance boost
	asciiCharClasses [unicode.MaxASCII + 1]charClass

	// A minor optimization that can give yet another 5% performance boost
	bonusMatrix [charNumber + 1][charNumber + 1]int16
}

var (
	// DefaultScheme is fzf's "default" scheme, for generic text.
	DefaultScheme = newScheme(bonusBoundary+2, bonusBoundary+1, "/,:;|", charWhite)

	// PathScheme is fzf's "path" scheme, for slash-separated paths: a match
	// right after '/' or at the start of the path is a component boundary,
	// and whitespace earns no more than any other word boundary.
	PathScheme = newScheme(bonusBoundary, bonusBoundary+1, "/", charDelimiter)
)

func newScheme(boundaryWhite, boundaryDelimiter int16, delimiterChars string, initialCharClass charClass) *Scheme {
	s := &Scheme{
		bonusBoundaryWhite:     boundaryWhite,
		bonusBoundaryDelimiter: boundaryDelimiter,
		initialCharClass:       initialCharClass,
		delimiterChars:         delimiterChars,
	}
	for i := 0; i <= unicode.MaxASCII; i++ {
		char := rune(i)
		c := charNonWord
		if char >= 'a' && char <= 'z' {
			c = charLower
		} else if char >= 'A' && char <= 'Z' {
			c = charUpper
		} else if char >= '0' && char <= '9' {
			c = charNumber
		} else if strings.ContainsRune(whiteChars, char) {
			c = charWhite
		} else if strings.ContainsRune(delimiterChars, char) {
			c = charDelimiter
		}
		s.asciiCharClasses[i] = c
	}
	for i := 0; i <= int(charNumber); i++ {
		for j := 0; j <= int(charNumber); j++ {
			s.bonusMatrix[i][j] = s.bonusFor(charClass(i), charClass(j))
		}
	}
	return s
}

func posArray(withPos bool, len int) []int {
	if withPos {
		return make([]int, 0, len)
	}
	return nil
}

func alloc16(offset int, slab *Slab, size int) (int, []int16) {
	if slab != nil && cap(slab.i16) > offset+size {
		slice := slab.i16[offset : offset+size]
		return offset + size, slice
	}
	return offset, make([]int16, size)
}

func alloc32(offset int, slab *Slab, size int) (int, []int32) {
	if slab != nil && cap(slab.i32) > offset+size {
		slice := slab.i32[offset : offset+size]
		return offset + size, slice
	}
	return offset, make([]int32, size)
}

func (s *Scheme) charClassOfNonAscii(char rune) charClass {
	if unicode.IsLower(char) {
		return charLower
	} else if unicode.IsUpper(char) {
		return charUpper
	} else if unicode.IsNumber(char) {
		return charNumber
	} else if unicode.IsLetter(char) {
		return charLetter
	} else if unicode.IsSpace(char) {
		return charWhite
	} else if strings.ContainsRune(s.delimiterChars, char) {
		return charDelimiter
	}
	return charNonWord
}

func (s *Scheme) charClassOf(char rune) charClass {
	if char <= unicode.MaxASCII {
		return s.asciiCharClasses[char]
	}
	return s.charClassOfNonAscii(char)
}

func (s *Scheme) bonusFor(prevClass charClass, class charClass) int16 {
	if class >= charNonWord {
		switch prevClass {
		case charWhite:
			// Word boundary after whitespace
			return s.bonusBoundaryWhite
		case charDelimiter:
			// Word boundary after a delimiter character
			return s.bonusBoundaryDelimiter
		case charNonWord:
			// Word boundary
			return bonusBoundary
		}
	}

	if prevClass == charLower && class == charUpper ||
		prevClass != charNumber && class == charNumber {
		// camelCase letter123
		return bonusCamel123
	}

	switch class {
	case charNonWord, charDelimiter:
		return bonusNonWord
	case charWhite:
		return s.bonusBoundaryWhite
	}
	return 0
}

func (s *Scheme) bonusAt(input *Chars, idx int) int16 {
	if idx == 0 {
		return s.bonusBoundaryWhite
	}
	return s.bonusMatrix[s.charClassOf(input.Get(idx-1))][s.charClassOf(input.Get(idx))]
}

func normalizeRune(r rune) rune {
	if r < normalizedMin || r > normalizedMax {
		return r
	}

	n := normalized[r]
	if n > 0 {
		return n
	}
	return r
}

// Algo is the signature every match method has as a method expression, e.g.
// (*Scheme).FuzzyMatchV2, so a caller can pick the algorithm per search term.
//
// Algo functions make two assumptions
// 1. "pattern" is given in lowercase if "caseSensitive" is false
// 2. "pattern" is already normalized if "normalize" is true
//
// The positions are rune indices into text, in no particular order, and are
// returned only if withPos is set and the algorithm locates each character:
// the fuzzy matches do, the others match the whole range [Start, End) and
// return nil. slab may be nil, which allocates on every call.
type Algo func(s *Scheme, caseSensitive bool, normalize bool, forward bool, text *Chars, pattern []rune, withPos bool, slab *Slab) (Result, []int)

func trySkip(input *Chars, caseSensitive bool, b byte, from int) int {
	byteArray := input.Bytes()[from:]
	// For case-insensitive search of a letter, search for both cases in one pass
	if !caseSensitive && b >= 'a' && b <= 'z' {
		idx := indexByteTwo(byteArray, b, b-32)
		if idx < 0 {
			return -1
		}
		return from + idx
	}
	idx := bytes.IndexByte(byteArray, b)
	if idx < 0 {
		return -1
	}
	return from + idx
}

func isAscii(runes []rune) bool {
	for _, r := range runes {
		if r >= utf8.RuneSelf {
			return false
		}
	}
	return true
}

func asciiFuzzyIndex(input *Chars, pattern []rune, caseSensitive bool) (int, int) {
	if !input.IsBytes() {
		return 0, input.Length()
	}

	// Not possible
	if !isAscii(pattern) {
		return -1, -1
	}

	firstIdx, idx, lastIdx := 0, 0, 0
	var b byte
	for pidx := range pattern {
		b = byte(pattern[pidx])
		idx = trySkip(input, caseSensitive, b, idx)
		if idx < 0 {
			return -1, -1
		}
		if pidx == 0 && idx > 0 {
			// Step back to find the right bonus point
			firstIdx = idx - 1
		}
		lastIdx = idx
		idx++
	}

	// Find the last appearance of the last character of the pattern to limit the search scope
	scope := input.Bytes()[lastIdx:]
	if len(scope) > 1 {
		tail := scope[1:]
		var end int
		if !caseSensitive && b >= 'a' && b <= 'z' {
			end = lastIndexByteTwo(tail, b, b-32)
		} else {
			end = bytes.LastIndexByte(tail, b)
		}
		if end >= 0 {
			return firstIdx, lastIdx + 1 + end + 1
		}
	}
	return firstIdx, lastIdx + 1
}

// fuzzyMatchV2Single is a fast path for a single-character ASCII pattern on
// ASCII input. Same scoring and tiebreaks as Phase 2 of FuzzyMatchV2, but
// jumps between occurrences instead of scanning every character, and
// allocates no arrays.
func (s *Scheme) fuzzyMatchV2Single(caseSensitive bool, forward bool, input *Chars, b byte, withPos bool) (Result, []int) {
	byteArray := input.Bytes()
	maxScore, maxScorePos := int16(0), -1
	for idx := 0; idx < len(byteArray); {
		idx = trySkip(input, caseSensitive, b, idx)
		if idx < 0 {
			break
		}
		class := s.asciiCharClasses[byteArray[idx]]
		prevClass := s.initialCharClass
		if idx > 0 {
			prevClass = s.asciiCharClasses[byteArray[idx-1]]
		}
		bonus := s.bonusMatrix[prevClass][class]
		score := scoreMatch + bonus*bonusFirstCharMultiplier
		if forward && score > maxScore || !forward && score >= maxScore {
			maxScore, maxScorePos = score, idx
			if forward && bonus >= bonusBoundary {
				break
			}
		}
		idx++
	}
	if maxScorePos < 0 {
		return Result{-1, -1, 0}, nil
	}
	result := Result{maxScorePos, maxScorePos + 1, int(maxScore)}
	if !withPos {
		return result, nil
	}
	pos := []int{maxScorePos}
	return result, pos
}

// fuzzyMatchV2Two is a fused fast path for a two-character ASCII pattern on
// ASCII input. It replicates Phase 2 (row 0) and Phase 3 (row 1) of
// FuzzyMatchV2 in a single pass, carrying the row-0 diagonal/left values and
// the row-1 left value as scalars instead of materializing score arrays.
// When withPos is set, the two DP rows are stored so the backtrace can
// recover the matched character positions, exactly as the general Phase 4.
func (s *Scheme) fuzzyMatchV2Two(caseSensitive bool, forward bool, input *Chars, pchar0 byte, pchar1 byte, minIdx int, maxIdx int, withPos bool, slab *Slab) (Result, []int) {
	sl := input.Bytes()
	N := maxIdx - minIdx

	// Row storage, only needed for the backtrace
	var H0, C0, H1, C1 []int16
	if withPos {
		o := 0
		o, H0 = alloc16(o, slab, N)
		o, C0 = alloc16(o, slab, N)
		o, H1 = alloc16(o, slab, N)
		_, C1 = alloc16(o, slab, N)
	}

	maxScore, maxScorePos := int16(0), 0
	prevClass := s.initialCharClass

	// Subsequence tracking (equivalent to F[0], F[1] in Phase 2). The scope
	// from asciiFuzzyIndex ends exactly at the last pchar1, so row 1's upper
	// bound (Phase 3 lastIdx) is the final loop position; no separate var.
	f0, f1 := -1, -1

	// Row 0 running state at the previous position
	var h0Prev, c0Prev, bPrev int16
	inGap0 := false

	// Row 1 running state
	var h1Prev int16
	inGap1 := false

	for off := range N {
		pos := minIdx + off
		b := sl[pos]
		class := s.asciiCharClasses[b]
		lb := b
		if !caseSensitive && b >= 'A' && b <= 'Z' {
			lb = b + 32
		}
		bonus := s.bonusMatrix[prevClass][class]
		prevClass = class

		// Subsequence advance: pchar0 then pchar1
		if f0 < 0 {
			if lb == pchar0 {
				f0 = off
			}
		} else if lb == pchar1 && f1 < 0 {
			f1 = off
		}

		// Row 0 (pchar0)
		var h0Cur, c0Cur int16
		if lb == pchar0 {
			h0Cur = scoreMatch + bonus*bonusFirstCharMultiplier
			c0Cur = 1
			inGap0 = false
		} else {
			if inGap0 {
				h0Cur = max(h0Prev+scoreGapExtension, 0)
			} else {
				h0Cur = max(h0Prev+scoreGapStart, 0)
			}
			c0Cur = 0
			inGap0 = true
		}
		if withPos {
			H0[off], C0[off] = h0Cur, c0Cur
		}

		// Row 1 (pchar1), only within [f1, lastIdx]
		if f1 >= 0 && off >= f1 {
			var s1, s2, consecutive int16
			hleft := h1Prev
			if off == f1 {
				hleft = 0
			}
			if inGap1 {
				s2 = hleft + scoreGapExtension
			} else {
				s2 = hleft + scoreGapStart
			}
			if lb == pchar1 {
				s1 = h0Prev + scoreMatch
				bb := bonus
				consecutive = c0Prev + 1
				if consecutive > 1 {
					fb := bPrev
					if bb >= bonusBoundary && bb > fb {
						consecutive = 1
					} else {
						bb = max(bb, bonusConsecutive, fb)
					}
				}
				if s1+bb < s2 {
					s1 += bonus
					consecutive = 0
				} else {
					s1 += bb
				}
			}
			inGap1 = s1 < s2
			score := max(s1, s2, 0)
			if forward && score > maxScore || !forward && score >= maxScore {
				maxScore, maxScorePos = score, off
			}
			h1Prev = score
			if withPos {
				H1[off], C1[off] = score, consecutive
			}
		}

		h0Prev, c0Prev, bPrev = h0Cur, c0Cur, bonus
	}

	if f1 < 0 {
		return Result{-1, -1, 0}, nil
	}
	if !withPos {
		return Result{minIdx + f0, minIdx + maxScorePos + 1, int(maxScore)}, nil
	}

	// Phase 4 backtrace, specialized to two rows. Mirrors the general loop:
	// record a cell when it dominates its diagonal and left neighbors, then
	// step up a row; otherwise step left. preferMatch breaks score ties and
	// must not read row 1 left of f1 (unwritten, possibly stale slab data).
	pos := posArray(true, 2)
	i := 1
	j := maxScorePos
	preferMatch := true
	for {
		var s, s1, s2, cCur int16
		if i == 1 {
			s, cCur = H1[j], C1[j]
			if j >= f1 {
				s1 = H0[j-1]
			}
			if j > f1 {
				s2 = H1[j-1]
			}
		} else {
			s, cCur = H0[j], C0[j]
			if j > f0 {
				s2 = H0[j-1]
			}
		}
		row := i
		if s > s1 && (s > s2 || s == s2 && preferMatch) {
			pos = append(pos, j+minIdx)
			if i == 0 {
				break
			}
			i--
		}
		preferMatch = cCur > 1 ||
			row == 0 && j < N-1 && j+1 >= f1 && C1[j+1] > 0
		j--
	}
	return Result{minIdx + j, minIdx + maxScorePos + 1, int(maxScore)}, pos
}

// FuzzyMatchV2 finds the alignment of pattern in input with the highest
// score. See the comment at the top of this file.
func (s *Scheme) FuzzyMatchV2(caseSensitive bool, normalize bool, forward bool, input *Chars, pattern []rune, withPos bool, slab *Slab) (Result, []int) {
	return s.fuzzyMatchV2(caseSensitive, normalize, forward, input, pattern, withPos, slab, true)
}

// fuzzyMatchV2 with fastPaths unset always takes the general path, which is
// the reference the fast paths are tested against.
func (s *Scheme) fuzzyMatchV2(caseSensitive bool, normalize bool, forward bool, input *Chars, pattern []rune, withPos bool, slab *Slab, fastPaths bool) (Result, []int) {
	// Assume that pattern is given in lowercase if case-insensitive.
	// First check if there's a match and calculate bonus for each position.
	// If the input string is too long, consider finding the matching chars in
	// this phase as well (non-optimal alignment).
	M := len(pattern)
	if M == 0 {
		return Result{0, 0, 0}, posArray(withPos, M)
	}
	N := input.Length()
	if M > N {
		return Result{-1, -1, 0}, nil
	}

	// Since O(nm) algorithm can be prohibitively expensive for large input,
	// we fall back to the greedy algorithm.
	// Also, we should not allow a very long pattern to avoid 16-bit integer
	// overflow in the score matrix. 1000 is a safe limit.
	if slab != nil && int64(N)*int64(M) > int64(cap(slab.i16)) || M > 1000 {
		return s.FuzzyMatchV1(caseSensitive, normalize, forward, input, pattern, withPos, slab)
	}

	// Single-character ASCII pattern needs neither the prefilter nor the
	// score matrix
	if fastPaths && M == 1 && input.IsBytes() && pattern[0] < utf8.RuneSelf {
		return s.fuzzyMatchV2Single(caseSensitive, forward, input, byte(pattern[0]), withPos)
	}

	// Phase 1. Optimized search for ASCII string
	minIdx, maxIdx := asciiFuzzyIndex(input, pattern, caseSensitive)
	if minIdx < 0 {
		return Result{-1, -1, 0}, nil
	}
	N = maxIdx - minIdx

	// Two-character ASCII pattern: rows 0 and 1 collapse to scalar running
	// state, so the general score arrays are unnecessary
	if fastPaths && M == 2 && input.IsBytes() &&
		pattern[0] < utf8.RuneSelf && pattern[1] < utf8.RuneSelf {
		return s.fuzzyMatchV2Two(caseSensitive, forward, input, byte(pattern[0]), byte(pattern[1]), minIdx, maxIdx, withPos, slab)
	}

	// Reuse pre-allocated integer slice to avoid unnecessary sweeping of garbages
	offset16 := 0
	offset32 := 0
	offset16, H0 := alloc16(offset16, slab, N)
	offset16, C0 := alloc16(offset16, slab, N)
	// Bonus point for each position
	offset16, B := alloc16(offset16, slab, N)
	// The first occurrence of each character in the pattern
	offset32, F := alloc32(offset32, slab, M)
	// Rune array
	_, T := alloc32(offset32, slab, N)
	input.copyRunes(T, minIdx)

	// Phase 2. Calculate bonus for each point
	maxScore, maxScorePos := int16(0), 0
	pidx, lastIdx := 0, 0
	pchar0, pchar, prevH0, prevClass, inGap := pattern[0], pattern[0], int16(0), s.initialCharClass, false
	for off, char := range T {
		var class charClass
		if char <= unicode.MaxASCII {
			class = s.asciiCharClasses[char]
			if !caseSensitive && class == charUpper {
				char += 32
				T[off] = char
			}
		} else {
			class = s.charClassOfNonAscii(char)
			if !caseSensitive && class == charUpper {
				char = unicode.To(unicode.LowerCase, char)
			}
			if normalize {
				char = normalizeRune(char)
			}
			T[off] = char
		}

		bonus := s.bonusMatrix[prevClass][class]
		B[off] = bonus
		prevClass = class

		if char == pchar {
			if pidx < M {
				F[pidx] = int32(off)
				pidx++
				pchar = pattern[min(pidx, M-1)]
			}
			lastIdx = off
		}

		if char == pchar0 {
			score := scoreMatch + bonus*bonusFirstCharMultiplier
			H0[off] = score
			C0[off] = 1
			if M == 1 && (forward && score > maxScore || !forward && score >= maxScore) {
				maxScore, maxScorePos = score, off
				if forward && bonus >= bonusBoundary {
					break
				}
			}
			inGap = false
		} else {
			if inGap {
				H0[off] = max(prevH0+scoreGapExtension, 0)
			} else {
				H0[off] = max(prevH0+scoreGapStart, 0)
			}
			C0[off] = 0
			inGap = true
		}
		prevH0 = H0[off]
	}
	if pidx != M {
		return Result{-1, -1, 0}, nil
	}
	if M == 1 {
		result := Result{minIdx + maxScorePos, minIdx + maxScorePos + 1, int(maxScore)}
		if !withPos {
			return result, nil
		}
		pos := []int{minIdx + maxScorePos}
		return result, pos
	}

	// Phase 3. Fill in score matrix (H)
	// Unlike the original algorithm, we do not allow omission.
	f0 := int(F[0])
	width := lastIdx - f0 + 1
	offset16, H := alloc16(offset16, slab, width*M)
	copy(H, H0[f0:lastIdx+1])

	// Possible length of consecutive chunk at each position.
	_, C := alloc16(offset16, slab, width*M)
	copy(C, C0[f0:lastIdx+1])

	Fsub := F[1:]
	Psub := pattern[1:][:len(Fsub)]
	for off, f := range Fsub {
		f := int(f)
		pchar := Psub[off]
		pidx := off + 1
		row := pidx * width
		inGap := false
		Tsub := T[f : lastIdx+1]
		Bsub := B[f:][:len(Tsub)]
		Csub := C[row+f-f0:][:len(Tsub)]
		Cdiag := C[row+f-f0-1-width:][:len(Tsub)]
		Hsub := H[row+f-f0:][:len(Tsub)]
		Hdiag := H[row+f-f0-1-width:][:len(Tsub)]
		Hleft := H[row+f-f0-1:][:len(Tsub)]
		Hleft[0] = 0
		for off, char := range Tsub {
			col := off + f
			var s1, s2, consecutive int16

			if inGap {
				s2 = Hleft[off] + scoreGapExtension
			} else {
				s2 = Hleft[off] + scoreGapStart
			}

			if pchar == char {
				s1 = Hdiag[off] + scoreMatch
				b := Bsub[off]
				consecutive = Cdiag[off] + 1
				if consecutive > 1 {
					fb := B[col-int(consecutive)+1]
					// Break consecutive chunk
					if b >= bonusBoundary && b > fb {
						consecutive = 1
					} else {
						b = max(b, bonusConsecutive, fb)
					}
				}
				if s1+b < s2 {
					s1 += Bsub[off]
					consecutive = 0
				} else {
					s1 += b
				}
			}
			Csub[off] = consecutive

			inGap = s1 < s2
			score := max(s1, s2, 0)
			if pidx == M-1 && (forward && score > maxScore || !forward && score >= maxScore) {
				maxScore, maxScorePos = score, col
			}
			Hsub[off] = score
		}
	}

	// Phase 4. (Optional) Backtrace to find character positions
	pos := posArray(withPos, M)
	j := f0
	if withPos {
		i := M - 1
		j = maxScorePos
		preferMatch := true
		for {
			I := i * width
			j0 := j - f0
			s := H[I+j0]

			var s1, s2 int16
			if i > 0 && j >= int(F[i]) {
				s1 = H[I-width+j0-1]
			}
			if j > int(F[i]) {
				s2 = H[I+j0-1]
			}

			row := i
			if s > s1 && (s > s2 || s == s2 && preferMatch) {
				pos = append(pos, j+minIdx)
				if i == 0 {
					break
				}
				i--
			}
			// Row below is only written from column F[row+1]; don't read
			// stale slab data left of it
			preferMatch = C[I+j0] > 1 ||
				row+1 < M && j < lastIdx && int32(j+1) >= F[row+1] && C[I+width+j0+1] > 0
			j--
		}
	}
	// Start offset we return here is only relevant when begin tiebreak is used.
	// However finding the accurate offset requires backtracking, and we don't
	// want to pay extra cost for the option that has lost its importance.
	return Result{minIdx + j, minIdx + maxScorePos + 1, int(maxScore)}, pos
}

// Implement the same sorting criteria as V2
func (s *Scheme) calculateScore(caseSensitive bool, normalize bool, text *Chars, pattern []rune, sidx int, eidx int, withPos bool) (int, []int) {
	pidx, score, inGap, consecutive, firstBonus := 0, 0, false, 0, int16(0)
	pos := posArray(withPos, len(pattern))
	prevClass := s.initialCharClass
	if sidx > 0 {
		prevClass = s.charClassOf(text.Get(sidx - 1))
	}
	for idx := sidx; idx < eidx; idx++ {
		char := text.Get(idx)
		class := s.charClassOf(char)
		if !caseSensitive {
			if char >= 'A' && char <= 'Z' {
				char += 32
			} else if char > unicode.MaxASCII {
				char = unicode.To(unicode.LowerCase, char)
			}
		}
		// pattern is already normalized
		if normalize {
			char = normalizeRune(char)
		}
		if char == pattern[pidx] {
			if withPos {
				pos = append(pos, idx)
			}
			score += scoreMatch
			bonus := s.bonusMatrix[prevClass][class]
			if consecutive == 0 {
				firstBonus = bonus
			} else {
				// Break consecutive chunk
				if bonus >= bonusBoundary && bonus > firstBonus {
					firstBonus = bonus
				}
				bonus = max(bonus, firstBonus, bonusConsecutive)
			}
			if pidx == 0 {
				score += int(bonus * bonusFirstCharMultiplier)
			} else {
				score += int(bonus)
			}
			inGap = false
			consecutive++
			pidx++
		} else {
			if inGap {
				score += scoreGapExtension
			} else {
				score += scoreGapStart
			}
			inGap = true
			consecutive = 0
			firstBonus = 0
		}
		prevClass = class
	}
	return score, pos
}

// FuzzyMatchV1 performs fuzzy-match
func (s *Scheme) FuzzyMatchV1(caseSensitive bool, normalize bool, forward bool, text *Chars, pattern []rune, withPos bool, slab *Slab) (Result, []int) {
	if len(pattern) == 0 {
		return Result{0, 0, 0}, nil
	}
	idx, _ := asciiFuzzyIndex(text, pattern, caseSensitive)
	if idx < 0 {
		return Result{-1, -1, 0}, nil
	}

	pidx := 0
	sidx := -1
	eidx := -1

	lenRunes := text.Length()
	lenPattern := len(pattern)

	for index := range lenRunes {
		char := text.Get(indexAt(index, lenRunes, forward))
		// This is considerably faster than blindly applying strings.ToLower to the
		// whole string
		if !caseSensitive {
			// Partially inlining `unicode.ToLower`. Ugly, but makes a noticeable
			// difference in CPU cost. (Measured on Go 1.4.1. Also note that the Go
			// compiler as of now does not inline non-leaf functions.)
			if char >= 'A' && char <= 'Z' {
				char += 32
			} else if char > unicode.MaxASCII {
				char = unicode.To(unicode.LowerCase, char)
			}
		}
		if normalize {
			char = normalizeRune(char)
		}
		pchar := pattern[indexAt(pidx, lenPattern, forward)]
		if char == pchar {
			if sidx < 0 {
				sidx = index
			}
			if pidx++; pidx == lenPattern {
				eidx = index + 1
				break
			}
		}
	}

	if sidx >= 0 && eidx >= 0 {
		pidx--
		for index := eidx - 1; index >= sidx; index-- {
			tidx := indexAt(index, lenRunes, forward)
			char := text.Get(tidx)
			if !caseSensitive {
				if char >= 'A' && char <= 'Z' {
					char += 32
				} else if char > unicode.MaxASCII {
					char = unicode.To(unicode.LowerCase, char)
				}
			}
			if normalize {
				char = normalizeRune(char)
			}

			pidx_ := indexAt(pidx, lenPattern, forward)
			pchar := pattern[pidx_]
			if char == pchar {
				if pidx--; pidx < 0 {
					sidx = index
					break
				}
			}
		}

		if !forward {
			sidx, eidx = lenRunes-eidx, lenRunes-sidx
		}

		score, pos := s.calculateScore(caseSensitive, normalize, text, pattern, sidx, eidx, withPos)
		return Result{sidx, eidx, score}, pos
	}
	return Result{-1, -1, 0}, nil
}

// ExactMatchNaive is a basic string searching algorithm that handles case
// sensitivity. Although naive, it still performs better than the combination
// of strings.ToLower + strings.Index for typical fzf use cases where input
// strings and patterns are not very long.
//
// Since 0.15.0, this function searches for the match with the highest
// bonus point, instead of stopping immediately after finding the first match.
// The solution is much cheaper since there is only one possible alignment of
// the pattern.
func (s *Scheme) ExactMatchNaive(caseSensitive bool, normalize bool, forward bool, text *Chars, pattern []rune, withPos bool, slab *Slab) (Result, []int) {
	return s.exactMatchNaive(caseSensitive, normalize, forward, false, text, pattern, withPos, slab)
}

// ExactMatchBoundary is ExactMatchNaive that only accepts an occurrence
// starting and ending at word boundaries.
func (s *Scheme) ExactMatchBoundary(caseSensitive bool, normalize bool, forward bool, text *Chars, pattern []rune, withPos bool, slab *Slab) (Result, []int) {
	return s.exactMatchNaive(caseSensitive, normalize, forward, true, text, pattern, withPos, slab)
}

func (s *Scheme) exactMatchNaive(caseSensitive bool, normalize bool, forward bool, boundaryCheck bool, text *Chars, pattern []rune, withPos bool, slab *Slab) (Result, []int) {
	if len(pattern) == 0 {
		return Result{0, 0, 0}, nil
	}

	lenRunes := text.Length()
	lenPattern := len(pattern)

	if lenRunes < lenPattern {
		return Result{-1, -1, 0}, nil
	}

	idx, _ := asciiFuzzyIndex(text, pattern, caseSensitive)
	if idx < 0 {
		return Result{-1, -1, 0}, nil
	}

	// For simplicity, only look at the bonus at the first character position
	pidx := 0
	bestPos, bonus, bbonus, bestBonus := -1, int16(0), int16(0), int16(-1)
	for index := 0; index < lenRunes; index++ {
		index_ := indexAt(index, lenRunes, forward)
		char := text.Get(index_)
		if !caseSensitive {
			if char >= 'A' && char <= 'Z' {
				char += 32
			} else if char > unicode.MaxASCII {
				char = unicode.To(unicode.LowerCase, char)
			}
		}
		if normalize {
			char = normalizeRune(char)
		}
		pidx_ := indexAt(pidx, lenPattern, forward)
		pchar := pattern[pidx_]
		ok := pchar == char
		if ok {
			if pidx_ == 0 {
				bonus = s.bonusAt(text, index_)
			}
			if boundaryCheck {
				if forward && pidx_ == 0 {
					bbonus = bonus
				} else if !forward && pidx_ == lenPattern-1 {
					if index_ < lenRunes-1 {
						bbonus = s.bonusAt(text, index_+1)
					} else {
						bbonus = s.bonusBoundaryWhite
					}
				}
				ok = bbonus >= bonusBoundary
				if ok && pidx_ == 0 {
					ok = index_ == 0 || s.charClassOf(text.Get(index_-1)) <= charDelimiter
				}
				if ok && pidx_ == len(pattern)-1 {
					ok = index_ == lenRunes-1 || s.charClassOf(text.Get(index_+1)) <= charDelimiter
				}
			}
		}
		if ok {
			pidx++
			if pidx == lenPattern {
				if bonus > bestBonus {
					bestPos, bestBonus = index, bonus
				}
				if bonus >= bonusBoundary {
					break
				}
				index -= pidx - 1
				pidx, bonus = 0, 0
			}
		} else {
			index -= pidx
			pidx, bonus = 0, 0
		}
	}
	if bestPos >= 0 {
		var sidx, eidx int
		if forward {
			sidx = bestPos - lenPattern + 1
			eidx = bestPos + 1
		} else {
			sidx = lenRunes - (bestPos + 1)
			eidx = lenRunes - (bestPos - lenPattern + 1)
		}
		var score int
		if boundaryCheck {
			// Underscore boundaries should be ranked lower than the other types of boundaries
			score = int(bonus)
			deduct := int(bonus-bonusBoundary) + 1
			if sidx > 0 && text.Get(sidx-1) == '_' {
				score -= deduct + 1
				deduct = 1
			}
			if eidx < lenRunes && text.Get(eidx) == '_' {
				score -= deduct
			}
			// Add base score so that this can compete with other match types e.g. 'foo' | bar
			score += scoreMatch*lenPattern + int(s.bonusBoundaryWhite)*(lenPattern+1)
		} else {
			score, _ = s.calculateScore(caseSensitive, normalize, text, pattern, sidx, eidx, false)
		}
		return Result{sidx, eidx, score}, nil
	}
	return Result{-1, -1, 0}, nil
}

// PrefixMatch performs prefix-match
func (s *Scheme) PrefixMatch(caseSensitive bool, normalize bool, forward bool, text *Chars, pattern []rune, withPos bool, slab *Slab) (Result, []int) {
	if len(pattern) == 0 {
		return Result{0, 0, 0}, nil
	}

	trimmedLen := 0
	if !unicode.IsSpace(pattern[0]) {
		trimmedLen = text.LeadingWhitespaces()
	}

	if text.Length()-trimmedLen < len(pattern) {
		return Result{-1, -1, 0}, nil
	}

	for index, r := range pattern {
		char := text.Get(trimmedLen + index)
		if !caseSensitive {
			char = unicode.ToLower(char)
		}
		if normalize {
			char = normalizeRune(char)
		}
		if char != r {
			return Result{-1, -1, 0}, nil
		}
	}
	lenPattern := len(pattern)
	score, _ := s.calculateScore(caseSensitive, normalize, text, pattern, trimmedLen, trimmedLen+lenPattern, false)
	return Result{trimmedLen, trimmedLen + lenPattern, score}, nil
}

// SuffixMatch performs suffix-match
func (s *Scheme) SuffixMatch(caseSensitive bool, normalize bool, forward bool, text *Chars, pattern []rune, withPos bool, slab *Slab) (Result, []int) {
	lenRunes := text.Length()
	trimmedLen := lenRunes
	if len(pattern) == 0 || !unicode.IsSpace(pattern[len(pattern)-1]) {
		trimmedLen -= text.TrailingWhitespaces()
	}
	if len(pattern) == 0 {
		return Result{trimmedLen, trimmedLen, 0}, nil
	}
	diff := trimmedLen - len(pattern)
	if diff < 0 {
		return Result{-1, -1, 0}, nil
	}

	for index, r := range pattern {
		char := text.Get(index + diff)
		if !caseSensitive {
			char = unicode.ToLower(char)
		}
		if normalize {
			char = normalizeRune(char)
		}
		if char != r {
			return Result{-1, -1, 0}, nil
		}
	}
	lenPattern := len(pattern)
	sidx := trimmedLen - lenPattern
	eidx := trimmedLen
	score, _ := s.calculateScore(caseSensitive, normalize, text, pattern, sidx, eidx, false)
	return Result{sidx, eidx, score}, nil
}

// EqualMatch performs equal-match
func (s *Scheme) EqualMatch(caseSensitive bool, normalize bool, forward bool, text *Chars, pattern []rune, withPos bool, slab *Slab) (Result, []int) {
	lenPattern := len(pattern)
	if lenPattern == 0 {
		return Result{-1, -1, 0}, nil
	}

	// Strip leading whitespaces
	trimmedLen := 0
	if !unicode.IsSpace(pattern[0]) {
		trimmedLen = text.LeadingWhitespaces()
	}

	// Strip trailing whitespaces
	trimmedEndLen := 0
	if !unicode.IsSpace(pattern[lenPattern-1]) {
		trimmedEndLen = text.TrailingWhitespaces()
	}

	if text.Length()-trimmedLen-trimmedEndLen != lenPattern {
		return Result{-1, -1, 0}, nil
	}
	match := true
	if normalize {
		runes := text.toRunes()
		for idx, pchar := range pattern {
			char := runes[trimmedLen+idx]
			if !caseSensitive {
				char = unicode.To(unicode.LowerCase, char)
			}
			if normalizeRune(pchar) != normalizeRune(char) {
				match = false
				break
			}
		}
	} else {
		runes := text.toRunes()
		runesStr := string(runes[trimmedLen : len(runes)-trimmedEndLen])
		if !caseSensitive {
			runesStr = strings.ToLower(runesStr)
		}
		match = runesStr == string(pattern)
	}
	if match {
		return Result{trimmedLen, trimmedLen + lenPattern, (scoreMatch+int(s.bonusBoundaryWhite))*lenPattern +
			(bonusFirstCharMultiplier-1)*int(s.bonusBoundaryWhite)}, nil
	}
	return Result{-1, -1, 0}, nil
}
