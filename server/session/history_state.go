package session

import (
	"encoding/json"
	"fmt"
	"sync"
)

// sessionHistory is what the store knows about one session's history file,
// and the lock every write to that file is made under.
//
// One per session rather than one for the store: the first append to a
// session counts its whole file (see FileStore.countHistory), and under a
// store-wide lock a large old session being counted stalled the streaming of
// every other one.
//
// The lock is held across the write itself, so two concurrent appends cannot
// take sequence numbers in one order and reach the file in the other — which
// would make a sequence number name the wrong record.
//
// It also guards deleted. Delete tombstones a session under it before removing
// the directory, so an append is either finished before the removal starts or
// sees the tombstone — never one that recreates the directory through
// AppendJSONL's MkdirAll.
type sessionHistory struct {
	fileMu sync.Mutex
	// counted says lastSeq has been read off disk (or set by a whole-file
	// write); until then it means nothing.
	counted bool
	// lastSeq is the seq of the newest record in the file; the next append
	// takes the one after it.
	lastSeq HistorySeq
	// deleted marks a session this process deleted, so a late write to one —
	// an expiry recorded while its process is torn down — fails with
	// ErrSessionNotFound instead of leaving an orphan directory nothing lists.
	// A tombstone rather than a lookup in the index: that would mean taking
	// writeMu on every streamed record, behind each index write. It lasts
	// until the same id is created again (a work restarts its deleted session
	// under its own id); sessions deleted by an earlier run have no process
	// left to write.
	deleted bool
}

// historyState returns the session's entry, creating it on first use.
//
// Entries are never removed from the map, deleted sessions' included: the
// tombstone lives in the entry, and a writer that looked one up must find the
// same one Delete marks — an entry dropped and recreated between the two would
// hand them different locks. What stays behind is one small struct per session
// this process wrote to or deleted, the same as the counts and tombstones the
// store has always kept.
//
// historiesMu is only ever held for the lookup, never while taking another
// lock, so it sits outside the lock order.
func (s *FileStore) historyState(sessionID string) *sessionHistory {
	s.historiesMu.Lock()
	defer s.historiesMu.Unlock()
	h, ok := s.histories[sessionID]
	if !ok {
		h = &sessionHistory{}
		s.histories[sessionID] = h
	}
	return h
}

// checkNotDeletedLocked refuses a write to a session this store deleted.
// Caller must hold h.fileMu.
func (h *sessionHistory) checkNotDeletedLocked(sessionID string) error {
	if h.deleted {
		return fmt.Errorf("%w: %s was deleted", ErrSessionNotFound, sessionID)
	}
	return nil
}

// HistoryObserver is told of every change this store makes to a session's
// history, in the order the file takes them: each call is made under the
// session's history lock, after the write it reports has reached the file. It
// is how a reader keeps something derived from a history current without
// re-reading it (projection.Live), and why it cannot fall behind or ahead of the
// file: a record is reported before AppendToHistory returns, so whoever learns
// of a record from its writer finds it reported too.
//
// It must not call back into the store, and should be quick: it runs inside
// the write, and the session's next write waits for it.
type HistoryObserver interface {
	// HistoryAppended reports that line — the record as stored, envelope
	// included — was appended under seq.
	HistoryAppended(sessionID string, seq HistorySeq, line json.RawMessage)
	// HistoryReset reports that the history is no longer the one the appends
	// so far describe: it was replaced (WriteHistory), deleted, created again
	// under a deleted session's id, or an append failed in a way that may or
	// may not have reached the file. Whatever was derived from it has to be
	// read again from the file.
	HistoryReset(sessionID string)
}

// SetHistoryObserver names who is told of history writes. Set it before the
// store is shared: appends read it without a lock. The store's own repair on
// load (abortTurnsTheLastRunLeftOpen) happens before it can be set, which is
// fine for an observer that reads a history off the file the first time it
// needs it.
func (s *FileStore) SetHistoryObserver(o HistoryObserver) {
	s.historyObserver = o
}

func (s *FileStore) historyAppended(sessionID string, seq HistorySeq, line []byte) {
	if s.historyObserver != nil {
		s.historyObserver.HistoryAppended(sessionID, seq, line)
	}
}

func (s *FileStore) historyReset(sessionID string) {
	if s.historyObserver != nil {
		s.historyObserver.HistoryReset(sessionID)
	}
}
