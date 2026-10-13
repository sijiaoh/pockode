// Package attachments keeps the binary content an agent delivers inside its
// output — the image a tool returned — out of the session history.
//
// Why it exists: an EventRecord is written whole into
// sessions/<id>/history.jsonl and replayed on every history page. One image
// claude hands over is around half a megabyte of base64, so a session with a
// dozen screenshots would carry megabytes of them in every page of scrollback,
// forever. Here the bytes are written once, addressed by their own hash, and
// the record keeps nothing but the id; a client fetches them when it has a
// place to draw them.
//
// The files live under the session's own directory, so they are removed with
// it — session.FileStore.Delete drops that whole directory.
package attachments

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"strings"

	"github.com/pockode/server/filestore"
)

// MaxSize is the ceiling on the files a user sends with one message, counted
// per upload request (POST /api/chat/attachments).
//
// It is sized for what a phone records: a minute of 4K video is a few hundred
// megabytes, a long screen recording at 1080p about as much, a voice note a
// fraction of that. Memory sets no ceiling, since content streams to disk as it
// is hashed (Store.PutStream). What remains is disk and time:
//
//   - The files live in the data directory, out of the user's sight, until the
//     session is deleted — so a mistaken pick of something huge costs space
//     nobody sees. Hence half of filetransfer.MaxUploadSize, which lands in the
//     user's own project where they can see and remove it.
//   - Nothing on the way cuts a long upload off: the server sets no read
//     timeout, and the relay tunnel streams a request body with no size or
//     duration limit of its own (docs/file.md#transfer). At a 10 Mbit/s mobile
//     uplink the full ceiling takes about seven minutes, which is a deliberate
//     act rather than something to refuse.
//
// It is not the ceiling on an image an agent produced or the one on previewing
// an image; that is contents.MaxImageSize, for reasons of its own.
const MaxSize = 512 << 20 // 512 MiB

// ErrDisabled is returned by Put and PutStream on a store with no directory
// behind it.
var ErrDisabled = errors.New("attachment store disabled")

// ErrTooLarge is returned by PutStream for content longer than its limit.
var ErrTooLarge = errors.New("attachment exceeds the size limit")

// ErrIncomplete wraps a failure reading the content PutStream was handed — a
// client that disconnected or a body cut short — so a caller can tell it from a
// failure to write on this side.
var ErrIncomplete = errors.New("attachment content ended early")

// incomingDir is where content is spooled before it has a name. A directory
// rather than a suffix, because Resolve and Clone already pass over
// directories: a half-written file has no id a client could name and is
// never cloned into a fork. A spool a crash left behind is removed with the
// session, like everything else here.
const incomingDir = "incoming"

// Dir is where one session's attachments live. Exported because the read side
// (the RPC that serves them) resolves the same directory from the worktree's
// data dir without holding a Store.
func Dir(dataDir, sessionID string) string {
	return filepath.Join(dataDir, "sessions", sessionID, "attachments")
}

// Store writes one session's attachments.
//
// The zero value is a disabled store, for sessions started without a data
// directory to keep anything in (tests, anonymous sessions). It fails Put
// rather than pretending to store, so the caller reports content it could not
// keep instead of handing out an id that resolves to nothing.
type Store struct {
	dir string
}

func NewStore(dataDir, sessionID string) Store {
	if dataDir == "" || sessionID == "" {
		return Store{}
	}
	return Store{dir: Dir(dataDir, sessionID)}
}

// Put stores data and returns the id it can be read back by.
//
// Content-addressed, so the same image arriving twice — a tool re-reading a
// file, a history replay — costs one file. The write is atomic because the id
// is handed out the instant it returns: a reader that followed it to a
// half-written file would see a corrupt image and have no way to tell that from
// a corrupt original.
//
// ext is kept on the id because the read side types the content by sniffing it
// again, and SVG, AVIF, HEIC and TIFF cannot be named from their bytes by
// anything in the standard library (see contents.DetectMIME). Without it those
// come back as plain text or as an unnamed binary, so an image that was stored
// perfectly well could never be shown. Callers get it from
// contents.ImageExtension, which answers from that table's image half — so an
// id ends in an extension only where the extension is what names an image, and "" is
// right for everything else, including content that arrived with no file name
// at all.
func (s Store) Put(data []byte, ext string) (string, error) {
	if s.dir == "" {
		return "", ErrDisabled
	}

	sum := sha256.Sum256(data)
	id := hex.EncodeToString(sum[:]) + ext
	if existing(filepath.Join(s.dir, id)) {
		return id, nil
	}
	stored, err := s.PutStream(bytes.NewReader(data), ext, int64(len(data)))
	return stored.ID, err
}

// Stored is what PutStream wrote.
type Stored struct {
	ID   string
	Size int64
}

// PutStream stores what r yields, up to limit bytes, as Put stores data.
//
// For content too large to hold in memory: it is written to disk as it is
// read and hashed on the way, and only takes its name once it is whole. So
// whatever stops it — content over limit (ErrTooLarge), r failing
// (ErrIncomplete), the disk — leaves no file behind, and no id is handed out
// for content that did not arrive.
func (s Store) PutStream(r io.Reader, ext string, limit int64) (Stored, error) {
	if s.dir == "" {
		return Stored{}, ErrDisabled
	}

	tmp, sum, size, err := spool(s.dir, r, limit)
	if err != nil {
		return Stored{}, err
	}
	id := hex.EncodeToString(sum) + ext
	if err := place(tmp, filepath.Join(s.dir, id)); err != nil {
		return Stored{}, err
	}
	return Stored{ID: id, Size: size}, nil
}

// spool writes up to limit bytes of r to a new file under dir's incoming
// directory, fsynced, and returns its path with the hash of what it holds. On
// failure the file is already removed.
func spool(dir string, r io.Reader, limit int64) (path string, sum []byte, size int64, err error) {
	incoming := filepath.Join(dir, incomingDir)
	if err := os.MkdirAll(incoming, 0755); err != nil {
		return "", nil, 0, fmt.Errorf("create attachment dir: %w", err)
	}
	f, err := os.CreateTemp(incoming, "*")
	if err != nil {
		return "", nil, 0, fmt.Errorf("create attachment: %w", err)
	}
	defer func() {
		if err != nil {
			f.Close()
			os.Remove(f.Name())
		}
	}()

	hash := sha256.New()
	src := &sourceReader{r: io.LimitReader(r, limit+1)}
	size, err = io.Copy(io.MultiWriter(f, hash), src)
	if src.err != nil {
		return "", nil, 0, fmt.Errorf("%w: %w", ErrIncomplete, src.err)
	}
	if err != nil {
		return "", nil, 0, fmt.Errorf("write attachment: %w", err)
	}
	// One byte past the limit tells "at it" from "over it" without reading the
	// rest of what the source still has.
	if size > limit {
		return "", nil, 0, ErrTooLarge
	}
	// CreateTemp makes the file 0600; stored content is as readable as the
	// rest of the data directory, as it was when written by WriteFileAtomic.
	if err = f.Chmod(0644); err != nil {
		return "", nil, 0, fmt.Errorf("chmod attachment: %w", err)
	}
	// The id is handed out the instant this returns, so the bytes are on disk
	// before anything names them.
	if err = f.Sync(); err != nil {
		return "", nil, 0, fmt.Errorf("fsync attachment: %w", err)
	}
	if err = f.Close(); err != nil {
		return "", nil, 0, fmt.Errorf("close attachment: %w", err)
	}
	return f.Name(), hash.Sum(nil), size, nil
}

// place renames a spooled file to path, its final name. The rename is what
// makes the write atomic: a reader sees the whole file or none.
//
// Content-addressed, so a file already at path holds the same bytes: it is
// kept rather than replaced, which on Windows would fail while anyone has it
// open — a download in progress, the agent reading it. The same goes for one
// that appears between the check and the rename, from an identical upload
// racing this one.
func place(tmp, path string) error {
	if existing(path) {
		os.Remove(tmp)
		return nil
	}
	err := filestore.Rename(tmp, path)
	if err == nil {
		return nil
	}
	os.Remove(tmp)
	if existing(path) {
		return nil
	}
	return fmt.Errorf("store attachment: %w", err)
}

func existing(path string) bool {
	info, err := os.Lstat(path)
	return err == nil && info.Mode().IsRegular()
}

// sourceReader keeps the error its reader returned, which io.Copy reports
// exactly as it does a failed write.
type sourceReader struct {
	r   io.Reader
	err error
}

func (s *sourceReader) Read(p []byte) (int, error) {
	n, err := s.r.Read(p)
	if err != nil && err != io.EOF {
		s.err = err
	}
	return n, err
}

// Clone gives dst its own copy of every attachment src has.
//
// Forking a session copies its history records verbatim into a new session
// directory, and those records name attachments by id alone — so without this
// the fork's images would all resolve into the source's directory, and vanish
// the day that session is deleted.
//
// Hard links, not copies: the content is immutable and addressed by its own
// hash, so two names for one file is exactly right. The bytes then outlive
// whichever session is deleted first and are freed when the last one goes,
// which is the property a copy would buy at the price of the bytes themselves.
// A filesystem that refuses the link falls back to a copy.
func Clone(dataDir, srcSessionID, dstSessionID string) error {
	srcDir := Dir(dataDir, srcSessionID)
	entries, err := os.ReadDir(srcDir)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read attachment dir: %w", err)
	}

	dstDir := Dir(dataDir, dstSessionID)
	for _, entry := range entries {
		// The lock filestore's atomic write left behind (before PutStream) belongs
		// to the write, not to the content; the incoming directory is a
		// directory.
		if entry.IsDir() || filepath.Ext(entry.Name()) == ".lock" {
			continue
		}
		if err := os.MkdirAll(dstDir, 0755); err != nil {
			return fmt.Errorf("create attachment dir: %w", err)
		}

		src := filepath.Join(srcDir, entry.Name())
		dst := filepath.Join(dstDir, entry.Name())
		if err := os.Link(src, dst); err == nil || errors.Is(err, fs.ErrExist) {
			continue
		}
		if err := copyFile(src, dstDir, dst); err != nil {
			return err
		}
	}
	return nil
}

// copyFile copies src to dst by way of dstDir's incoming directory, so a copy
// cut short leaves nothing under dst's name. Streamed: an attachment can be
// far larger than anything worth holding in memory.
func copyFile(src, dstDir, dst string) error {
	f, err := os.Open(src)
	if err != nil {
		return fmt.Errorf("read attachment: %w", err)
	}
	defer f.Close()
	tmp, _, _, err := spool(dstDir, f, math.MaxInt64-1)
	if err != nil {
		return fmt.Errorf("copy attachment: %w", err)
	}
	return place(tmp, dst)
}

// ErrNotFound is returned by Resolve for an id that names no stored attachment.
var ErrNotFound = errors.New("attachment not found")

// Resolve returns the path of one stored attachment, for a caller that has to
// hand the file itself on — an agent reading what the user sent.
//
// The id arrives from a client, so it is held to what Put hands out before it
// becomes a path: a bare file name inside the session's directory, naming a
// regular file. Anything else is ErrNotFound, the same answer a well-formed id
// with nothing behind it gets.
func Resolve(dataDir, sessionID, id string) (string, error) {
	if id == "" || !filepath.IsLocal(id) || filepath.Base(id) != id || filepath.Ext(id) == ".lock" {
		return "", ErrNotFound
	}
	path := filepath.Join(Dir(dataDir, sessionID), id)
	info, err := os.Lstat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", fmt.Errorf("stat attachment: %w", err)
	}
	if !info.Mode().IsRegular() {
		return "", ErrNotFound
	}
	return path, nil
}

// UploadExtension is the part of a user's file name worth keeping on the id of
// a file they uploaded.
//
// Unlike content an agent delivered, an upload is read back by the agent's own
// tools, and those go by extension: claude's Read only treats a file as a PDF
// or an image when its name says so, so a report stored under a bare hash would
// reach the model as bytes. Only a short alphanumeric extension is kept — the
// id is a file name on this machine, and nothing a client sends gets to choose
// more of it than that.
func UploadExtension(name string) string {
	ext := strings.ToLower(filepath.Ext(name))
	// .lock is what filestore's atomic write named its lock file in stores
	// written before PutStream, which Clone and Resolve both pass over.
	if len(ext) < 2 || len(ext) > 11 || ext == ".lock" {
		return ""
	}
	for _, r := range ext[1:] {
		if (r < 'a' || r > 'z') && (r < '0' || r > '9') {
			return ""
		}
	}
	return ext
}
