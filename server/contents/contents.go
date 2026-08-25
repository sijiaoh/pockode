// Package contents provides file system browsing and reading.
package contents

import (
	"bytes"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"
)

var (
	ErrNotFound    = errors.New("not found")
	ErrInvalidPath = errors.New("invalid path")
)

// ValidatePath checks if path is safe and within workDir.
// Returns ErrInvalidPath for path traversal attempts or absolute paths.
func ValidatePath(workDir, path string) error {
	if path == "" {
		return nil
	}

	cleanPath := filepath.Clean(path)
	if strings.HasPrefix(cleanPath, "..") || filepath.IsAbs(cleanPath) {
		return fmt.Errorf("%w: %s", ErrInvalidPath, path)
	}

	fullPath := filepath.Join(workDir, cleanPath)
	if !strings.HasPrefix(fullPath, workDir+string(filepath.Separator)) {
		return fmt.Errorf("%w: %s", ErrInvalidPath, path)
	}

	return nil
}

type EntryType string

const (
	TypeFile EntryType = "file"
	TypeDir  EntryType = "dir"
)

const (
	// MaxFileSize is the ceiling on the content a single file.get may carry.
	// Above it the file is described but never read: the whole file is held in
	// memory, base64 inflates it by 4/3, and the JSON response leaves as one
	// WebSocket message. Over a relay tunnel that write holds the shared
	// connection lock until it finishes, so a few megabytes stall every other
	// stream and can outlast the keepalive — the ceiling is about the transport
	// as much as about memory.
	MaxFileSize = 2 << 20 // 2 MiB

	// http.DetectContentType inspects no more than this many bytes.
	sniffLen = 512
)

type Encoding string

const (
	EncodingText   Encoding = "text"
	EncodingBase64 Encoding = "base64"
	// EncodingNone means no content was sent; Omitted says why.
	EncodingNone Encoding = "none"
)

// OmitReason explains an EncodingNone response, so the client can tell "too big
// to show" apart from "nothing to show".
type OmitReason string

const (
	OmitTooLarge OmitReason = "too_large"
	OmitBinary   OmitReason = "binary"
)

type Entry struct {
	Name string    `json:"name"`
	Type EntryType `json:"type"`
	Path string    `json:"path"`
}

type FileContent struct {
	Name string    `json:"name"`
	Type EntryType `json:"type"`
	Path string    `json:"path"`
	Size int64     `json:"size"`
	// MIME is detected from the file's own bytes, not guessed from its
	// extension, and is always set — including when Content is omitted.
	MIME     string     `json:"mime"`
	Content  string     `json:"content"`
	Encoding Encoding   `json:"encoding"`
	Omitted  OmitReason `json:"omitted,omitempty"`
	// Limit is the size ceiling that kept Content out, sent only with
	// OmitTooLarge. It travels with the response so the UI can name the
	// threshold without keeping a second copy of MaxFileSize.
	Limit int64 `json:"limit,omitempty"`
}

// ContentsResult holds the result of GetContents.
// Either Entries (for directories) or File (for files) is set, never both.
type ContentsResult struct {
	Entries []Entry      // Directory listing (nil if file)
	File    *FileContent // File content (nil if directory)
}

// IsDir returns true if the result is a directory listing.
func (r ContentsResult) IsDir() bool {
	return r.File == nil
}

// GetContents returns directory entries or file content.
// Returns ErrNotFound if path doesn't exist, ErrInvalidPath for path traversal
// attempts and for paths that are neither a directory nor a regular file.
func GetContents(workDir, path string) (ContentsResult, error) {
	if err := ValidatePath(workDir, path); err != nil {
		return ContentsResult{}, err
	}

	fullPath := filepath.Join(workDir, path)
	info, err := os.Stat(fullPath)
	if err != nil {
		if os.IsNotExist(err) {
			return ContentsResult{}, fmt.Errorf("%w: %s", ErrNotFound, path)
		}
		return ContentsResult{}, fmt.Errorf("failed to stat path: %w", err)
	}

	if info.IsDir() {
		entries, err := listDir(path, fullPath)
		if err != nil {
			return ContentsResult{}, err
		}
		return ContentsResult{Entries: entries}, nil
	}

	// Named pipes and device nodes are checked before opening, not after:
	// opening a fifo blocks until someone writes to it, which would hang the
	// request forever. Search refuses them for the same reason.
	if !info.Mode().IsRegular() {
		return ContentsResult{}, fmt.Errorf("%w: %s is not a regular file", ErrInvalidPath, path)
	}

	file, err := readFile(path, fullPath)
	if err != nil {
		return ContentsResult{}, err
	}
	return ContentsResult{File: file}, nil
}

func listDir(relPath, fullPath string) ([]Entry, error) {
	dirEntries, err := os.ReadDir(fullPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read directory: %w", err)
	}

	entries := make([]Entry, 0, len(dirEntries))
	for _, de := range dirEntries {
		entryPath := de.Name()
		if relPath != "" {
			entryPath = relPath + "/" + de.Name()
		}
		entry := Entry{
			Name: de.Name(),
			Path: entryPath,
		}

		if de.IsDir() {
			entry.Type = TypeDir
		} else {
			entry.Type = TypeFile
		}

		entries = append(entries, entry)
	}

	sort.Slice(entries, func(i, j int) bool {
		if entries[i].Type != entries[j].Type {
			return entries[i].Type == TypeDir
		}
		return entries[i].Name < entries[j].Name
	})

	return entries, nil
}

// readFile describes a file, and reads it only when its content is something
// the client can use: text, or an image small enough to send. Anything else
// comes back as metadata alone — a client that cannot render a binary blob has
// no use for the megabytes it would cost to ship one.
func readFile(relPath, fullPath string) (*FileContent, error) {
	f, err := os.Open(fullPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read file: %w", err)
	}
	defer f.Close()

	// Stat the descriptor, not the path: an agent rewriting the file between
	// the caller's stat and this read would otherwise have the reported size
	// describe a different file than the content beside it.
	info, err := f.Stat()
	if err != nil {
		return nil, fmt.Errorf("failed to stat file: %w", err)
	}

	file := &FileContent{
		Name: info.Name(),
		Type: TypeFile,
		Path: relPath,
		Size: info.Size(),
	}

	if info.Size() > MaxFileSize {
		head := make([]byte, sniffLen)
		n, err := io.ReadFull(f, head)
		if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
			return nil, fmt.Errorf("failed to read file: %w", err)
		}
		file.MIME = detectMIME(info.Name(), head[:n])
		file.Encoding = EncodingNone
		file.Omitted = OmitTooLarge
		file.Limit = MaxFileSize
		return file, nil
	}

	// Bounded rather than sized from info: the file may have grown since the
	// stat, and memory use must not depend on that race.
	content, err := io.ReadAll(io.LimitReader(f, MaxFileSize+1))
	if err != nil {
		return nil, fmt.Errorf("failed to read file: %w", err)
	}
	file.MIME = detectMIME(info.Name(), content)

	switch {
	case int64(len(content)) > MaxFileSize:
		// The file outgrew the limit while it was being read, so the size taken
		// before the read would contradict the verdict sitting next to it.
		if grown, err := f.Stat(); err == nil {
			file.Size = grown.Size()
		}
		file.Encoding = EncodingNone
		file.Omitted = OmitTooLarge
		file.Limit = MaxFileSize
	case !IsBinary(content):
		file.Encoding = EncodingText
		file.Content = string(content)
	case strings.HasPrefix(file.MIME, "image/"):
		file.Encoding = EncodingBase64
		file.Content = base64.StdEncoding.EncodeToString(content)
	default:
		file.Encoding = EncodingNone
		file.Omitted = OmitBinary
	}

	return file, nil
}

// Image formats http.DetectContentType cannot name: SVG is plain text, and
// AVIF/HEIC/TIFF are missing from Go's signature table. Their extension is the
// only clue, and the UI needs the real type to render them.
var imageExtMIMEs = map[string]string{
	".svg":  "image/svg+xml",
	".avif": "image/avif",
	".heic": "image/heic",
	".heif": "image/heif",
	".tif":  "image/tiff",
	".tiff": "image/tiff",
}

// detectMIME reports the media type of a file whose leading bytes are head.
// Content wins over extension — a file is what it contains — and the extension
// is consulted only where sniffing gave up, so a .svg holding a PNG is still
// reported as a PNG.
func detectMIME(name string, head []byte) string {
	sniffed := http.DetectContentType(head)
	if !isGenericType(sniffed) {
		return sniffed
	}
	if mime, ok := imageExtMIMEs[strings.ToLower(filepath.Ext(name))]; ok {
		return mime
	}
	return sniffed
}

// isGenericType reports whether http.DetectContentType matched no signature and
// fell back to classifying the bytes as merely textual or merely binary.
func isGenericType(mime string) bool {
	return mime == "application/octet-stream" ||
		strings.HasPrefix(mime, "text/plain") ||
		strings.HasPrefix(mime, "text/xml")
}

// IsBinary reports whether the whole content of a file can be delivered as
// text. Content sniffing rejects the formats it knows and any byte soup that
// could not be text; UTF-8 validation then rejects what sniffing let through,
// since JSON encoding substitutes U+FFFD for every invalid byte — which both
// corrupts the content and inflates it threefold.
//
// Text in a legacy encoding (GBK, Shift-JIS, Latin-1) is therefore reported as
// binary. Delivering it would mean handing the client mojibake it has no way to
// recognise as such; refusing it at least says so.
func IsBinary(data []byte) bool {
	return isBinary(data, false)
}

// IsBinaryProbe answers the same question from the head of a file instead of
// all of it, for callers that would rather not read the whole thing to ask.
//
// A multi-byte character cut off by the end of the window is not held against
// the file — otherwise every file whose head happened to end mid-character
// would be called binary. The cost of that leniency is that invalid bytes past
// the window go unnoticed, which is why it is not what IsBinary does.
func IsBinaryProbe(head []byte) bool {
	return isBinary(head, true)
}

func isBinary(data []byte, truncated bool) bool {
	if !strings.HasPrefix(http.DetectContentType(data), "text/") {
		return true
	}
	// NUL is valid UTF-8 and never appears in text, and sniffing only saw the
	// first sniffLen bytes.
	if bytes.IndexByte(data, 0) >= 0 {
		return true
	}
	if truncated {
		data = trimIncompleteRune(data)
	}
	return !utf8.Valid(data)
}

// trimIncompleteRune drops a trailing UTF-8 sequence that has no room left to
// finish, so a valid file whose multi-byte character straddles the end of a
// probe window is not mistaken for binary. Only IsBinaryProbe wants this: given
// a whole file there is no window to straddle, and a trailing invalid byte is
// simply invalid.
func trimIncompleteRune(data []byte) []byte {
	if r, size := utf8.DecodeLastRune(data); r != utf8.RuneError || size > 1 {
		return data
	}
	for i := len(data) - 1; i >= 0 && len(data)-i <= utf8.UTFMax; i-- {
		if utf8.RuneStart(data[i]) {
			return data[:i]
		}
	}
	return data
}

// WriteFile writes content to a file within workDir.
// Creates the file and parent directories if they don't exist.
// Returns ErrInvalidPath for path traversal attempts, absolute paths, or empty paths.
func WriteFile(workDir, path, content string) error {
	if path == "" {
		return fmt.Errorf("%w: empty path", ErrInvalidPath)
	}

	if err := ValidatePath(workDir, path); err != nil {
		return err
	}

	fullPath := filepath.Join(workDir, path)

	dir := filepath.Dir(fullPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("failed to create parent directories: %w", err)
	}

	// Deliberately a plain write, not filestore.WriteFileAtomic: these are files
	// in the user's own project. Replacing one by rename would break hard links,
	// reset an executable script back to 0644, swap the inode out from under
	// anything watching it, and litter the working tree with .tmp/.lock files
	// that show up in git status. In-place writing keeps the file the user's.
	return os.WriteFile(fullPath, []byte(content), 0644)
}

// Delete removes a file or directory within workDir.
// For directories, it recursively removes all contents.
// Returns ErrInvalidPath for path traversal attempts, absolute paths, or empty paths.
// Returns ErrNotFound if the path doesn't exist.
func Delete(workDir, path string) error {
	if path == "" {
		return fmt.Errorf("%w: empty path", ErrInvalidPath)
	}

	if err := ValidatePath(workDir, path); err != nil {
		return err
	}

	fullPath := filepath.Join(workDir, path)

	if _, err := os.Stat(fullPath); err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("%w: %s", ErrNotFound, path)
		}
		return fmt.Errorf("failed to stat path: %w", err)
	}

	return os.RemoveAll(fullPath)
}

// DeleteFile deletes a file within workDir.
// Deprecated: Use Delete instead, which handles both files and directories.
func DeleteFile(workDir, path string) error {
	return Delete(workDir, path)
}
