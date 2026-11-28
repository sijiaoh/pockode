package session

import (
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
