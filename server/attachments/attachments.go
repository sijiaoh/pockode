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
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/pockode/server/filestore"
)

// ErrDisabled is returned by Put on a store with no directory behind it.
var ErrDisabled = errors.New("attachment store disabled")

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
// contents.ImageExtension, which answers from that same table — so an id ends
// in an extension only where the extension is what names the content, and "" is
// right for everything else, including content that arrived with no file name
// at all.
func (s Store) Put(data []byte, ext string) (string, error) {
	if s.dir == "" {
		return "", ErrDisabled
	}

	sum := sha256.Sum256(data)
	id := hex.EncodeToString(sum[:]) + ext
	path := filepath.Join(s.dir, id)
	if _, err := os.Stat(path); err == nil {
		return id, nil
	}

	if err := os.MkdirAll(s.dir, 0755); err != nil {
		return "", fmt.Errorf("create attachment dir: %w", err)
	}
	if err := filestore.WriteFileAtomic(path, data, 0644); err != nil {
		return "", fmt.Errorf("write attachment: %w", err)
	}
	return id, nil
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
		// The lock filestore's atomic write leaves behind belongs to the write,
		// not to the content.
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
		data, err := os.ReadFile(src)
		if err != nil {
			return fmt.Errorf("read attachment: %w", err)
		}
		if err := filestore.WriteFileAtomic(dst, data, 0644); err != nil {
			return fmt.Errorf("copy attachment: %w", err)
		}
	}
	return nil
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
	// .lock is what filestore's atomic write names its lock file, which Clone
	// and Resolve both pass over.
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
