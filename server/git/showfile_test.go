package git

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pockode/server/attachments"
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

	// A PNG header, so the MIME type is an image, described for fetching over
	// HTTP rather than omitted. Under the size ceiling, so ShowFile reads only
	// the head and stops git partway; and well past a pipe buffer, so git
	// really is stopped rather than finishing before the pipe closes.
	png := append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte{0x00, 0x01}, 512<<10)...)
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
	if image.Encoding != contents.EncodingHTTP || image.Content != "" {
		t.Fatalf("Encoding = %q with %d bytes of content, want http and none", image.Encoding, len(image.Content))
	}
	if image.MIME != "image/png" || image.Size != int64(len(png)) {
		t.Errorf("MIME/Size = %q/%d, want image/png/%d", image.MIME, image.Size, len(png))
	}

	// What the client then fetches.
	stream, err := OpenFile(context.Background(), dir, hash, "image.png")
	if err != nil {
		t.Fatalf("OpenFile() error: %v", err)
	}
	streamed, err := io.ReadAll(stream)
	if err != nil {
		t.Fatalf("read blob: %v", err)
	}
	if err := stream.Close(); err != nil {
		t.Errorf("Close() error: %v", err)
	}
	if stream.Size != int64(len(png)) || !bytes.Equal(streamed, png) {
		t.Error("streamed content does not match the committed bytes")
	}

	// A client that goes away mid-image is not a git failure, so closing early
	// must not report one.
	partial, err := OpenFile(context.Background(), dir, hash, "image.png")
	if err != nil {
		t.Fatalf("OpenFile() error: %v", err)
	}
	if _, err := io.ReadFull(partial, make([]byte, 16)); err != nil {
		t.Fatalf("read blob head: %v", err)
	}
	if err := partial.Close(); err != nil {
		t.Errorf("Close() after a partial read = %v, want nil", err)
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

// A raster image is held to the attachment ceiling, not MaxFileSize; past it
// it is reported like any other content too large to show. OpenFile still
// serves it, since the ceiling is the preview's, not the download's.
func TestShowFile_ImageOverAttachmentLimit(t *testing.T) {
	dir, cleanup := setupTestRepo(t)
	defer cleanup()

	size := int64(attachments.MaxSize + 1)
	png := make([]byte, size)
	copy(png, "\x89PNG\r\n\x1a\n")
	writeTestBinaryFile(t, dir, "huge.png", png)
	runGit(t, dir, "add", ".")
	runGit(t, dir, "commit", "--no-gpg-sign", "-m", "initial")
	hash := gitHead(t, dir)

	file, err := ShowFile(dir, hash, "huge.png")
	if err != nil {
		t.Fatalf("ShowFile() error: %v", err)
	}
	if file.Encoding != contents.EncodingNone || file.Omitted != contents.OmitTooLarge {
		t.Errorf("huge.png = %q/%q, want none/too_large", file.Encoding, file.Omitted)
	}
	if file.Limit != attachments.MaxSize {
		t.Errorf("Limit = %d, want %d", file.Limit, attachments.MaxSize)
	}
	if file.Size != size || file.MIME != "image/png" {
		t.Errorf("Size/MIME = %d/%q, want %d/image/png", file.Size, file.MIME, size)
	}

	stream, err := OpenFile(context.Background(), dir, hash, "huge.png")
	if err != nil {
		t.Fatalf("OpenFile() error: %v", err)
	}
	defer stream.Close()
	if stream.Size != size {
		t.Errorf("OpenFile Size = %d, want %d", stream.Size, size)
	}
}

// Refused before git runs, and as ErrInvalidArgument — which is what lets
// git.show.file and the commit file endpoint answer it as the client's mistake
// rather than a fault here. OpenFile shares the gate.
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
			if _, err := ShowFile(dir, tt.hash, tt.path); !errors.Is(err, ErrInvalidArgument) {
				t.Errorf("ShowFile() = %v, want ErrInvalidArgument", err)
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
