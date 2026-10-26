package search

import (
	"slices"
	"testing"
	"unicode/utf16"
)

// sliceUTF16 slices s the way JS slices a string, which is how the client
// reads a Range.
func sliceUTF16(s string, r Range) string {
	return string(utf16.Decode(utf16.Encode([]rune(s))[r.Start:r.End]))
}

func TestToClientText(t *testing.T) {
	tests := []struct {
		name     string
		text     string
		ranges   []Range
		wantText string
		want     []Range
	}{
		{
			name: "ascii is unchanged", text: "a needle", ranges: []Range{{2, 8}},
			wantText: "a needle", want: []Range{{2, 8}},
		},
		{
			// 日本 is 6 bytes but 2 UTF-16 units.
			name: "multibyte counts one unit per BMP character", text: "日本 needle",
			ranges: []Range{{7, 13}}, wantText: "日本 needle", want: []Range{{3, 9}},
		},
		{
			// 😀 is 4 bytes and a surrogate pair.
			name: "astral character counts two units", text: "😀needle😀x",
			ranges: []Range{{4, 10}, {14, 15}}, wantText: "😀needle😀x", want: []Range{{2, 8}, {10, 11}},
		},
		{
			name: "range covering multibyte text", text: "x日本y",
			ranges: []Range{{1, 7}}, wantText: "x日本y", want: []Range{{1, 3}},
		},
		{
			// Each invalid byte becomes its own U+FFFD, as encoding/json does,
			// including both bytes of a truncated sequence.
			name: "invalid bytes become one U+FFFD each", text: "\xff\xe6\x97 needle",
			ranges: []Range{{4, 10}}, wantText: "��� needle", want: []Range{{4, 10}},
		},
		{
			name: "adjacent ranges", text: "日ab", ranges: []Range{{3, 4}, {4, 5}},
			wantText: "日ab", want: []Range{{1, 2}, {2, 3}},
		},
		{
			name: "range ending at end of text", text: "日ab", ranges: []Range{{3, 5}},
			wantText: "日ab", want: []Range{{1, 3}},
		},
		{
			name: "no ranges", text: "日", wantText: "日", want: []Range{},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotText, got := toClientText(tt.text, tt.ranges)
			if gotText != tt.wantText {
				t.Errorf("got text %q, want %q", gotText, tt.wantText)
			}
			if !slices.Equal(got, tt.want) {
				t.Errorf("got ranges %+v, want %+v", got, tt.want)
			}
		})
	}
}
