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
// lands on one whole version or another. The reverse — a second FileStore over
// the same directory — is exactly what must not happen (see FileStore).
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
