package search

import (
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

// toClientText turns text and byte-offset ranges into what the client indexes:
// the text as it arrives after JSON encoding, and the ranges as UTF-16
// code-unit offsets into it, which is what JS string indexes count.
//
// encoding/json replaces every invalid UTF-8 byte with U+FFFD, so that is done
// here first — one per byte, the same decoding json uses — and offsets are
// counted against the result. Counting against the raw bytes instead would
// shift every range after a stray byte.
//
// ranges must be ascending and non-overlapping. An edge that falls inside a
// multi-byte character moves to the end of that character.
func toClientText(text string, ranges []Range) (string, []Range) {
	if isASCII(text) {
		return text, ranges
	}

	// edges flattens ranges into start0, end0, start1, end1, ... — ascending,
	// so a single pass over the text converts all of them in place.
	edges := make([]int, 0, 2*len(ranges))
	for _, r := range ranges {
		edges = append(edges, r.Start, r.End)
	}

	var b strings.Builder
	b.Grow(len(text))
	units, next := 0, 0
	for i := 0; ; {
		for ; next < len(edges) && edges[next] <= i; next++ {
			edges[next] = units
		}
		if i >= len(text) {
			break
		}
		r, size := utf8.DecodeRuneInString(text[i:])
		if r == utf8.RuneError && size == 1 {
			b.WriteRune(utf8.RuneError)
		} else {
			b.WriteString(text[i : i+size])
		}
		units += utf16.RuneLen(r)
		i += size
	}

	out := make([]Range, len(ranges))
	for i := range out {
		out[i] = Range{Start: edges[2*i], End: edges[2*i+1]}
	}
	return b.String(), out
}

func isASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= utf8.RuneSelf {
			return false
		}
	}
	return true
}
