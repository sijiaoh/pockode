package contents

import (
	"bytes"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

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

	t.Run("returns images as base64 with their real mime", func(t *testing.T) {
		workDir := t.TempDir()
		content := append(append([]byte{}, pngHeader...), []byte("pixels\x00\x01")...)
		writeTestFile(t, workDir, "logo.png", content)

		file := getFile(t, workDir, "logo.png")

		if file.Encoding != EncodingBase64 {
			t.Errorf("got encoding %q, want %q", file.Encoding, EncodingBase64)
		}
		if file.MIME != "image/png" {
			t.Errorf("got mime %q, want image/png", file.MIME)
		}
		if file.Content != base64.StdEncoding.EncodeToString(content) {
			t.Error("content is not the base64 of the file")
		}
	})

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
