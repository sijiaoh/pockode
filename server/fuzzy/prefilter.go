package fuzzy

import "bytes"

// MayMatchWithin reports whether some part of text could match the pattern,
// as a cheap test that rules out a whole text of many lines before any of
// them is matched one by one: false means no line of text can match.
//
// Every term set needs one of its terms present in text: a fuzzy term's
// characters in order, any other term's text as a literal. Both are necessary
// for a line to match and are found with byte searches over text, so the test
// costs about one pass, and for the literal terms it is the same scan a plain
// substring search would make. A term set with an excluding term always
// passes, since a line can satisfy it by lacking something.
//
// It decides only for ASCII text, as fzf's own byte prefilter does
// (asciiFuzzyIndex): on other text, normalization lets "e" match "é" and
// lowercasing lets "k" match the Kelvin sign, which no byte search sees. For
// such a text it always returns true.
func (p *Pattern) MayMatchWithin(text []byte) bool {
	if !isASCIIBytes(text) {
		return true
	}
	chars := Chars{bytes: text}
	for _, set := range p.termSets {
		if !set.mayMatchWithin(&chars) {
			return false
		}
	}
	return true
}

func (set termSet) mayMatchWithin(text *Chars) bool {
	for _, term := range set {
		if term.inv {
			return true
		}
		// A term that is still non-ASCII after lowercasing cannot match
		// ASCII text at all.
		if !isAscii(term.text) {
			continue
		}
		if term.typ == termFuzzy {
			if idx, _ := asciiFuzzyIndex(text, term.text, term.caseSensitive); idx >= 0 {
				return true
			}
		} else if containsASCII(text, term.text, term.caseSensitive) {
			return true
		}
	}
	return false
}

// containsASCII reports whether text holds pattern as a literal. pattern is
// ASCII, and lowercase unless caseSensitive.
func containsASCII(text *Chars, pattern []rune, caseSensitive bool) bool {
	needle := make([]byte, len(pattern))
	for i, r := range pattern {
		needle[i] = byte(r)
	}
	hay := text.Bytes()
	if caseSensitive {
		return bytes.Contains(hay, needle)
	}

	// trySkip finds the next candidate start in both cases at once, so text
	// without the first character never reaches the byte-by-byte comparison.
	last := len(hay) - len(needle)
	for i := 0; i <= last; i++ {
		i = trySkip(text, false, needle[0], i)
		if i < 0 || i > last {
			return false
		}
		if equalASCIIFold(hay[i:i+len(needle)], needle) {
			return true
		}
	}
	return false
}

// equalASCIIFold compares a against the ASCII-lowercase b of equal length.
func equalASCIIFold(a, b []byte) bool {
	for i, c := range a {
		if 'A' <= c && c <= 'Z' {
			c += 'a' - 'A'
		}
		if c != b[i] {
			return false
		}
	}
	return true
}
