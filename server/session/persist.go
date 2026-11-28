package session

import (
	"errors"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"time"

	"github.com/pockode/server/filestore"
)

// metaChange is what a mutation did to a session's metadata, and with that how
// soon the index has to reach the disk.
type metaChange int

const (
	// unchanged costs nothing: no write, no notification.
	unchanged metaChange = iota
	// recoverable is a change a crash may take away without anyone being owed
	// it back: either startup repair rebuilds it, or the value it falls back
	// to is harmless. It is held in memory and written with whatever else is
	// pending at most flushDelay later, so a burst of them — every session's
	// turn moving at once — costs one index rewrite instead of one each.
	//
	// What qualifies, and why:
	//
	//   - Turn phase, Open, Since, Blockers and LastOutcome, except a turn
	//     opening (see durable). Startup repair (abortTurnsTheLastRunLeftOpen)
	//     reduces every stored turn with SignalProcessEnded, which expires every
	//     blocker and aborts an open turn whatever the file said, and appends
	//     process_ended to a history that does not already end on it — and the
	//     blocker records a lost raise or answer would leave are the history's
	//     last records. So a lost raise, answer, withdrawal or background park
	//     reads back exactly as if it had been written. A lost ending reads
	//     back as aborted instead of how the turn actually ended. That is
	//     harmless because flushDelay is well inside DefaultSettleDelay: the
	//     work engine acts on an ending only once it has settled, by which
	//     time the ending has ordinarily been written, so one a crash takes is
	//     one nothing had acted on yet. Ordinarily, not always — a disk that
	//     refuses the write, or a write queued behind a long Delete, can still
	//     lose an ending the engine has seen, and the cost is then an outcome
	//     shown as aborted, nothing more.
	//   - UpdatedAt moved by Touch (and by an Activate of a session already
	//     activated): the session sorts by the activity before the last
	//     second or so.
	//   - Unread: a hint for the eye, which falls back to what it said a moment
	//     earlier.
	recoverable
	// durable is written, fsynced, before the call returns: titles, creation
	// and deletion, the engine settings, Started, the first Activate, every
	// usage report, and the turn changes startup repair cannot rebuild.
	//
	// Usage is durable because nothing rebuilds it — reports are not in the
	// history — and because ReadUsages reads the file, not the store. A turn
	// opening is durable so that a crash in the middle of a turn reads back as
	// that turn aborted, rather than as the previous turn's outcome. A change to
	// Unanswered is durable because a posted question belongs to the session
	// and survives every restart; it is state, not something derived from the
	// transcript.
	//
	// A durable write also writes whatever recoverable changes are pending:
	// the index is one file.
	durable
)

// recoverableFlushDelay bounds how long a recoverable change waits in memory.
// Shorter than DefaultSettleDelay on purpose — see recoverable.
const recoverableFlushDelay = time.Second

// persistLocked records that the index changed. Caller must hold writeMu.
func (s *FileStore) persistLocked(change metaChange) error {
	switch {
	case change == unchanged:
		return nil
	case change == durable:
		return s.persistIndex()
	}
	s.dirty = true
	if s.closed {
		return s.writeDeferredLocked()
	}
	// Armed by the first pending change and not pushed back by the next, so a
	// session that changes every few hundred milliseconds still reaches the
	// disk every flushDelay.
	s.armFlushLocked()
	return nil
}

// armFlushLocked schedules a flush unless one is already scheduled. Caller
// must hold writeMu, except during construction.
func (s *FileStore) armFlushLocked() {
	if s.flushTimer != nil || s.closed {
		return
	}
	gen := s.flushGen
	s.flushTimer = time.AfterFunc(s.flushDelay, func() { s.flushPending(gen) })
}

// disarmFlushLocked cancels the scheduled flush. Its callback may already be
// running and waiting for writeMu, which Stop cannot prevent; the generation
// it was armed with tells it it is stale, so it neither writes nor takes the
// handle of a timer armed after it. Caller must hold writeMu.
func (s *FileStore) disarmFlushLocked() {
	if s.flushTimer != nil {
		s.flushTimer.Stop()
		s.flushTimer = nil
	}
	s.flushGen++
}

// persistIndex writes the whole index now, pending recoverable changes
// included. Caller must hold writeMu, except during construction.
func (s *FileStore) persistIndex() error {
	// Marked before the write rather than cleared only on success: whatever
	// is in memory is what has to reach the disk, so a failed write is
	// retried instead of being forgotten.
	s.dirty = true
	// The version is stamped by whatever write comes first rather than forced at
	// startup: a run that stores nothing has nothing to lose by repairing the
	// same file again, and the first report from any agent writes both at once.
	data, err := filestore.MarshalIndex(indexData{Version: indexVersion, Sessions: s.sessions})
	if err != nil {
		return err
	}
	if err := s.writeIndex(s.indexPath(), data, 0644); err != nil {
		// Tried again on the flush schedule rather than left for the next
		// change: a session that goes quiet would otherwise keep what the disk
		// refused in memory until Close. Closed, it waits for the next write.
		s.armFlushLocked()
		return err
	}
	s.dirty = false
	s.disarmFlushLocked()
	return nil
}

func (s *FileStore) flushPending(gen uint64) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	if gen != s.flushGen {
		return
	}
	s.flushTimer = nil
	if !s.dirty || s.closed {
		return
	}
	if err := s.writeDeferredLocked(); err != nil {
		slog.Error("failed to write pending session index changes", "dir", s.dataDir, "error", err)
	}
}

// writeDeferredLocked writes the pending recoverable changes — from the timer,
// from Close, or as they happen once closed — unless the sessions directory is
// gone. Under a live store it only disappears when the data it held was
// removed on purpose, and the write would bring it back, with an index naming
// sessions whose histories are gone. Durable writes do not ask: they are what
// a caller was promised. Caller must hold writeMu.
func (s *FileStore) writeDeferredLocked() error {
	if _, err := os.Stat(filepath.Dir(s.indexPath())); errors.Is(err, fs.ErrNotExist) {
		slog.Warn("session directory is gone, dropping pending index changes", "dir", s.dataDir)
		s.dirty = false
		return nil
	}
	return s.persistIndex()
}

// Close writes whatever recoverable changes are pending. Every change after it
// is written as it happens: a late event from a process being torn down still
// reaches the disk, with no timer left to take it there.
func (s *FileStore) Close() error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	s.closed = true
	s.disarmFlushLocked()
	if !s.dirty {
		return nil
	}
	return s.writeDeferredLocked()
}
