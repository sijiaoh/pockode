package fuzzy

import "unicode/utf8"

// ToCharsBuffer is ToChars for a caller preparing many texts in turn, such as
// the lines of a file: a non-ASCII text is decoded into buf's storage, grown
// when too small, instead of a fresh slice each time. It returns buf to pass
// on the next call. The Chars aliases buf, so it is valid only until then.
func ToCharsBuffer(text []byte, buf []rune) (Chars, []rune) {
	if isASCIIBytes(text) {
		return Chars{bytes: text}, buf
	}
	buf = buf[:0]
	for i := 0; i < len(text); {
		r, sz := utf8.DecodeRune(text[i:])
		i += sz
		buf = append(buf, r)
	}
	return Chars{runes: buf}, buf
}
