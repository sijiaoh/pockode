package search

import (
	"slices"
	"testing"
)

// fuzzy counts an invalid UTF-8 byte as one rune; the ranges must then land
// on the U+FFFD that byte becomes on the wire. Tested below Search because
// macOS and Windows refuse such file names.
func TestPositionsToClientRangesInvalidUTF8(t *testing.T) {
	text := "a\xff😀b/c"
	// Runes: a, \xff, 😀, b, /, c.
	byteRanges := positionsToByteRanges(text, []int{1, 2, 3, 5})
	if want := []Range{{Start: 1, End: 7}, {Start: 8, End: 9}}; !slices.Equal(byteRanges, want) {
		t.Fatalf("got byte ranges %+v, want %+v", byteRanges, want)
	}

	clientText, ranges := toClientText(text, byteRanges)
	var got []string
	for _, r := range ranges {
		got = append(got, sliceUTF16(clientText, r))
	}
	if want := []string{"�😀b", "c"}; !slices.Equal(got, want) {
		t.Errorf("got %q, want %q", got, want)
	}
}
