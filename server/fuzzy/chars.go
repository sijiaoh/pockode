// This file is ported from fzf v0.74.5 (https://github.com/junegunn/fzf):
// Chars from src/util/chars.go, cut down to what the match functions read;
// Slab from src/util/slab.go, with its size fixed to fzf's; and the byte scans
// from src/algo/indexbyte2_other.go, the pure Go fallback of the SIMD ones.
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
	"bytes"
	"unicode"
	"unicode/utf8"
)

// Chars is a text prepared for matching: kept as bytes when it is all ASCII,
// decoded into runes otherwise. Every index the match functions return
// counts runes as this decoding does, which is the decoding of ranging over
// the text as a string: an invalid UTF-8 byte is one rune.
type Chars struct {
	bytes []byte
	runes []rune
}

// ToChars prepares text for matching. An ASCII text is adopted rather than
// copied, so the caller must not modify it while the Chars is in use.
func ToChars(text []byte) Chars {
	if isASCIIBytes(text) {
		return Chars{bytes: text}
	}
	runes := make([]rune, 0, utf8.RuneCount(text))
	for i := 0; i < len(text); {
		r, sz := utf8.DecodeRune(text[i:])
		i += sz
		runes = append(runes, r)
	}
	return Chars{runes: runes}
}

func isASCIIBytes(text []byte) bool {
	for _, b := range text {
		if b >= utf8.RuneSelf {
			return false
		}
	}
	return true
}

func (chars *Chars) IsBytes() bool {
	return chars.runes == nil
}

// Bytes returns the text if it is kept as bytes, nil otherwise.
func (chars *Chars) Bytes() []byte {
	return chars.bytes
}

func (chars *Chars) Get(i int) rune {
	if chars.runes != nil {
		return chars.runes[i]
	}
	return rune(chars.bytes[i])
}

func (chars *Chars) Length() int {
	if chars.runes != nil {
		return len(chars.runes)
	}
	return len(chars.bytes)
}

func (chars *Chars) String() string {
	if chars.runes != nil {
		return string(chars.runes)
	}
	return string(chars.bytes)
}

func (chars *Chars) LeadingWhitespaces() int {
	whitespaces := 0
	for i := 0; i < chars.Length(); i++ {
		char := chars.Get(i)
		if !unicode.IsSpace(char) {
			break
		}
		whitespaces++
	}
	return whitespaces
}

func (chars *Chars) TrailingWhitespaces() int {
	whitespaces := 0
	for i := chars.Length() - 1; i >= 0; i-- {
		char := chars.Get(i)
		if !unicode.IsSpace(char) {
			break
		}
		whitespaces++
	}
	return whitespaces
}

// toRunes returns the text as runes. When the text is kept as runes the
// result aliases it and must not be mutated.
func (chars *Chars) toRunes() []rune {
	if chars.runes != nil {
		return chars.runes
	}
	runes := make([]rune, len(chars.bytes))
	for idx, b := range chars.bytes {
		runes[idx] = rune(b)
	}
	return runes
}

func (chars *Chars) copyRunes(dest []rune, from int) {
	if chars.runes != nil {
		copy(dest, chars.runes[from:])
		return
	}
	for idx, b := range chars.bytes[from:][:len(dest)] {
		dest[idx] = rune(b)
	}
}

// Slab is scratch memory for the match functions, so scoring many texts does
// not allocate a score matrix for each. It is not safe for concurrent use:
// give each goroutine its own.
//
// FuzzyMatchV2 falls back to FuzzyMatchV1 when the text length times the
// pattern length exceeds what the slab holds, which bounds the cost of a
// long text; without a slab it never falls back on the text's length.
type Slab struct {
	i16 []int16
	i32 []int32
}

// Where these come from: fzf's slab16Size and slab32Size (src/constants.go).
const (
	slab16Size = 100 * 1024
	slab32Size = 2048
)

func NewSlab() *Slab {
	return &Slab{
		i16: make([]int16, slab16Size),
		i32: make([]int32, slab32Size)}
}

// indexByteTwo returns the index of the first occurrence of b1 or b2 in s,
// or -1 if neither is present.
func indexByteTwo(s []byte, b1, b2 byte) int {
	i1 := bytes.IndexByte(s, b1)
	if i1 == 0 {
		return 0
	}
	scope := s
	if i1 > 0 {
		scope = s[:i1]
	}
	if i2 := bytes.IndexByte(scope, b2); i2 >= 0 {
		return i2
	}
	return i1
}

// lastIndexByteTwo returns the index of the last occurrence of b1 or b2 in s,
// or -1 if neither is present.
func lastIndexByteTwo(s []byte, b1, b2 byte) int {
	for i := len(s) - 1; i >= 0; i-- {
		if s[i] == b1 || s[i] == b2 {
			return i
		}
	}
	return -1
}
