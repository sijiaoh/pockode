package projection

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"

	"github.com/pockode/server/session"
)

// Source is where a session's projection is read: Live for a store this
// server holds open, FromReader for a data directory it only looks at. One
// interface for both for the same reason session.Reader is one: a read path
// that serves a worktree somebody has open serves one nobody does.
type Source interface {
	// State is what the session's history says as of the newest record
	// written to it before the call — every record whose append has returned
	// is in it. session.ErrSessionNotFound for a session the store does not
	// list.
	State(ctx context.Context, sessionID string) (State, error)
	Holder
}

// Holder is the half of a Source that whoever makes a session active — its
// process, its chat subscribers — needs: the projection of a session that will
// be read again is worth keeping.
type Holder interface {
	// Hold keeps the session's projection in memory until release is called.
	// release may be called more than once. A Source that keeps nothing
	// ignores it.
	Hold(sessionID string) (release func())
}

// Tracked is the store Live keeps up with: it reads a session's history once
// and is told of every write after (session.FileStore).
type Tracked interface {
	session.Reader
	SetHistoryObserver(session.HistoryObserver)
}

// Live holds the projection of each active session of one store, kept current
// as its history is written.
//
// A session is active while something holds it (Hold): its process, from
// start until its stream has drained, and its chat subscribers. Only an active
// session's projection is kept — an item holds a call's whole input and
// result, so keeping every session ever read would grow with everything the
// server has run. A held session is folded the first time its state is asked
// for, from the file, and from then on each record its store appends is folded
// as it is written (session.HistoryObserver). Its last release lets the
// projection go; a read of a session nobody holds folds the file and keeps
// nothing, as FromReader does.
//
// A held projection is also let go when the history stops being the one it
// describes — the session deleted, its history replaced, an append that may or
// may not have reached the file — to be read again from the file if it is
// asked for again; and with the store, since a Live is one store's. Nothing is
// persisted.
//
// The store reports writes under the session's history lock, in the order the
// file takes them, which is what lets a fold kept here agree with the file
// without the two sharing a lock. A read that first loads a session takes no
// store lock either; it relies on the order instead (see State).
type Live struct {
	store Tracked

	// sessionsMu guards only the maps: it is never held while an entry's lock
	// is being taken, so the observer, which runs under a store lock, never
	// waits behind a reader holding it, and the holders, which take it under
	// locks of their own, never wait behind a fold.
	sessionsMu sync.Mutex
	// holds counts each active session's holders. An id is in sessions only
	// while it is in holds.
	holds    map[string]int
	sessions map[string]*liveSession
}

type liveSession struct {
	// foldMu serializes the fold's appends with its reads; Projection itself
	// is not safe for concurrent use.
	foldMu sync.Mutex
	// agentType is what legacy lines' turns were inferred by (New). A session
	// whose agent type has changed since is folded again.
	agentType session.AgentType
	// loaded says fold has read the file. Until it has, an appended record is
	// not folded: the file has it, and the load will read it.
	loaded  bool
	fold    *Projection
	lastSeq session.HistorySeq
}

// Track starts keeping store's sessions' projections, and is the one way to
// make a Live: the observer and the store it reads have to be the same store,
// and set before anything is appended to it.
func Track(store Tracked) *Live {
	l := &Live{store: store, holds: make(map[string]int), sessions: make(map[string]*liveSession)}
	store.SetHistoryObserver(l)
	return l
}

// State returns the session's projection. A held session's is folded from
// the file on the first read since it was last let go and kept after; one
// nobody holds is folded from the file and dropped.
//
// The entry goes into the map before the file is read, and the store reports
// an append only after writing it, so a record is either reported to an entry
// that exists — and is folded unless the read already had it (its seq is not
// past the read's last) — or was written before the entry existed and is in
// what the read finds. A last release racing the read drops the entry the read
// is loading; the read still returns what it loaded, and nothing is kept.
func (l *Live) State(ctx context.Context, sessionID string) (State, error) {
	meta, ok, err := l.store.Get(sessionID)
	if err != nil {
		return State{}, err
	}
	if !ok {
		return State{}, fmt.Errorf("%w: %s", session.ErrSessionNotFound, sessionID)
	}

	e := l.entry(sessionID, meta.AgentType)
	if e == nil {
		return foldFile(ctx, l.store, sessionID, meta.AgentType)
	}
	e.foldMu.Lock()
	defer e.foldMu.Unlock()

	if !e.loaded {
		records, err := l.store.GetHistory(ctx, sessionID)
		if err != nil {
			l.forget(sessionID, e)
			return State{}, err
		}
		e.fold = Fold(records, e.agentType)
		e.lastSeq = lastSeq(session.NoHistorySeq, records)
		e.loaded = true
		// A Delete between the Get above and the read has reset the session
		// before this entry existed, and would leave it kept for a session
		// nobody lists, until its holders let go. The state read is still
		// returned: it was the session's when the call began.
		if _, ok, err := l.store.Get(sessionID); err == nil && !ok {
			l.forget(sessionID, e)
		}
	}
	return e.fold.State(), nil
}

// Hold implements Source: the session's projection is kept from its next read
// until the last of its holders has released it.
func (l *Live) Hold(sessionID string) (release func()) {
	l.sessionsMu.Lock()
	l.holds[sessionID]++
	l.sessionsMu.Unlock()
	var once sync.Once
	return func() { once.Do(func() { l.release(sessionID) }) }
}

func (l *Live) release(sessionID string) {
	l.sessionsMu.Lock()
	defer l.sessionsMu.Unlock()
	if l.holds[sessionID]--; l.holds[sessionID] > 0 {
		return
	}
	delete(l.holds, sessionID)
	delete(l.sessions, sessionID)
}

// entry returns the session's entry, replacing one folded under another agent
// type; nil for a session nobody holds.
func (l *Live) entry(sessionID string, agentType session.AgentType) *liveSession {
	l.sessionsMu.Lock()
	defer l.sessionsMu.Unlock()
	if l.holds[sessionID] == 0 {
		return nil
	}
	e, ok := l.sessions[sessionID]
	if !ok || e.agentType != agentType {
		e = &liveSession{agentType: agentType}
		l.sessions[sessionID] = e
	}
	return e
}

func (l *Live) lookup(sessionID string) *liveSession {
	l.sessionsMu.Lock()
	defer l.sessionsMu.Unlock()
	return l.sessions[sessionID]
}

// forget drops e, unless it has been replaced already.
func (l *Live) forget(sessionID string, e *liveSession) {
	l.sessionsMu.Lock()
	defer l.sessionsMu.Unlock()
	if l.sessions[sessionID] == e {
		delete(l.sessions, sessionID)
	}
}

// HistoryAppended implements session.HistoryObserver.
func (l *Live) HistoryAppended(sessionID string, seq session.HistorySeq, line json.RawMessage) {
	e := l.lookup(sessionID)
	if e == nil {
		return
	}
	e.foldMu.Lock()
	defer e.foldMu.Unlock()
	if !e.loaded || seq <= e.lastSeq {
		return
	}
	e.fold.Append(line)
	e.lastSeq = seq
}

// HistoryReset implements session.HistoryObserver. A read loading the
// session meanwhile finishes into the dropped entry and returns what it read;
// the next one reads the file again.
func (l *Live) HistoryReset(sessionID string) {
	l.sessionsMu.Lock()
	defer l.sessionsMu.Unlock()
	delete(l.sessions, sessionID)
}

// lastSeq is the seq of the newest numbered record of records, which follow
// one numbered prev.
func lastSeq(prev session.HistorySeq, records []json.RawMessage) session.HistorySeq {
	for _, raw := range records {
		if seq := session.NextHistorySeq(prev, raw); seq.Valid() {
			prev = seq
		}
	}
	return prev
}

// FromReader is the Source of a data directory nobody here holds open
// (session.DirReader): each call folds the history as the file has it then.
// Nothing is kept, for the reason DirReader keeps nothing — a store elsewhere
// may be writing the same files, and a copy here would not hear of it.
func FromReader(r session.Reader) Source {
	return readerSource{r}
}

type readerSource struct{ r session.Reader }

func (s readerSource) State(ctx context.Context, sessionID string) (State, error) {
	meta, ok, err := s.r.Get(sessionID)
	if err != nil {
		return State{}, err
	}
	if !ok {
		return State{}, fmt.Errorf("%w: %s", session.ErrSessionNotFound, sessionID)
	}
	return foldFile(ctx, s.r, sessionID, meta.AgentType)
}

func (readerSource) Hold(string) func() { return func() {} }

func foldFile(ctx context.Context, r session.Reader, sessionID string, agentType session.AgentType) (State, error) {
	records, err := r.GetHistory(ctx, sessionID)
	if err != nil {
		return State{}, err
	}
	return Fold(records, agentType).State(), nil
}
