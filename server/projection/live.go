package projection

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

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
	// Page is a page of the session's transcript (Projection.Page) as of the
	// same moment State is. Its errors are Projection.Page's, beside State's.
	Page(ctx context.Context, sessionID string, beforeSeq session.HistorySeq, limit int) (Page, error)
	// ItemAt is Projection.ItemAt as of the same moment State is.
	ItemAt(ctx context.Context, sessionID string, seq session.HistorySeq) (int, error)
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
// projection go once it has lingered (DefaultLinger); a read of a session
// nobody holds folds the file and lingers the same way.
//
// The linger is what lets a session that is put down and picked up again —
// a reconnect, the chat closed and reopened, a session_view paged without a
// subscription — be read without folding the whole file each time: a long
// history folds in tens of milliseconds, where cutting a page of a kept one
// takes tens of microseconds. It is a hold of its own, so a lingering
// projection is kept current like any held one, and is let go when the
// linger has run out with nothing else holding it.
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
	// broken are the held sessions whose kept projection was let go while
	// they were held, until TakeUpdate says so: what changed in between is in
	// no update.
	broken map[string]bool
	// linger is how long a projection is kept after it was last read or
	// released (DefaultLinger); zero keeps none.
	linger time.Duration
	// lingering are the sessions held by their linger: one of holds each,
	// until its deadline.
	lingering map[string]*lingerHold
}

// DefaultLinger is how long Live keeps a session's projection once nothing
// holds it: long enough for a client to reconnect, or a user to come back to
// the chat they just left, without folding the file again.
const DefaultLinger = 2 * time.Minute

type lingerHold struct {
	until time.Time
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
	l := &Live{
		store:     store,
		holds:     make(map[string]int),
		sessions:  make(map[string]*liveSession),
		broken:    make(map[string]bool),
		linger:    DefaultLinger,
		lingering: make(map[string]*lingerHold),
	}
	store.SetHistoryObserver(l)
	return l
}

// State returns the session's projection, folded from the file on the first
// read since it was last let go and kept after. A read of a session nobody
// holds makes it linger, so the reads that follow it are served the same way.
//
// The entry goes into the map before the file is read, and the store reports
// an append only after writing it, so a record is either reported to an entry
// that exists — and is folded unless the read already had it (its seq is not
// past the read's last) — or was written before the entry existed and is in
// what the read finds. A last release racing the read drops the entry the read
// is loading; the read still returns what it loaded, and nothing is kept.
func (l *Live) State(ctx context.Context, sessionID string) (State, error) {
	var state State
	err := l.read(ctx, sessionID, func(p *Projection) error {
		state = p.State()
		return nil
	})
	return state, err
}

// Page implements Source. A held session's is cut from the projection kept
// for it, under its lock and without copying the state: a page costs the
// items it holds, and the file is not read again.
func (l *Live) Page(ctx context.Context, sessionID string, beforeSeq session.HistorySeq, limit int) (Page, error) {
	var page Page
	err := l.read(ctx, sessionID, func(p *Projection) error {
		var err error
		page, err = p.Page(beforeSeq, limit)
		return err
	})
	return page, err
}

// ItemAt implements Source.
func (l *Live) ItemAt(ctx context.Context, sessionID string, seq session.HistorySeq) (int, error) {
	var id int
	err := l.read(ctx, sessionID, func(p *Projection) error {
		id = p.ItemAt(seq)
		return nil
	})
	return id, err
}

// read calls view with the session's projection: the one kept for it, under
// its lock, or with lingering off (linger zero) and nobody holding the
// session, one folded from the file. See State.
func (l *Live) read(ctx context.Context, sessionID string, view func(*Projection) error) error {
	meta, ok, err := l.store.Get(sessionID)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("%w: %s", session.ErrSessionNotFound, sessionID)
	}

	l.lingerOnRead(sessionID)
	e := l.entry(sessionID, meta.AgentType)
	if e == nil {
		p, err := foldFile(ctx, l.store, sessionID, meta.AgentType)
		if err != nil {
			return err
		}
		return view(p)
	}
	e.foldMu.Lock()
	defer e.foldMu.Unlock()
	if err := l.load(ctx, sessionID, e, false); err != nil {
		return err
	}
	return view(e.fold)
}

// load folds e from the file, unless it has been already. Caller holds
// e.foldMu.
//
// The file's newest record is folded after changes start being tracked, so
// that what it changed is in the next update. It may be a record whose update
// is still to be taken: written while nothing was loaded, with the read that
// loads it landing before TakeUpdate does — or TakeUpdate itself loading, on
// the record just written. Either way the update would otherwise report
// nothing, not even the calls the record settled, whose streams would then
// outlive them. When it is not, its items are merely sent again as they
// stand. written is whether it is the record just written (TakeUpdate), and
// so folded as written; otherwise it is read as the file has it, which by the
// prefix rule is the fold of the whole file.
func (l *Live) load(ctx context.Context, sessionID string, e *liveSession, written bool) error {
	if e.loaded {
		return nil
	}
	records, err := l.store.GetHistory(ctx, sessionID)
	if err != nil {
		l.forget(sessionID, e)
		return err
	}
	before := max(len(records)-1, 0)
	e.fold = Fold(records[:before], e.agentType)
	e.fold.TrackChanges()
	if before < len(records) {
		if written {
			e.fold.AppendWritten(records[before])
		} else {
			e.fold.Append(records[before])
		}
	}
	e.lastSeq = lastSeq(session.NoHistorySeq, records)
	e.loaded = true
	// A Delete between the caller's Get and the read has reset the session
	// before this entry existed, and would leave it kept for a session
	// nobody lists, until its holders let go. The state read is still
	// returned: it was the session's when the call began.
	if _, ok, err := l.store.Get(sessionID); err == nil && !ok {
		l.forget(sessionID, e)
	}
	return nil
}

// TakeUpdate is what the session's transcript changed by since the last
// call (Projection.TakeUpdate), for a session something holds. Called after
// each record is written — the store has reported it by then — it is what
// that record changed.
//
// continuous is false when what changed since the last call may be missing
// from the update: the projection kept for the session was let go while it
// was held — its history replaced, its agent type changed — so whoever is
// keeping a copy current from updates must start again from a page. It is
// true, and the update empty, for a session nobody holds: there is no copy
// to keep current, and the next hold starts from a page.
func (l *Live) TakeUpdate(ctx context.Context, sessionID string) (u Update, continuous bool, err error) {
	meta, ok, err := l.store.Get(sessionID)
	if err != nil {
		return Update{}, true, err
	}
	if !ok {
		return Update{}, true, fmt.Errorf("%w: %s", session.ErrSessionNotFound, sessionID)
	}
	e := l.entry(sessionID, meta.AgentType)
	if e == nil {
		return Update{}, true, nil
	}
	e.foldMu.Lock()
	defer e.foldMu.Unlock()
	continuous = !l.takeBroken(sessionID)
	if !e.loaded {
		if !l.isHeldBeyondLinger(sessionID) {
			// Only lingering, and dropped since: nobody keeps a copy to
			// update, and the next read folds the file anyway.
			return Update{}, continuous, nil
		}
		// Loaded now, from a file that already holds the record just
		// written: the update is what that record changed.
		if err := l.load(ctx, sessionID, e, true); err != nil {
			return Update{}, continuous, err
		}
	}
	return e.fold.TakeUpdate(), continuous, nil
}

func (l *Live) takeBroken(sessionID string) bool {
	l.sessionsMu.Lock()
	defer l.sessionsMu.Unlock()
	broken := l.broken[sessionID]
	delete(l.broken, sessionID)
	return broken
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
	l.holds[sessionID]--
	if h, ok := l.lingering[sessionID]; ok {
		if l.holds[sessionID] == 1 {
			// Only the linger is left: it runs from now.
			h.until = time.Now().Add(l.linger)
			delete(l.broken, sessionID)
		}
		return
	}
	if l.holds[sessionID] > 0 {
		return
	}
	if e, ok := l.sessions[sessionID]; ok && e.loaded && l.linger > 0 {
		// Nobody keeps a copy current from updates any more, so there is no
		// break left to report.
		delete(l.broken, sessionID)
		l.holds[sessionID] = 0
		l.startLinger(sessionID)
		return
	}
	l.letGo(sessionID)
}

// letGo forgets the session altogether. Caller holds sessionsMu.
func (l *Live) letGo(sessionID string) {
	delete(l.holds, sessionID)
	delete(l.sessions, sessionID)
	delete(l.broken, sessionID)
}

// lingerOnRead keeps a session that is being read for the linger from now:
// one nobody holds starts lingering, one already lingering lingers longer.
func (l *Live) lingerOnRead(sessionID string) {
	if l.linger <= 0 {
		return
	}
	l.sessionsMu.Lock()
	defer l.sessionsMu.Unlock()
	if h, ok := l.lingering[sessionID]; ok {
		h.until = time.Now().Add(l.linger)
		return
	}
	if l.holds[sessionID] == 0 {
		l.startLinger(sessionID)
	}
}

// heldBeyondLinger says something besides its linger holds the session — a
// process or a subscriber, either of which may be keeping a copy current
// from updates. Caller holds sessionsMu.
func (l *Live) heldBeyondLinger(sessionID string) bool {
	n := l.holds[sessionID]
	if _, ok := l.lingering[sessionID]; ok {
		n--
	}
	return n > 0
}

func (l *Live) isHeldBeyondLinger(sessionID string) bool {
	l.sessionsMu.Lock()
	defer l.sessionsMu.Unlock()
	return l.heldBeyondLinger(sessionID)
}

// startLinger takes the linger's hold. Caller holds sessionsMu.
func (l *Live) startLinger(sessionID string) {
	h := &lingerHold{until: time.Now().Add(l.linger)}
	l.lingering[sessionID] = h
	l.holds[sessionID]++
	l.armLinger(sessionID, h, l.linger)
}

// armLinger ends h after d, or later if a read has pushed its deadline back
// meanwhile — checked when it fires rather than by resetting the timer, so a
// read racing the timer cannot leave the hold taken twice or never released.
func (l *Live) armLinger(sessionID string, h *lingerHold, d time.Duration) {
	time.AfterFunc(d, func() { l.endLinger(sessionID, h) })
}

// endLinger releases h's hold if its deadline has passed, and waits again
// for it if not.
func (l *Live) endLinger(sessionID string, h *lingerHold) {
	l.sessionsMu.Lock()
	defer l.sessionsMu.Unlock()
	if l.lingering[sessionID] != h {
		return
	}
	if left := time.Until(h.until); left > 0 {
		l.armLinger(sessionID, h, left)
		return
	}
	delete(l.lingering, sessionID)
	if l.holds[sessionID]--; l.holds[sessionID] <= 0 {
		l.letGo(sessionID)
	}
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
		if ok && e.loaded && l.heldBeyondLinger(sessionID) {
			l.broken[sessionID] = true
		}
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
		l.drop(sessionID)
	}
}

// drop lets the session's projection go. Caller holds sessionsMu.
func (l *Live) drop(sessionID string) {
	if e, ok := l.sessions[sessionID]; ok && e.loaded && l.heldBeyondLinger(sessionID) {
		l.broken[sessionID] = true
	}
	delete(l.sessions, sessionID)
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
	e.fold.AppendWritten(line)
	e.lastSeq = seq
}

// HistoryReset implements session.HistoryObserver. A read loading the
// session meanwhile finishes into the dropped entry and returns what it read;
// the next one reads the file again.
func (l *Live) HistoryReset(sessionID string) {
	l.sessionsMu.Lock()
	defer l.sessionsMu.Unlock()
	l.drop(sessionID)
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
// Nothing is kept; Folds is the same source with a fold kept for as long as
// the file stays as it was, for a directory paged through.
func FromReader(r session.Reader) Source {
	return readerSource{r}
}

type readerSource struct{ r session.Reader }

func (s readerSource) State(ctx context.Context, sessionID string) (State, error) {
	p, err := s.fold(ctx, sessionID)
	if err != nil {
		return State{}, err
	}
	return p.State(), nil
}

func (s readerSource) Page(ctx context.Context, sessionID string, beforeSeq session.HistorySeq, limit int) (Page, error) {
	p, err := s.fold(ctx, sessionID)
	if err != nil {
		return Page{}, err
	}
	return p.Page(beforeSeq, limit)
}

func (s readerSource) ItemAt(ctx context.Context, sessionID string, seq session.HistorySeq) (int, error) {
	p, err := s.fold(ctx, sessionID)
	if err != nil {
		return 0, err
	}
	return p.ItemAt(seq), nil
}

func (s readerSource) fold(ctx context.Context, sessionID string) (*Projection, error) {
	meta, ok, err := s.r.Get(sessionID)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, fmt.Errorf("%w: %s", session.ErrSessionNotFound, sessionID)
	}
	return foldFile(ctx, s.r, sessionID, meta.AgentType)
}

func (readerSource) Hold(string) func() { return func() {} }

func foldFile(ctx context.Context, r session.Reader, sessionID string, agentType session.AgentType) (*Projection, error) {
	records, err := r.GetHistory(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	return Fold(records, agentType), nil
}
