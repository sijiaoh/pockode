package search

import (
	"bytes"
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"
)

// matcher finds literal occurrences of a query and reports their byte offsets.
//
// Case-insensitive matching folds ASCII only, and only when the query itself is
// ASCII. Go's regexp loses its literal fast path under (?i) and then runs ~150x
// slower (measured: 415ms vs 2.7ms per MiB), which matters because
// case-insensitive is the default mode and content search reads whole
// repositories. The practical cost is that an ASCII query no longer matches
// exotic folds such as "ſ" for "s".
//
// A query containing non-ASCII characters takes the regexp instead, so its case
// folding stays correct (searching "ÉCOLE" still finds "école"). Those queries
// are rare enough that the slower path is not worth avoiding.
type matcher struct {
	// needle is the search text, ASCII-lowercased when fold is set. Both
	// representations are kept so neither the string nor the byte entry point
	// has to convert per call.
	needle      string
	needleBytes []byte
	fold        bool
	// re is set only when the literal scan cannot be used.
	re *regexp.Regexp
}

func newMatcher(query string, caseSensitive bool) (*matcher, error) {
	needle := query
	fold := false

	switch {
	case caseSensitive:
	case isASCII(query):
		needle, fold = asciiLowerString(query), true
	default:
		re, err := regexp.Compile("(?i)" + regexp.QuoteMeta(query))
		if err != nil {
			return nil, fmt.Errorf("failed to compile query: %w", err)
		}
		return &matcher{re: re}, nil
	}

	return &matcher{needle: needle, needleBytes: []byte(needle), fold: fold}, nil
}

// matchString reports whether text contains the query.
func (m *matcher) matchString(text string) bool {
	if m.re != nil {
		return m.re.MatchString(text)
	}
	if m.fold {
		return indexFold(text, m.needle, strings.IndexByte) >= 0
	}
	return strings.Index(text, m.needle) >= 0
}

// find returns up to limit non-overlapping match positions, as byte offsets
// into line. It takes bytes so that scanning a file does not have to allocate a
// string for every line, only for the lines that actually match.
func (m *matcher) find(line []byte, limit int) []Range {
	if m.re != nil {
		found := m.re.FindAllIndex(line, limit)
		ranges := make([]Range, 0, len(found))
		for _, r := range found {
			ranges = append(ranges, Range{Start: r[0], End: r[1]})
		}
		return ranges
	}

	var ranges []Range
	for offset := 0; len(ranges) < limit; {
		var i int
		if m.fold {
			i = indexFold(line[offset:], m.needle, bytes.IndexByte)
		} else {
			i = bytes.Index(line[offset:], m.needleBytes)
		}
		if i < 0 {
			break
		}
		start := offset + i
		ranges = append(ranges, Range{Start: start, End: start + len(m.needle)})
		offset = start + len(m.needle)
	}
	return ranges
}

// indexFold returns the byte offset of the first ASCII-case-insensitive
// occurrence of needle in hay, or -1. needle must already be ASCII-lowercase.
//
// indexByte is passed in (strings.IndexByte or bytes.IndexByte) so one
// implementation serves both haystack types while keeping the optimized byte
// search: text with no candidate byte — by far the common case — never enters
// the byte-at-a-time comparison loop.
func indexFold[T ~string | ~[]byte](hay T, needle string, indexByte func(T, byte) int) int {
	n := len(needle)
	if n == 0 || n > len(hay) {
		return -1
	}
	lower := needle[0]
	upper := asciiUpperByte(lower)

	// Beyond last the needle can no longer fit, so only hay[:last+1] holds
	// viable starting positions.
	last := len(hay) - n
	for i := 0; i <= last; i++ {
		next := indexEitherByte(hay[i:last+1], lower, upper, indexByte)
		if next < 0 {
			return -1
		}
		i += next
		if equalASCIIFold(hay[i:i+n], needle) {
			return i
		}
	}
	return -1
}

func indexEitherByte[T ~string | ~[]byte](s T, a, b byte, indexByte func(T, byte) int) int {
	if a == b {
		return indexByte(s, a)
	}
	i := indexByte(s, a)
	j := indexByte(s, b)
	if i < 0 {
		return j
	}
	if j < 0 {
		return i
	}
	return min(i, j)
}

// equalASCIIFold compares a against an already ASCII-lowercased b of equal length.
func equalASCIIFold[T ~string | ~[]byte](a T, b string) bool {
	for i := 0; i < len(a); i++ {
		if asciiLowerByte(a[i]) != b[i] {
			return false
		}
	}
	return true
}

func asciiLowerByte(b byte) byte {
	if 'A' <= b && b <= 'Z' {
		return b + ('a' - 'A')
	}
	return b
}

func asciiUpperByte(b byte) byte {
	if 'a' <= b && b <= 'z' {
		return b - ('a' - 'A')
	}
	return b
}

func asciiLowerString(s string) string {
	b := []byte(s)
	for i := range b {
		b[i] = asciiLowerByte(b[i])
	}
	return string(b)
}

func isASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= utf8.RuneSelf {
			return false
		}
	}
	return true
}
