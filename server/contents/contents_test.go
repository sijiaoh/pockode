package contents

import (
	"bytes"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/pockode/server/attachments"
	"github.com/pockode/server/internal/fifotest"
	"github.com/pockode/server/internal/symlinktest"
)

// ValidatePath guards every file operation the client can reach, and ws/rpc_git.go
// runs it over paths it then hands to git — whose own validatePath must reach the
// same verdict. Both now delegate to filepath.IsLocal, so they agree by
// construction; this pins down what that contract admits.
func TestValidatePath(t *testing.T) {
	workDir := filepath.Join(string(filepath.Separator)+"repo", "project")

	tests := []struct {
		name    string
		path    string
		wantErr bool
	}{
		{"empty means the work directory itself", "", false},
		{"plain file", "file.txt", false},
		{"nested file", "dir/file.txt", false},
		{"dotfile", ".gitignore", false},
		// A leading ".." is only an escape when the whole segment is "..".
		// git.validatePath has always accepted this one; ValidatePath used to
		// reject it, so the same file was listable but not stageable.
		{"file whose name starts with dots", "..foo", false},
		{"traversal", "../secret", true},
		{"traversal after normalization", "dir/../../secret", true},
		{"absolute", "/etc/passwd", true},
		// The work directory is spelled "", never "." — the containment check
		// keeps the two from becoming interchangeable spellings.
		{"dot", ".", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := ValidatePath(workDir, tt.path); (err != nil) != tt.wantErr {
				t.Errorf("ValidatePath(%q, %q) error = %v, wantErr %v", workDir, tt.path, err, tt.wantErr)
			}
		})
	}
}

// A path Windows resolves to a device rather than to a file under workDir is no
// more "inside" the work directory than an absolute path is. Elsewhere these are
// ordinary names and must keep working, so both answers are asserted.
func TestValidatePath_ReservedDeviceNames(t *testing.T) {
	workDir := filepath.Join(string(filepath.Separator)+"repo", "project")
	wantErr := runtime.GOOS == "windows"

	for _, path := range []string{"NUL", "COM1", "aux", "dir/CON"} {
		t.Run(path, func(t *testing.T) {
			if err := ValidatePath(workDir, path); (err != nil) != wantErr {
				t.Errorf("ValidatePath(%q, %q) error = %v, wantErr %v", workDir, path, err, wantErr)
			}
		})
	}
}

// pngHeader is the signature http.DetectContentType matches; the pixels that
// would follow it are irrelevant to the read path.
var pngHeader = []byte("\x89PNG\r\n\x1a\n")

func writeTestFile(t *testing.T, workDir, name string, data []byte) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(workDir, name), data, 0644); err != nil {
		t.Fatalf("failed to create %s: %v", name, err)
	}
}

// writeTestImage writes a PNG of size bytes. Sparse past the header, so an
// image at the attachment ceiling costs no disk.
func writeTestImage(t *testing.T, workDir, name string, size int64) {
	t.Helper()
	writeTestFile(t, workDir, name, pngHeader)
	if err := os.Truncate(filepath.Join(workDir, name), size); err != nil {
		t.Fatalf("failed to size %s: %v", name, err)
	}
}

func getFile(t *testing.T, workDir, path string) *FileContent {
	t.Helper()
	result, err := GetContents(workDir, path)
	if err != nil {
		t.Fatalf("GetContents failed: %v", err)
	}
	if result.File == nil {
		t.Fatal("expected file content, got directory listing")
	}
	return result.File
}

func TestGetContents_ReadFile(t *testing.T) {
	t.Run("returns text content with size and mime", func(t *testing.T) {
		workDir := t.TempDir()
		writeTestFile(t, workDir, "hello.txt", []byte("world"))

		file := getFile(t, workDir, "hello.txt")

		if file.Encoding != EncodingText {
			t.Errorf("got encoding %q, want %q", file.Encoding, EncodingText)
		}
		if file.Content != "world" {
			t.Errorf("got content %q, want %q", file.Content, "world")
		}
		if file.Size != 5 {
			t.Errorf("got size %d, want 5", file.Size)
		}
		if !strings.HasPrefix(file.MIME, "text/plain") {
			t.Errorf("got mime %q, want text/plain", file.MIME)
		}
		if file.Omitted != "" {
			t.Errorf("got omitted %q, want empty", file.Omitted)
		}
	})

	// A raster image's bytes are fetched over HTTP, so the response is metadata
	// alone — and, since MaxFileSize is the JSON-RPC message's ceiling, that
	// holds for an image past it too, up to the attachment ceiling.
	for _, tc := range []struct {
		name string
		size int
	}{
		{"that is small", len(pngHeader) + 8},
		{"over the size limit", MaxFileSize + 1},
		{"at the attachment limit", attachments.MaxSize},
	} {
		t.Run("describes a raster image "+tc.name+" for fetching over http", func(t *testing.T) {
			workDir := t.TempDir()
			writeTestImage(t, workDir, "logo.png", int64(tc.size))

			file := getFile(t, workDir, "logo.png")

			if file.Encoding != EncodingHTTP {
				t.Errorf("got encoding %q, want %q", file.Encoding, EncodingHTTP)
			}
			if file.Content != "" {
				t.Errorf("expected no content, got %d bytes", len(file.Content))
			}
			if file.MIME != "image/png" {
				t.Errorf("got mime %q, want image/png", file.MIME)
			}
			if file.Size != int64(tc.size) {
				t.Errorf("got size %d, want %d", file.Size, tc.size)
			}
			if file.Omitted != "" || file.Limit != 0 {
				t.Errorf("got omitted %q limit %d, want neither", file.Omitted, file.Limit)
			}
		})
	}

	// Past the attachment ceiling an image is not previewed, and is reported the
	// way any content too large to show is.
	t.Run("omits a raster image over the attachment limit", func(t *testing.T) {
		workDir := t.TempDir()
		size := int64(attachments.MaxSize + 1)
		writeTestImage(t, workDir, "huge.png", size)

		file := getFile(t, workDir, "huge.png")

		if file.Encoding != EncodingNone || file.Omitted != OmitTooLarge {
			t.Errorf("got %q/%q, want none/too_large", file.Encoding, file.Omitted)
		}
		if file.Limit != attachments.MaxSize {
			t.Errorf("got limit %d, want %d", file.Limit, attachments.MaxSize)
		}
		if file.Size != size || file.MIME != "image/png" {
			t.Errorf("got size %d mime %q, want %d image/png", file.Size, file.MIME, size)
		}
	})

	// Audio and video are streamed rather than held whole, so neither ceiling
	// applies: past the image ceiling they are still described for fetching.
	// A .mov is named by its extension alone, since sniffing does not know
	// QuickTime's brand.
	for _, tc := range []struct {
		name string
		head string
		mime string
	}{
		{"clip.mov", "\x00\x00\x00\x14ftypqt  \x00\x00\x00\x00qt  ", "video/quicktime"},
		{"clip.mp4", "\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isommp41", "video/mp4"},
		{"memo.mp3", "ID3\x04\x00\x00\x00\x00\x00\x00", "audio/mpeg"},
	} {
		t.Run("describes "+tc.name+" over the image limit for fetching over http", func(t *testing.T) {
			workDir := t.TempDir()
			size := int64(attachments.MaxSize + 1)
			writeTestFile(t, workDir, tc.name, []byte(tc.head))
			if err := os.Truncate(filepath.Join(workDir, tc.name), size); err != nil {
				t.Fatalf("failed to size %s: %v", tc.name, err)
			}

			file := getFile(t, workDir, tc.name)

			if file.Encoding != EncodingHTTP || file.Content != "" {
				t.Errorf("got encoding %q with %d bytes of content, want http and none", file.Encoding, len(file.Content))
			}
			if file.MIME != tc.mime || file.Size != size {
				t.Errorf("got mime %q size %d, want %q %d", file.MIME, file.Size, tc.mime, size)
			}
			if file.Omitted != "" || file.Limit != 0 {
				t.Errorf("got omitted %q limit %d, want neither", file.Omitted, file.Limit)
			}
		})
	}

	// SVG is an image the UI can render and source the user can edit, so it
	// keeps its text encoding while still reporting an image mime.
	t.Run("reports svg as an image but keeps it text", func(t *testing.T) {
		workDir := t.TempDir()
		svg := `<svg xmlns="http://www.w3.org/2000/svg"></svg>`
		writeTestFile(t, workDir, "icon.svg", []byte(svg))

		file := getFile(t, workDir, "icon.svg")

		if file.MIME != "image/svg+xml" {
			t.Errorf("got mime %q, want image/svg+xml", file.MIME)
		}
		if file.Encoding != EncodingText || file.Content != svg {
			t.Errorf("got encoding %q content %q, want the svg source as text", file.Encoding, file.Content)
		}
	})

	// AVIF is named by its extension alone, so a text file carrying one (a
	// git-LFS pointer, say) must still come back as the text it is rather than
	// as an image the client cannot draw.
	t.Run("keeps text under an image extension as text", func(t *testing.T) {
		workDir := t.TempDir()
		pointer := "version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 12345\n"
		writeTestFile(t, workDir, "photo.avif", []byte(pointer))

		file := getFile(t, workDir, "photo.avif")

		if file.Encoding != EncodingText || file.Content != pointer {
			t.Errorf("got encoding %q content %q, want the pointer as text", file.Encoding, file.Content)
		}
	})

	t.Run("keeps text under a video extension as text", func(t *testing.T) {
		workDir := t.TempDir()
		pointer := "version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 12345\n"
		writeTestFile(t, workDir, "clip.mov", []byte(pointer))

		file := getFile(t, workDir, "clip.mov")

		if file.Encoding != EncodingText || file.Content != pointer {
			t.Errorf("got encoding %q content %q, want the pointer as text", file.Encoding, file.Content)
		}
	})

	t.Run("mislabelled extension does not override sniffed type", func(t *testing.T) {
		workDir := t.TempDir()
		writeTestFile(t, workDir, "actually.svg", pngHeader)

		file := getFile(t, workDir, "actually.svg")

		if file.MIME != "image/png" {
			t.Errorf("got mime %q, want image/png", file.MIME)
		}
	})

	t.Run("omits content of non-image binaries", func(t *testing.T) {
		workDir := t.TempDir()
		// High-entropy bytes with no NUL: the shape (compressed data) the old
		// null-byte probe classified as text and shipped whole.
		writeTestFile(t, workDir, "bundle.js.br", bytes.Repeat([]byte{0xFF, 0xFE}, 512))

		file := getFile(t, workDir, "bundle.js.br")

		if file.Encoding != EncodingNone || file.Omitted != OmitBinary {
			t.Errorf("got encoding %q omitted %q, want %q/%q", file.Encoding, file.Omitted, EncodingNone, OmitBinary)
		}
		if file.Content != "" {
			t.Errorf("expected no content, got %d bytes", len(file.Content))
		}
		if file.Size != 1024 {
			t.Errorf("got size %d, want 1024", file.Size)
		}
		// Only a size refusal carries a limit; naming one here would suggest the
		// file would have been shown had it been smaller.
		if file.Limit != 0 {
			t.Errorf("got limit %d, want none", file.Limit)
		}
	})

	t.Run("omits content above the size limit", func(t *testing.T) {
		workDir := t.TempDir()
		writeTestFile(t, workDir, "huge.txt", bytes.Repeat([]byte("a"), MaxFileSize+1))

		file := getFile(t, workDir, "huge.txt")

		if file.Encoding != EncodingNone || file.Omitted != OmitTooLarge {
			t.Errorf("got encoding %q omitted %q, want %q/%q", file.Encoding, file.Omitted, EncodingNone, OmitTooLarge)
		}
		if file.Content != "" {
			t.Errorf("expected no content, got %d bytes", len(file.Content))
		}
		if file.Size != MaxFileSize+1 {
			t.Errorf("got size %d, want %d", file.Size, MaxFileSize+1)
		}
		// Metadata still has to be usable, or the client cannot say what it is
		// that it is refusing to show.
		if !strings.HasPrefix(file.MIME, "text/plain") {
			t.Errorf("got mime %q, want text/plain", file.MIME)
		}
		// The client names the threshold in its placeholder, so it has to arrive
		// with the refusal rather than be kept as a second copy of the constant.
		if file.Limit != MaxFileSize {
			t.Errorf("got limit %d, want %d", file.Limit, MaxFileSize)
		}
	})

	t.Run("reads a file exactly at the size limit", func(t *testing.T) {
		workDir := t.TempDir()
		writeTestFile(t, workDir, "limit.txt", bytes.Repeat([]byte("a"), MaxFileSize))

		file := getFile(t, workDir, "limit.txt")

		if file.Encoding != EncodingText {
			t.Errorf("got encoding %q, want %q", file.Encoding, EncodingText)
		}
		if len(file.Content) != MaxFileSize {
			t.Errorf("got %d bytes of content, want %d", len(file.Content), MaxFileSize)
		}
	})

	t.Run("returns empty files as text", func(t *testing.T) {
		workDir := t.TempDir()
		writeTestFile(t, workDir, "empty.txt", nil)

		file := getFile(t, workDir, "empty.txt")

		if file.Encoding != EncodingText || file.Content != "" {
			t.Errorf("got encoding %q content %q, want empty text", file.Encoding, file.Content)
		}
	})

	// Opening a fifo blocks until something writes to it, so it has to be
	// refused from the stat rather than discovered while reading.
	t.Run("refuses a named pipe instead of blocking on it", func(t *testing.T) {
		workDir := t.TempDir()
		fifotest.Make(t, workDir, "pipe")

		done := make(chan error, 1)
		go func() {
			_, err := GetContents(workDir, "pipe")
			done <- err
		}()

		select {
		case err := <-done:
			if !errors.Is(err, ErrInvalidPath) {
				t.Errorf("got error %v, want ErrInvalidPath", err)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("GetContents blocked on the fifo")
		}
	})
}

// Whether text is a page decides whether the client renders it, so it is
// settled by name: sniffing alone misses a page that opens with text and
// catches a component that opens with a tag.
func TestDetectMIME_HTML(t *testing.T) {
	tests := []struct {
		name string
		file string
		head string
		want string
	}{
		{"page opening with a tag", "index.html", "<!doctype html><p>hi", "text/html; charset=utf-8"},
		{"page opening with text", "index.html", "Hello <b>world</b>", "text/html; charset=utf-8"},
		{".htm, any case", "OLD.HTM", "Hello", "text/html; charset=utf-8"},
		{"page opening with an XML prolog", "page.html", "<?xml version=\"1.0\"?><html>", "text/html; charset=utf-8"},
		{"empty page", "blank.html", "", "text/html; charset=utf-8"},
		{"component opening with a script tag", "App.svelte", "<script>let x = 1</script>", "text/plain; charset=utf-8"},
		{"vue component", "App.vue", "<template><div/></template><script>", "text/plain; charset=utf-8"},
		{"no extension", "README", "<html><body>", "text/plain; charset=utf-8"},
		{"svg opening with a comment is still an image", "logo.svg", "<!-- logo --><svg xmlns=\"http://www.w3.org/2000/svg\"/>", "image/svg+xml"},
		{"binary named .html stays binary", "x.html", "\x89PNG\r\n\x1a\n\x00\x00", "image/png"},
		{"text that is not HTML elsewhere is untouched", "notes.txt", "hello", "text/plain; charset=utf-8"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := DetectMIME(tt.file, []byte(tt.head)); got != tt.want {
				t.Errorf("DetectMIME(%q) = %q, want %q", tt.file, got, tt.want)
			}
		})
	}
}

// Heads of what Chromium's MediaRecorder wrote for a short recording, cut
// where the first Cluster begins. Both carry an Opus track; only the second
// carries a VP8 one too.
var (
	chromeAudioWebM = mustHex("1a45dfa39f4286810142f7810142f2810442f381084282847765626d4287810442858102185380670100000000001f28114d9b74b94dbb8b53ab841549a96653ac816e4dbb8b53ab841654ae6b53ac81934dbb8b53ab841f43b67553ac81d74dbb8c53ab841c53bb6b53ac821f16ecae000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001549a966a02ad7b1830f424044898443d2578d4d80864368726f6d655741864368726f6d651654ae6bbfaebdd7810173c5878ed91aa04c1a1c8381028686415f4f50555363a2934f707573486561640102000080bb0000000000e18db584473b80009f810262648120")
	chromeVideoWebM = mustHex("1a45dfa39f4286810142f7810142f2810442f381084282847765626d4287810442858102185380670100000000002499114d9b74ba4dbb8b53ab841549a96653ac816e4dbb8b53ab841654ae6b53ac81934dbb8c53ab841f43b67553ac8201134dbb8c53ab841c53bb6b53ac822486ecad0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001549a966a02ad7b1830f424044898443e03a3d4d80864368726f6d655741864368726f6d651654ae6bfbaebad7810173c58756179aa3c55e7083810155ee81018685565f565038e09db08140ba814053c0810155b09055b1810155b9810255ba810d55bb8101aebdd7810273c5879efa59bf2e7ad18381028686415f4f50555363a2934f707573486561640102000080bb0000000000e18db584473b80009f810262648120")
	// The ftyp box of an iPhone Voice Memos recording.
	voiceMemoM4A = []byte("\x00\x00\x00\x1cftypM4A \x00\x00\x00\x00M4A isommp42\x00\x00\x00\x00")
	// The first Ogg page of an Opus stream: its only packet is the OpusHead.
	opusOgg = []byte("OggS\x00\x02\x00\x00\x00\x00\x00\x00\x00\x00\x2a\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x01\x13OpusHead\x01\x01\x38\x01\x80\xbb\x00\x00\x00\x00\x00")
	isomMP4 = []byte("\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isommp41")
	// The same recording with a 600-byte Void element ahead of its track list,
	// as a muxer reserving room for a seek index writes it: whole, but with
	// the Tracks past SniffLen.
	paddedAudioWebM = slices.Concat(chromeAudioWebM[:48], []byte{0xEC, 0x42, 0x58}, make([]byte, 600), chromeAudioWebM[48:])
)

func mustHex(s string) []byte {
	b, err := hex.DecodeString(s)
	if err != nil {
		panic(err)
	}
	return b
}

func TestDetectMIME(t *testing.T) {
	tests := []struct {
		name string
		file string
		head []byte
		want string
	}{
		// Containers that hold audio as readily as video: the extension says
		// which, since the sniffer only knows the container.
		{"voice memo in mp4", "memo.m4a", voiceMemoM4A, "audio/mp4"},
		{"audiobook in mp4", "book.M4B", isomMP4, "audio/mp4"},
		{"weba whose track list the head does not reach", "note.weba", chromeAudioWebM[:40], "audio/webm"},
		{"opus named .opus", "note.opus", opusOgg, "audio/ogg"},
		{"ogg named .ogg", "song.ogg", opusOgg, "audio/ogg"},
		{"ogg named .oga", "song.oga", opusOgg, "audio/ogg"},
		{"ogg named .ogv", "clip.ogv", opusOgg, "video/ogg"},

		// A recording is named .webm whether or not it has a picture, so
		// there the track list decides.
		{"audio-only browser recording", "rec.webm", chromeAudioWebM, "audio/webm"},
		{"browser recording with video", "rec.webm", chromeVideoWebM, "video/webm"},
		{"webm cut before its track list", "rec.webm", chromeAudioWebM[:100], "video/webm"},
		{"webm whose track list runs past the head", "rec.webm", chromeAudioWebM[:len(chromeAudioWebM)-20], "video/webm"},
		{"whole webm with its track list past SniffLen", "rec.webm", paddedAudioWebM, "video/webm"},

		// Content still wins everywhere else.
		{"mp4 video", "clip.mp4", isomMP4, "video/mp4"},
		{"mp4 with no extension", "clip", voiceMemoM4A, "video/mp4"},
		{"png named as audio", "memo.m4a", pngHeader, "image/png"},
		{"webm named as mp4 audio", "memo.m4a", chromeVideoWebM, "video/webm"},
		{"ogg named as mp4 audio", "memo.m4a", opusOgg, "application/ogg"},
		{"mp4 named as ogg audio", "song.ogg", isomMP4, "video/mp4"},
		{"unknown extension on ogg", "data.bin", opusOgg, "application/ogg"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := DetectMIME(tt.file, tt.head); got != tt.want {
				t.Errorf("DetectMIME(%q) = %q, want %q", tt.file, got, tt.want)
			}
		})
	}
}

// What a page loads is served as what it is: a document it navigates to keeps
// its sniffed HTML type whatever it is named, and the page itself is HTML even
// when it opens with text.
func TestDetectServedMIME_HTML(t *testing.T) {
	tests := []struct {
		file string
		head string
		want string
	}{
		{"about", "<html><body>", "text/html; charset=utf-8"},
		{"index.html", "Hello", "text/html; charset=utf-8"},
		{"app.css", "body{}", "text/css; charset=utf-8"},
		{"logo.svg", "<!-- logo --><svg/>", "image/svg+xml"},
		{"app.js", "<!-- legacy guard -->\nvar x", "text/javascript; charset=utf-8"},
	}
	for _, tt := range tests {
		if got := DetectServedMIME(tt.file, []byte(tt.head)); got != tt.want {
			t.Errorf("DetectServedMIME(%q) = %q, want %q", tt.file, got, tt.want)
		}
	}
}

func TestIsBinary(t *testing.T) {
	tests := []struct {
		name string
		data []byte
		want bool
	}{
		{"empty", nil, false},
		{"ascii text", []byte("package main\n"), false},
		{"utf-8 text", []byte("日本語のテキスト\n"), false},
		{"null byte past the sniff window", append(bytes.Repeat([]byte("a"), 600), 0), true},
		{"known binary signature", pngHeader, true},
		// Uniformly random bytes clear the null-byte probe roughly one time in
		// seven, which is how compressed assets used to reach the client as text.
		{"high entropy without null bytes", bytes.Repeat([]byte{0xFF, 0xFE}, 300), true},
		// Deliberate: JSON would deliver this as mojibake with no way for the
		// client to tell. See IsBinary.
		{"text in a legacy encoding", []byte("caf\xe9 au lait\n"), true},
		// Given the whole file there is no probe window to blame, so the leniency
		// IsBinaryProbe needs must not reach here: JSON would otherwise ship this
		// as "hello�", the very substitution IsBinary exists to refuse.
		{"invalid byte at the very end", []byte("hello\xff"), true},
		{"truncated multi-byte rune at the very end", append([]byte("hello"), []byte("世")[:2]...), true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := IsBinary(tt.data); got != tt.want {
				t.Errorf("IsBinary() = %v, want %v", got, tt.want)
			}
		})
	}
}

// A prefix ending mid-character is the normal case for a fixed-size probe, so
// unlike IsBinary it must not be counted against the file — every source file
// with a multi-byte character straddling byte 512 would drop out of content
// search.
func TestIsBinaryProbe(t *testing.T) {
	head := append(bytes.Repeat([]byte("a"), 510), []byte("世")[:2]...)

	if IsBinaryProbe(head) {
		t.Error("IsBinaryProbe() = true for a rune cut off by the probe window, want false")
	}
	if !IsBinaryProbe(bytes.Repeat([]byte{0xFF, 0xFE}, 300)) {
		t.Error("IsBinaryProbe() = false for high-entropy bytes, want true")
	}
}

func TestWriteFile(t *testing.T) {
	t.Run("creates new file", func(t *testing.T) {
		workDir := t.TempDir()
		path := "newfile.txt"
		content := "hello world"

		err := WriteFile(workDir, path, content)
		if err != nil {
			t.Fatalf("WriteFile failed: %v", err)
		}

		data, err := os.ReadFile(filepath.Join(workDir, path))
		if err != nil {
			t.Fatalf("failed to read file: %v", err)
		}
		if string(data) != content {
			t.Errorf("got content %q, want %q", string(data), content)
		}
	})

	t.Run("updates existing file", func(t *testing.T) {
		workDir := t.TempDir()
		path := "existing.txt"

		if err := os.WriteFile(filepath.Join(workDir, path), []byte("old"), 0644); err != nil {
			t.Fatalf("failed to create existing file: %v", err)
		}

		newContent := "new content"
		err := WriteFile(workDir, path, newContent)
		if err != nil {
			t.Fatalf("WriteFile failed: %v", err)
		}

		data, err := os.ReadFile(filepath.Join(workDir, path))
		if err != nil {
			t.Fatalf("failed to read file: %v", err)
		}
		if string(data) != newContent {
			t.Errorf("got content %q, want %q", string(data), newContent)
		}
	})

	t.Run("creates parent directories", func(t *testing.T) {
		workDir := t.TempDir()
		path := "nested/deep/file.txt"
		content := "nested content"

		err := WriteFile(workDir, path, content)
		if err != nil {
			t.Fatalf("WriteFile failed: %v", err)
		}

		data, err := os.ReadFile(filepath.Join(workDir, path))
		if err != nil {
			t.Fatalf("failed to read file: %v", err)
		}
		if string(data) != content {
			t.Errorf("got content %q, want %q", string(data), content)
		}
	})

	t.Run("returns error for empty path", func(t *testing.T) {
		workDir := t.TempDir()

		err := WriteFile(workDir, "", "content")
		if err == nil {
			t.Fatal("expected error for empty path")
		}
	})

	t.Run("returns error for path traversal", func(t *testing.T) {
		workDir := t.TempDir()

		err := WriteFile(workDir, "../outside.txt", "content")
		if err == nil {
			t.Fatal("expected error for path traversal")
		}
	})

	t.Run("creates empty file", func(t *testing.T) {
		workDir := t.TempDir()
		path := "empty.txt"

		err := WriteFile(workDir, path, "")
		if err != nil {
			t.Fatalf("WriteFile failed: %v", err)
		}

		info, err := os.Stat(filepath.Join(workDir, path))
		if err != nil {
			t.Fatalf("failed to stat file: %v", err)
		}
		if info.Size() != 0 {
			t.Errorf("got size %d, want 0", info.Size())
		}
	})

	t.Run("refuses content over MaxFileSize", func(t *testing.T) {
		workDir := t.TempDir()
		// Nested, so the check is also shown to run before the parent
		// directories are made: a refused write leaves nothing behind.
		path := "nested/huge.txt"

		err := WriteFile(workDir, path, strings.Repeat("a", MaxFileSize+1))
		if !errors.Is(err, ErrTooLarge) {
			t.Fatalf("got %v, want ErrTooLarge", err)
		}
		if _, err := os.Stat(filepath.Join(workDir, "nested")); !os.IsNotExist(err) {
			t.Error("a refused write left a directory behind")
		}
	})

	t.Run("accepts content at MaxFileSize", func(t *testing.T) {
		workDir := t.TempDir()

		if err := WriteFile(workDir, "atlimit.txt", strings.Repeat("a", MaxFileSize)); err != nil {
			t.Fatalf("WriteFile failed: %v", err)
		}
	})
}

func TestDeleteFile(t *testing.T) {
	t.Run("deletes existing file", func(t *testing.T) {
		workDir := t.TempDir()
		path := "to-delete.txt"

		if err := os.WriteFile(filepath.Join(workDir, path), []byte("content"), 0644); err != nil {
			t.Fatalf("failed to create file: %v", err)
		}

		err := DeleteFile(workDir, path)
		if err != nil {
			t.Fatalf("DeleteFile failed: %v", err)
		}

		if _, err := os.Stat(filepath.Join(workDir, path)); !os.IsNotExist(err) {
			t.Error("expected file to be deleted")
		}
	})

	t.Run("returns error for empty path", func(t *testing.T) {
		workDir := t.TempDir()

		err := DeleteFile(workDir, "")
		if err == nil {
			t.Fatal("expected error for empty path")
		}
	})

	t.Run("returns error for path traversal", func(t *testing.T) {
		workDir := t.TempDir()

		err := DeleteFile(workDir, "../outside.txt")
		if err == nil {
			t.Fatal("expected error for path traversal")
		}
	})

	t.Run("returns error for non-existent file", func(t *testing.T) {
		workDir := t.TempDir()

		err := DeleteFile(workDir, "nonexistent.txt")
		if err == nil {
			t.Fatal("expected error for non-existent file")
		}
	})

	t.Run("deletes empty directory", func(t *testing.T) {
		workDir := t.TempDir()
		dirPath := "subdir"

		if err := os.Mkdir(filepath.Join(workDir, dirPath), 0755); err != nil {
			t.Fatalf("failed to create directory: %v", err)
		}

		err := DeleteFile(workDir, dirPath)
		if err != nil {
			t.Fatalf("DeleteFile failed: %v", err)
		}

		if _, err := os.Stat(filepath.Join(workDir, dirPath)); !os.IsNotExist(err) {
			t.Error("expected directory to be deleted")
		}
	})

	t.Run("deletes file in nested directory", func(t *testing.T) {
		workDir := t.TempDir()
		path := "nested/deep/file.txt"

		fullPath := filepath.Join(workDir, path)
		if err := os.MkdirAll(filepath.Dir(fullPath), 0755); err != nil {
			t.Fatalf("failed to create directories: %v", err)
		}
		if err := os.WriteFile(fullPath, []byte("content"), 0644); err != nil {
			t.Fatalf("failed to create file: %v", err)
		}

		err := DeleteFile(workDir, path)
		if err != nil {
			t.Fatalf("DeleteFile failed: %v", err)
		}

		if _, err := os.Stat(fullPath); !os.IsNotExist(err) {
			t.Error("expected file to be deleted")
		}
	})
}

func TestDelete(t *testing.T) {
	t.Run("deletes file", func(t *testing.T) {
		workDir := t.TempDir()
		path := "file.txt"

		if err := os.WriteFile(filepath.Join(workDir, path), []byte("content"), 0644); err != nil {
			t.Fatalf("failed to create file: %v", err)
		}

		err := Delete(workDir, path)
		if err != nil {
			t.Fatalf("Delete failed: %v", err)
		}

		if _, err := os.Stat(filepath.Join(workDir, path)); !os.IsNotExist(err) {
			t.Error("expected file to be deleted")
		}
	})

	t.Run("deletes empty directory", func(t *testing.T) {
		workDir := t.TempDir()
		path := "emptydir"

		if err := os.Mkdir(filepath.Join(workDir, path), 0755); err != nil {
			t.Fatalf("failed to create directory: %v", err)
		}

		err := Delete(workDir, path)
		if err != nil {
			t.Fatalf("Delete failed: %v", err)
		}

		if _, err := os.Stat(filepath.Join(workDir, path)); !os.IsNotExist(err) {
			t.Error("expected directory to be deleted")
		}
	})

	t.Run("deletes directory with contents recursively", func(t *testing.T) {
		workDir := t.TempDir()
		path := "parent"

		parentDir := filepath.Join(workDir, path)
		if err := os.MkdirAll(filepath.Join(parentDir, "child", "grandchild"), 0755); err != nil {
			t.Fatalf("failed to create directories: %v", err)
		}
		if err := os.WriteFile(filepath.Join(parentDir, "file1.txt"), []byte("1"), 0644); err != nil {
			t.Fatalf("failed to create file1: %v", err)
		}
		if err := os.WriteFile(filepath.Join(parentDir, "child", "file2.txt"), []byte("2"), 0644); err != nil {
			t.Fatalf("failed to create file2: %v", err)
		}
		if err := os.WriteFile(filepath.Join(parentDir, "child", "grandchild", "file3.txt"), []byte("3"), 0644); err != nil {
			t.Fatalf("failed to create file3: %v", err)
		}

		err := Delete(workDir, path)
		if err != nil {
			t.Fatalf("Delete failed: %v", err)
		}

		if _, err := os.Stat(parentDir); !os.IsNotExist(err) {
			t.Error("expected directory to be deleted")
		}
	})

	t.Run("returns error for empty path", func(t *testing.T) {
		workDir := t.TempDir()

		err := Delete(workDir, "")
		if err == nil {
			t.Fatal("expected error for empty path")
		}
	})

	t.Run("returns error for path traversal", func(t *testing.T) {
		workDir := t.TempDir()

		err := Delete(workDir, "../outside")
		if err == nil {
			t.Fatal("expected error for path traversal")
		}
	})

	t.Run("returns error for absolute path", func(t *testing.T) {
		workDir := t.TempDir()

		// Asserted on the reason, not just on "some error": an anchored path
		// that slips past validation is joined onto workDir and then fails as
		// not-found, which looks identical from the outside.
		err := Delete(workDir, "/absolute/path")
		if !errors.Is(err, ErrInvalidPath) {
			t.Fatalf("Delete(%q) error = %v, want ErrInvalidPath", "/absolute/path", err)
		}
	})

	t.Run("returns error for non-existent path", func(t *testing.T) {
		workDir := t.TempDir()

		err := Delete(workDir, "nonexistent")
		if err == nil {
			t.Fatal("expected error for non-existent path")
		}
	})
}

func TestCreate(t *testing.T) {
	t.Run("creates empty file", func(t *testing.T) {
		workDir := t.TempDir()

		if err := Create(workDir, "notes.md", false); err != nil {
			t.Fatalf("Create failed: %v", err)
		}

		info, err := os.Stat(filepath.Join(workDir, "notes.md"))
		if err != nil {
			t.Fatalf("failed to stat created file: %v", err)
		}
		if info.IsDir() {
			t.Error("expected a file, got a directory")
		}
		if info.Size() != 0 {
			t.Errorf("got size %d, want 0", info.Size())
		}
	})

	t.Run("creates directory", func(t *testing.T) {
		workDir := t.TempDir()

		if err := Create(workDir, "pkg", true); err != nil {
			t.Fatalf("Create failed: %v", err)
		}

		info, err := os.Stat(filepath.Join(workDir, "pkg"))
		if err != nil {
			t.Fatalf("failed to stat created directory: %v", err)
		}
		if !info.IsDir() {
			t.Error("expected a directory, got a file")
		}
	})

	t.Run("creates missing parent directories", func(t *testing.T) {
		workDir := t.TempDir()

		if err := Create(workDir, "docs/api/index.md", false); err != nil {
			t.Fatalf("Create failed: %v", err)
		}

		if _, err := os.Stat(filepath.Join(workDir, "docs/api/index.md")); err != nil {
			t.Fatalf("failed to stat created file: %v", err)
		}
	})

	t.Run("refuses existing path", func(t *testing.T) {
		workDir := t.TempDir()
		if err := os.WriteFile(filepath.Join(workDir, "taken.txt"), []byte("keep me"), 0644); err != nil {
			t.Fatalf("failed to create existing file: %v", err)
		}

		err := Create(workDir, "taken.txt", false)
		if !errors.Is(err, ErrExists) {
			t.Fatalf("got error %v, want ErrExists", err)
		}

		data, err := os.ReadFile(filepath.Join(workDir, "taken.txt"))
		if err != nil {
			t.Fatalf("failed to read file: %v", err)
		}
		if string(data) != "keep me" {
			t.Errorf("existing file was overwritten: got %q", string(data))
		}
	})

	t.Run("refuses existing path of the other type", func(t *testing.T) {
		workDir := t.TempDir()
		if err := os.Mkdir(filepath.Join(workDir, "src"), 0755); err != nil {
			t.Fatalf("failed to create existing directory: %v", err)
		}

		if err := Create(workDir, "src", false); !errors.Is(err, ErrExists) {
			t.Fatalf("got error %v, want ErrExists", err)
		}
	})

	t.Run("refuses a name held by a symlink", func(t *testing.T) {
		workDir := t.TempDir()
		outside := filepath.Join(t.TempDir(), "target.txt")
		symlinktest.Make(t, outside, filepath.Join(workDir, "link.txt"))

		if err := Create(workDir, "link.txt", false); !errors.Is(err, ErrExists) {
			t.Fatalf("got error %v, want ErrExists", err)
		}
		if _, err := os.Stat(outside); !os.IsNotExist(err) {
			t.Error("created through the symlink, outside the work directory")
		}
	})

	t.Run("rejects invalid paths", func(t *testing.T) {
		workDir := t.TempDir()

		for _, path := range []string{"", "../escape.txt", "/etc/passwd"} {
			if err := Create(workDir, path, false); !errors.Is(err, ErrInvalidPath) {
				t.Errorf("path %q: got error %v, want ErrInvalidPath", path, err)
			}
		}
	})
}

func TestRename(t *testing.T) {
	t.Run("renames a file in place", func(t *testing.T) {
		workDir := t.TempDir()
		if err := os.WriteFile(filepath.Join(workDir, "draft.md"), []byte("hello"), 0644); err != nil {
			t.Fatalf("failed to create file: %v", err)
		}

		if err := Rename(workDir, "draft.md", "final.md"); err != nil {
			t.Fatalf("Rename failed: %v", err)
		}

		data, err := os.ReadFile(filepath.Join(workDir, "final.md"))
		if err != nil {
			t.Fatalf("failed to read renamed file: %v", err)
		}
		if string(data) != "hello" {
			t.Errorf("got content %q, want %q", string(data), "hello")
		}
		if _, err := os.Lstat(filepath.Join(workDir, "draft.md")); !os.IsNotExist(err) {
			t.Error("the old name still exists")
		}
	})

	// The file must stay the same file: a write-then-delete imitation would
	// reset the mode, break hard links and swap the inode out from under
	// anything holding the file open.
	t.Run("keeps the file's identity", func(t *testing.T) {
		workDir := t.TempDir()
		original := filepath.Join(workDir, "run.sh")
		if err := os.WriteFile(original, []byte("#!/bin/sh\n"), 0755); err != nil {
			t.Fatalf("failed to create file: %v", err)
		}
		// A second name for the file, taken before the rename and read after
		// it, is what identity is compared against. The old path cannot answer
		// it: on Windows os.SameFile fetches the file id by reopening the path,
		// which the rename has taken away. Holding the file open instead would
		// ask the wrong question entirely — Windows refuses to rename a file
		// another handle has open, and Rename reports that rather than waiting
		// it out.
		link := filepath.Join(workDir, "same-file")
		if err := os.Link(original, link); err != nil {
			t.Skipf("filesystem cannot hold a second name for the file: %v", err)
		}
		before, err := os.Stat(original)
		if err != nil {
			t.Fatalf("failed to stat file: %v", err)
		}

		if err := Rename(workDir, "run.sh", "start.sh"); err != nil {
			t.Fatalf("Rename failed: %v", err)
		}

		after, err := os.Stat(filepath.Join(workDir, "start.sh"))
		if err != nil {
			t.Fatalf("failed to stat renamed file: %v", err)
		}
		linked, err := os.Stat(link)
		if err != nil {
			t.Fatalf("failed to stat the file's other name: %v", err)
		}
		if !os.SameFile(linked, after) {
			t.Error("renamed file is a different file")
		}
		if runtime.GOOS != "windows" && after.Mode() != before.Mode() {
			t.Errorf("got mode %v, want %v", after.Mode(), before.Mode())
		}
	})

	t.Run("renames a directory with its contents", func(t *testing.T) {
		workDir := t.TempDir()
		if err := os.MkdirAll(filepath.Join(workDir, "old/nested"), 0755); err != nil {
			t.Fatalf("failed to create directory: %v", err)
		}
		if err := os.WriteFile(filepath.Join(workDir, "old/nested/file.txt"), []byte("kept"), 0644); err != nil {
			t.Fatalf("failed to create file: %v", err)
		}

		if err := Rename(workDir, "old", "new"); err != nil {
			t.Fatalf("Rename failed: %v", err)
		}

		data, err := os.ReadFile(filepath.Join(workDir, "new/nested/file.txt"))
		if err != nil {
			t.Fatalf("failed to read moved file: %v", err)
		}
		if string(data) != "kept" {
			t.Errorf("got content %q, want %q", string(data), "kept")
		}
	})

	t.Run("stays in the entry's own directory", func(t *testing.T) {
		workDir := t.TempDir()
		if err := os.MkdirAll(filepath.Join(workDir, "docs/api"), 0755); err != nil {
			t.Fatalf("failed to create directory: %v", err)
		}
		if err := os.WriteFile(filepath.Join(workDir, "docs/api/v1.md"), []byte("spec"), 0644); err != nil {
			t.Fatalf("failed to create file: %v", err)
		}

		if err := Rename(workDir, "docs/api/v1.md", "v2.md"); err != nil {
			t.Fatalf("Rename failed: %v", err)
		}

		if _, err := os.Stat(filepath.Join(workDir, "docs/api/v2.md")); err != nil {
			t.Fatalf("failed to stat renamed file: %v", err)
		}
	})

	// The destination is derived from the source's parent on disk, not from
	// rebuilding the relative path, so no spelling of the path can turn a
	// rename into a move. On Windows the backslash form is a real one a client
	// could send; elsewhere these are just the shapes filepath.Join accepts.
	t.Run("stays put however the path is spelled", func(t *testing.T) {
		workDir := t.TempDir()
		if err := os.MkdirAll(filepath.Join(workDir, "docs/api"), 0755); err != nil {
			t.Fatalf("failed to create directory: %v", err)
		}

		spellings := []string{"docs/./api", "docs/api/"}
		if runtime.GOOS == "windows" {
			spellings = append(spellings, `docs\api`)
		}

		for i, spelling := range spellings {
			name := fmt.Sprintf("v%d", i)
			if err := Rename(workDir, spelling, name); err != nil {
				t.Fatalf("path %q: Rename failed: %v", spelling, err)
			}
			if _, err := os.Stat(filepath.Join(workDir, "docs", name)); err != nil {
				t.Errorf("path %q: entry left its directory: %v", spelling, err)
			}
			// Rename it back, so each spelling starts from the same state.
			if err := Rename(workDir, "docs/"+name, "api"); err != nil {
				t.Fatalf("path %q: failed to restore: %v", spelling, err)
			}
		}
	})

	// POSIX rename(2) would silently replace the destination, so this is the
	// method's own guard rather than something the syscall does for it.
	t.Run("refuses a taken name without touching either entry", func(t *testing.T) {
		workDir := t.TempDir()
		if err := os.MkdirAll(filepath.Join(workDir, "docs"), 0755); err != nil {
			t.Fatalf("failed to create directory: %v", err)
		}
		if err := os.WriteFile(filepath.Join(workDir, "docs/a.md"), []byte("source"), 0644); err != nil {
			t.Fatalf("failed to create file: %v", err)
		}
		if err := os.WriteFile(filepath.Join(workDir, "docs/b.md"), []byte("keep me"), 0644); err != nil {
			t.Fatalf("failed to create file: %v", err)
		}

		err := Rename(workDir, "docs/a.md", "b.md")
		if !errors.Is(err, ErrExists) {
			t.Fatalf("got error %v, want ErrExists", err)
		}
		// The web UI keys its "the name is taken" handling off this wording,
		// and off file.create producing the same sentence.
		if err.Error() != "docs/b.md already exists" {
			t.Errorf("got message %q, want %q", err.Error(), "docs/b.md already exists")
		}

		data, err := os.ReadFile(filepath.Join(workDir, "docs/b.md"))
		if err != nil {
			t.Fatalf("failed to read destination: %v", err)
		}
		if string(data) != "keep me" {
			t.Errorf("destination was overwritten: got %q", string(data))
		}
		if _, err := os.Stat(filepath.Join(workDir, "docs/a.md")); err != nil {
			t.Errorf("source was moved away: %v", err)
		}
	})

	t.Run("renames a symlink rather than its target, and will not replace one", func(t *testing.T) {
		workDir := t.TempDir()
		outside := filepath.Join(t.TempDir(), "target.txt")
		if err := os.WriteFile(outside, []byte("outside"), 0644); err != nil {
			t.Fatalf("failed to create target: %v", err)
		}
		symlinktest.Make(t, outside, filepath.Join(workDir, "link.txt"))
		// Dangling on purpose: a Stat-based existence check would call this
		// name free and let rename(2) unlink the user's symlink.
		symlinktest.Make(t, filepath.Join(workDir, "gone.txt"), filepath.Join(workDir, "dangling.txt"))

		if err := Rename(workDir, "link.txt", "dangling.txt"); !errors.Is(err, ErrExists) {
			t.Fatalf("got error %v, want ErrExists", err)
		}

		if err := Rename(workDir, "link.txt", "renamed.txt"); err != nil {
			t.Fatalf("Rename failed: %v", err)
		}
		if _, err := os.Lstat(filepath.Join(workDir, "renamed.txt")); err != nil {
			t.Fatalf("failed to lstat renamed symlink: %v", err)
		}
		if _, err := os.Stat(outside); err != nil {
			t.Errorf("the symlink's target was touched: %v", err)
		}
	})

	// A rename that only changes capitalisation is the one case where the
	// destination can be the source seen through a case-insensitive
	// filesystem's folding. It must go through: deleting and recreating a file
	// is otherwise the only way to fix its capitalisation on macOS or Windows.
	//
	// On a case-sensitive filesystem the new name is simply free, so this
	// asserts the outcome both kinds must produce rather than which branch
	// produced it. The folding branch itself cannot be exercised here; see
	// "refuses a hard link's name" for the discrimination it rests on.
	t.Run("changes only the capitalisation of a name", func(t *testing.T) {
		workDir := t.TempDir()
		if err := os.WriteFile(filepath.Join(workDir, "readme.md"), []byte("body"), 0644); err != nil {
			t.Fatalf("failed to create file: %v", err)
		}

		if err := Rename(workDir, "readme.md", "README.md"); err != nil {
			t.Fatalf("Rename failed: %v", err)
		}

		entries, err := os.ReadDir(workDir)
		if err != nil {
			t.Fatalf("failed to read directory: %v", err)
		}
		if len(entries) != 1 || entries[0].Name() != "README.md" {
			var names []string
			for _, entry := range entries {
				names = append(names, entry.Name())
			}
			t.Errorf("got directory %v, want just README.md", names)
		}
	})

	// os.SameFile is true here too, but for the other reason: two directory
	// entries naming one inode. That name really is taken, and the check in
	// front of os.Rename must not wave it through on sameness alone — which is
	// what keeps the case-folding allowance above from becoming a hole.
	t.Run("refuses a hard link's name", func(t *testing.T) {
		workDir := t.TempDir()
		original := filepath.Join(workDir, "a.txt")
		if err := os.WriteFile(original, []byte("body"), 0644); err != nil {
			t.Fatalf("failed to create file: %v", err)
		}
		if err := os.Link(original, filepath.Join(workDir, "A.txt")); err != nil {
			t.Skipf("filesystem cannot hold both names as hard links: %v", err)
		}

		if err := Rename(workDir, "a.txt", "A.txt"); !errors.Is(err, ErrExists) {
			t.Fatalf("got error %v, want ErrExists", err)
		}

		// Both names still there: refusing is what leaves them alone.
		for _, name := range []string{"a.txt", "A.txt"} {
			if _, err := os.Lstat(filepath.Join(workDir, name)); err != nil {
				t.Errorf("%s is gone: %v", name, err)
			}
		}
	})

	// The requested end state already holds, so there is nothing to report.
	t.Run("accepts the name the entry already has", func(t *testing.T) {
		workDir := t.TempDir()
		if err := os.WriteFile(filepath.Join(workDir, "same.md"), []byte("body"), 0644); err != nil {
			t.Fatalf("failed to create file: %v", err)
		}

		if err := Rename(workDir, "same.md", "same.md"); err != nil {
			t.Fatalf("Rename failed: %v", err)
		}

		data, err := os.ReadFile(filepath.Join(workDir, "same.md"))
		if err != nil {
			t.Fatalf("failed to read file: %v", err)
		}
		if string(data) != "body" {
			t.Errorf("got content %q, want %q", string(data), "body")
		}
	})

	t.Run("reports a missing source", func(t *testing.T) {
		workDir := t.TempDir()

		if err := Rename(workDir, "ghost.md", "real.md"); !errors.Is(err, ErrNotFound) {
			t.Fatalf("got error %v, want ErrNotFound", err)
		}
	})

	// A name is a name, not a path: accepting a separator would turn this into
	// a move, which is deliberately out of scope.
	t.Run("rejects names that are not a single entry name", func(t *testing.T) {
		workDir := t.TempDir()
		if err := os.WriteFile(filepath.Join(workDir, "file.md"), []byte("body"), 0644); err != nil {
			t.Fatalf("failed to create file: %v", err)
		}
		if err := os.Mkdir(filepath.Join(workDir, "sub"), 0755); err != nil {
			t.Fatalf("failed to create directory: %v", err)
		}

		for _, name := range []string{"", ".", "..", "sub/file.md", "../escape.md", "/etc/passwd"} {
			if err := Rename(workDir, "file.md", name); !errors.Is(err, ErrInvalidPath) {
				t.Errorf("name %q: got error %v, want ErrInvalidPath", name, err)
			}
		}

		if _, err := os.Stat(filepath.Join(workDir, "file.md")); err != nil {
			t.Errorf("source was moved away: %v", err)
		}
	})

	t.Run("rejects invalid paths", func(t *testing.T) {
		workDir := t.TempDir()

		for _, path := range []string{"", "../escape.txt", "/etc/passwd"} {
			if err := Rename(workDir, path, "renamed.txt"); !errors.Is(err, ErrInvalidPath) {
				t.Errorf("path %q: got error %v, want ErrInvalidPath", path, err)
			}
		}
	})
}
