package agent

import (
	"log/slog"
	"testing"
)

// riffWebP wraps one chunk in the RIFF container a WebP file is.
func riffWebP(fourCC string, payload []byte) []byte {
	chunk := append([]byte(fourCC), byte(len(payload)), 0, 0, 0)
	chunk = append(chunk, payload...)
	riff := append([]byte("WEBP"), chunk...)
	return append([]byte{'R', 'I', 'F', 'F', byte(len(riff)), 0, 0, 0}, riff...)
}

func TestImageDimensionsWebP(t *testing.T) {
	log := slog.New(slog.DiscardHandler)
	lossless := uint32(640-1) | uint32(480-1)<<14
	tests := []struct {
		name  string
		data  []byte
		wantW int
		wantH int
	}{
		{
			name:  "lossy",
			data:  riffWebP("VP8 ", []byte{0, 0, 0, 0x9d, 0x01, 0x2a, 0x80, 0x02, 0xe0, 0x01}),
			wantW: 640, wantH: 480,
		},
		{
			name:  "lossless",
			data:  riffWebP("VP8L", []byte{0x2f, byte(lossless), byte(lossless >> 8), byte(lossless >> 16), byte(lossless >> 24)}),
			wantW: 640, wantH: 480,
		},
		{
			name:  "extended",
			data:  riffWebP("VP8X", []byte{0, 0, 0, 0, 0x7f, 0x02, 0, 0xdf, 0x01, 0}),
			wantW: 640, wantH: 480,
		},
		{
			name: "lossy without its start code",
			data: riffWebP("VP8 ", []byte{0, 0, 0, 0, 0, 0, 0x80, 0x02, 0xe0, 0x01}),
		},
		{
			name: "cut short inside the chunk",
			data: riffWebP("VP8X", []byte{0, 0, 0, 0, 0x7f}),
		},
		{
			name: "not a WebP",
			data: []byte("RIFF\x00\x00\x00\x00WAVEfmt \x00\x00\x00\x00"),
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			w, h := ImageDimensions(log, tt.data)
			if w != tt.wantW || h != tt.wantH {
				t.Errorf("got %dx%d, want %dx%d", w, h, tt.wantW, tt.wantH)
			}
		})
	}
}
