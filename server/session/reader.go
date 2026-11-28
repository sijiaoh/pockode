package session

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"sort"
	"time"
)

// Reader is the half of a session store that only looks: the whole of what it
// takes to show a conversation, and nothing that could change one.
//
// It exists because a worktree's sessions outlive the worktree. Deleting a
// worktree leaves its session data in place, and the data is then read from
// somewhere else — the worktree it belonged to is gone, so there is no process
// to talk to and no conversation to continue. Handing that path a Reader rather
// than a Store is what makes "read-only" a property of the type instead of a
// rule each caller has to keep.
//
// Both FileStore and DirReader implement it, which is what lets one read path
// serve a worktree somebody has open and one nobody does.
type Reader interface {
	List() ([]SessionMeta, error)
	Get(sessionID string) (SessionMeta, bool, error)
	GetHistory(ctx context.Context, sessionID string) ([]json.RawMessage, error)
}

// DirReader reads a data directory's sessions without owning it.
//
// Every call goes to disk. That is what makes it safe to hold one for a
// directory a FileStore may also be open on — it keeps no cache that could
// disagree with that store, and the index is written atomically, so a read
// lands on one whole version or another. That version can trail a live store
// by its pending recoverable changes (see metaChange) — never a durable one —
// which is why a caller reads through the store whenever there is one. The
// reverse — a second FileStore over the same directory — is exactly what must
// not happen (see FileStore), and is why DirReader takes no lock: the server
// that owns the directory holds it.
//
// It never writes, not even the repairs FileStore performs on load: a turn the
// last run left open is normalised on the way out (NormalizeTurn) and the file
// is left alone, because repairing it belongs to whoever owns it.
type DirReader struct{ dataDir string }

func NewDirReader(dataDir string) DirReader {
	return DirReader{dataDir: dataDir}
}

func (r DirReader) List() ([]SessionMeta, error) {
	idx, err := readIndexFile(r.dataDir)
	if err != nil {
		return nil, err
	}

	sessions := idx.Sessions
	now := time.Now()
	for i := range sessions {
		sessions[i].Turn = NormalizeTurn(sessions[i].Turn, now).State
	}
	sort.Slice(sessions, ListOrder(sessions, SessionMeta.Cursor))
	return sessions, nil
}

func (r DirReader) Get(sessionID string) (SessionMeta, bool, error) {
	sessions, err := r.List()
	if err != nil {
		return SessionMeta{}, false, err
	}
	for _, sess := range sessions {
		if sess.ID == sessionID {
			return sess, true, nil
		}
	}
	return SessionMeta{}, false, nil
}

func (r DirReader) GetHistory(ctx context.Context, sessionID string) ([]json.RawMessage, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return readHistory(r.dataDir, sessionID)
}

// readIndexFile reads a data directory's session index straight off disk,
// migrations applied and nothing written back.
//
// It is the one reader for every caller that has no store: DirReader, ReadTurns
// and ReadUsages. Sharing it is what keeps a field defaulted on load from being
// defaulted in one of them and left blank in the others.
//
// No lock, on purpose: locking cannot make the read see a newer version than it
// happens to arrive at, and would create a .lock file in a directory this
// caller only wants to look at (see server/AGENTS.md).
//
// A directory with no index yet has no sessions, which is not an error.
func readIndexFile(dataDir string) (indexData, error) {
	data, err := os.ReadFile(indexPath(dataDir))
	if errors.Is(err, fs.ErrNotExist) {
		return indexData{Sessions: []SessionMeta{}}, nil
	}
	if err != nil {
		return indexData{}, fmt.Errorf("read session index: %w", err)
	}

	var idx indexData
	if err := json.Unmarshal(data, &idx); err != nil {
		return indexData{}, fmt.Errorf("parse session index: %w", err)
	}
	migrateIndex(&idx)
	return idx, nil
}

// HistoryVersion is which version of a session's history file a read found:
// the file itself, its size and when it was last written. A history only
// changes by an append, which grows it, or by a whole-file write renamed into
// place, which makes it another file (see FileStore.GetHistory) — so two
// versions that are Same name the same contents.
//
// It is what lets something that keeps a copy of a history it is told of no
// writes to (projection.Folds) know whether the copy still holds, at the cost
// of one stat instead of a read.
type HistoryVersion struct {
	path string
	info fs.FileInfo
}

// HistoryVersion is the version of the session's history file as of now. Take
// it before reading the history: a write between the two then leaves a copy
// that is newer than its version says, which is read again, never one that is
// older.
func (r DirReader) HistoryVersion(sessionID string) (HistoryVersion, error) {
	path := historyPath(r.dataDir, sessionID)
	info, err := os.Stat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return HistoryVersion{path: path}, nil
	}
	if err != nil {
		return HistoryVersion{}, fmt.Errorf("stat session history: %w", err)
	}
	// On Windows, Stat of a regular file does not read the file's identity:
	// SameFile fetches it from the path when first asked, which for a version
	// compared later would be the file there *then* — every version of the
	// history would be the same file. Asking now fixes it to this one. Where
	// it cannot be read (the file renamed over meanwhile), the version is left
	// without one, which is Same as nothing: the history is read again rather
	// than a later ask reading the identity of whatever file is there then.
	if !os.SameFile(info, info) {
		return HistoryVersion{path: path}, nil
	}
	return HistoryVersion{path: path, info: info}, nil
}

// File is the history file the version is of: one key per history, however
// many readers there are over its directory.
func (v HistoryVersion) File() string { return v.path }

// Same reports whether v and w are one version of one file. A version of a
// history that has no file, or whose file's identity could not be read, is
// the same as nothing: nothing kept can be told to still hold.
func (v HistoryVersion) Same(w HistoryVersion) bool {
	if v.info == nil || w.info == nil {
		return false
	}
	return v.path == w.path &&
		v.info.Size() == w.info.Size() &&
		v.info.ModTime().Equal(w.info.ModTime()) &&
		os.SameFile(v.info, w.info)
}
