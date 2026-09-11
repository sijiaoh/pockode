package git

import (
	"bytes"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pockode/server/contents"
)

func TestShowFile_TextAtOldCommit(t *testing.T) {
	dir, cleanup := setupTestRepo(t)
	defer cleanup()

	writeTestFile(t, dir, "dir/file.txt", "old\n")
	runGit(t, dir, "add", ".")
	runGit(t, dir, "commit", "--no-gpg-sign", "-m", "first")
	first := gitHead(t, dir)

	writeTestFile(t, dir, "dir/file.txt", "new\n")
	runGit(t, dir, "add", ".")
	runGit(t, dir, "commit", "--no-gpg-sign", "-m", "second")

	file, err := ShowFile(dir, first, "dir/file.txt")
	if err != nil {
		t.Fatalf("ShowFile() error: %v", err)
	}
	if file.Content != "old\n" {
		t.Errorf("Content = %q, want the version from the first commit", file.Content)
	}
	if file.Encoding != contents.EncodingText {
		t.Errorf("Encoding = %q, want text", file.Encoding)
	}
	if file.Name != "file.txt" || file.Path != "dir/file.txt" {
		t.Errorf("Name/Path = %q/%q, want file.txt/dir/file.txt", file.Name, file.Path)
	}
	if file.Size != 4 {
		t.Errorf("Size = %d, want 4", file.Size)
	}
}

func TestShowFile_DeletedFileStillReadableAtItsCommit(t *testing.T) {
	dir, cleanup := setupTestRepo(t)
	defer cleanup()

	writeTestFile(t, dir, "gone.txt", "here\n")
	runGit(t, dir, "add", ".")
	runGit(t, dir, "commit", "--no-gpg-sign", "-m", "add")
	added := gitHead(t, dir)

	runGit(t, dir, "rm", "gone.txt")
	runGit(t, dir, "commit", "--no-gpg-sign", "-m", "remove")
	removed := gitHead(t, dir)

	file, err := ShowFile(dir, added, "gone.txt")
	if err != nil {
		t.Fatalf("ShowFile() error: %v", err)
	}
	if file.Content != "here\n" {
		t.Errorf("Content = %q, want here\\n", file.Content)
	}

	if _, err := ShowFile(dir, removed, "gone.txt"); !errors.Is(err, contents.ErrNotFound) {
		t.Errorf("ShowFile() on the commit that deleted it = %v, want ErrNotFound", err)
	}
}

func TestShowFile_EmptyFile(t *testing.T) {
	dir, cleanup := setupTestRepo(t)
	defer cleanup()

	writeTestFile(t, dir, "empty.txt", "")
	runGit(t, dir, "add", ".")
	runGit(t, dir, "commit", "--no-gpg-sign", "-m", "initial")

	file, err := ShowFile(dir, gitHead(t, dir), "empty.txt")
	if err != nil {
		t.Fatalf("ShowFile() error: %v", err)
	}
	if file.Encoding != contents.EncodingText || file.Content != "" || file.Size != 0 {
		t.Errorf("empty.txt = %+v, want empty text content", file)
	}
}

func TestShowFile_UnknownCommitSaysSo(t *testing.T) {
	dir, cleanup := setupTestRepoWithCommit(t)
	defer cleanup()

	// Well-formed but absent. The error still has to carry git's own reason, or
	// a missing commit is indistinguishable from a missing path.
	_, err := ShowFile(dir, "0123456789abcdef0123456789abcdef01234567", "file.txt")
	if !errors.Is(err, contents.ErrNotFound) {
		t.Fatalf("ShowFile() = %v, want ErrNotFound", err)
	}
	if !strings.Contains(err.Error(), "0123456789abcdef0123456789abcdef01234567") {
		t.Errorf("error %q does not name the commit", err)
	}
	if !strings.Contains(err.Error(), "fatal:") {
		t.Errorf("error %q dropped git's own explanation", err)
	}
}

func TestShowFile_Directory(t *testing.T) {
	dir, cleanup := setupTestRepo(t)
	defer cleanup()

	writeTestFile(t, dir, "sub/file.txt", "content\n")
	runGit(t, dir, "add", ".")
	runGit(t, dir, "commit", "--no-gpg-sign", "-m", "initial")

	_, err := ShowFile(dir, gitHead(t, dir), "sub")
	if !errors.Is(err, contents.ErrInvalidPath) {
		t.Errorf("ShowFile() on a directory = %v, want ErrInvalidPath", err)
	}
}

func TestShowFile_Binary(t *testing.T) {
	dir, cleanup := setupTestRepo(t)
	defer cleanup()

	// A PNG header, so the MIME type is an image and the content comes back
	// base64-encoded rather than omitted.
	png := append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte{0x00, 0x01}, 64)...)
	writeTestBinaryFile(t, dir, "image.png", png)
	// A blob that is binary but not renderable, which is omitted instead.
	writeTestBinaryFile(t, dir, "blob.bin", bytes.Repeat([]byte{0x00, 0xff}, 64))
	runGit(t, dir, "add", ".")
	runGit(t, dir, "commit", "--no-gpg-sign", "-m", "initial")
	hash := gitHead(t, dir)

	image, err := ShowFile(dir, hash, "image.png")
	if err != nil {
		t.Fatalf("ShowFile() error: %v", err)
	}
	if image.Encoding != contents.EncodingBase64 {
		t.Fatalf("Encoding = %q, want base64", image.Encoding)
	}
	decoded, err := base64.StdEncoding.DecodeString(image.Content)
	if err != nil {
		t.Fatalf("Content is not base64: %v", err)
	}
	if !bytes.Equal(decoded, png) {
		t.Error("decoded content does not match the committed bytes")
	}

	blob, err := ShowFile(dir, hash, "blob.bin")
	if err != nil {
		t.Fatalf("ShowFile() error: %v", err)
	}
	if blob.Encoding != contents.EncodingNone || blob.Omitted != contents.OmitBinary {
		t.Errorf("blob.bin = %q/%q, want none/binary", blob.Encoding, blob.Omitted)
	}
	if blob.Content != "" {
		t.Error("omitted content should be empty")
	}
}

func TestShowFile_TooLarge(t *testing.T) {
	dir, cleanup := setupTestRepo(t)
	defer cleanup()

	size := int64(contents.MaxFileSize + 1)
	writeTestFile(t, dir, "big.txt", strings.Repeat("a", int(size)))
	runGit(t, dir, "add", ".")
	runGit(t, dir, "commit", "--no-gpg-sign", "-m", "initial")

	file, err := ShowFile(dir, gitHead(t, dir), "big.txt")
	if err != nil {
		t.Fatalf("ShowFile() error: %v", err)
	}
	if file.Encoding != contents.EncodingNone || file.Omitted != contents.OmitTooLarge {
		t.Errorf("big.txt = %q/%q, want none/too_large", file.Encoding, file.Omitted)
	}
	if file.Size != size {
		t.Errorf("Size = %d, want %d", file.Size, size)
	}
	if file.Limit != contents.MaxFileSize {
		t.Errorf("Limit = %d, want %d", file.Limit, contents.MaxFileSize)
	}
	if file.Content != "" {
		t.Error("content over the limit should not be sent")
	}
	// The head still has to be read, or the client cannot be told what it is.
	if !strings.HasPrefix(file.MIME, "text/plain") {
		t.Errorf("MIME = %q, want text/plain", file.MIME)
	}
}

func TestShowFile_RejectsBadInput(t *testing.T) {
	dir, cleanup := setupTestRepoWithCommit(t)
	defer cleanup()

	hash := gitHead(t, dir)

	tests := []struct {
		name string
		hash string
		path string
	}{
		{"path traversal", hash, "../outside.txt"},
		{"absolute path", hash, "/etc/passwd"},
		{"empty path", hash, ""},
		{"non-hex hash", "not-a-hash", "file.txt"},
		{"empty hash", "", "file.txt"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := ShowFile(dir, tt.hash, tt.path); err == nil {
				t.Fatal("ShowFile() succeeded, want an error")
			}
		})
	}
}

func writeTestBinaryFile(t *testing.T, dir, path string, content []byte) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, path), content, 0644); err != nil {
		t.Fatalf("failed to write %q: %v", path, err)
	}
}
