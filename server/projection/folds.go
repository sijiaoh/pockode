package projection

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/pockode/server/session"
)

// VersionedReader is a reader that can say which version of a history a read
// would find without reading it (session.DirReader).
type VersionedReader interface {
	session.Reader
	HistoryVersion(sessionID string) (session.HistoryVersion, error)
}

// Folds keeps the projections of histories read through readers that are told
// of no writes — the data directory of a worktree nobody here has loaded — so
// that paging one does not fold the whole file again for every page.
//
// It is FromReader with a memory, and FromReader's reason for keeping nothing
// still holds: whatever else may write those files, this server hears of none
// of it. So nothing kept is trusted beyond the version of the file it was
// folded from (session.HistoryVersion): every read checks it, with a stat,
// and folds the file again when it has changed. That is the whole of the
// invalidation, and it is enough: a history changes only by appends and whole
// rewrites, and both make another version.
//
// What is kept is bounded the way Live's linger is: a projection is let go
// once it has gone unread for the linger, and every read is somebody's request
// to see that session. Folds holds nothing a process or a subscriber holds —
// a worktree that has those is loaded, and read through its own Live.
type Folds struct {
	linger time.Duration

	entriesMu sync.Mutex
	entries   map[string]*foldEntry
}

type foldEntry struct {
	// foldMu serializes reads with the fold they read, so two first reads of one
	// history fold it once.
	foldMu    sync.Mutex
	version   session.HistoryVersion
	agentType session.AgentType
	fold      *Projection // nil until a read has folded the file

	until time.Time // guarded by Folds.entriesMu
}

// NewFolds keeps each projection for linger after its last read; zero keeps
// none, which makes its sources FromReader's.
func NewFolds(linger time.Duration) *Folds {
	return &Folds{linger: linger, entries: make(map[string]*foldEntry)}
}

// Source is r's sessions' projections, kept here.
func (f *Folds) Source(r VersionedReader) Source {
	return foldsSource{f: f, r: r}
}

type foldsSource struct {
	f *Folds
	r VersionedReader
}

func (s foldsSource) State(ctx context.Context, sessionID string) (State, error) {
	var state State
	err := s.read(ctx, sessionID, func(p *Projection) error {
		state = p.State()
		return nil
	})
	return state, err
}

func (s foldsSource) Page(ctx context.Context, sessionID string, beforeSeq session.HistorySeq, limit int) (Page, error) {
	var page Page
	err := s.read(ctx, sessionID, func(p *Projection) error {
		var err error
		page, err = p.Page(beforeSeq, limit)
		return err
	})
	return page, err
}

func (s foldsSource) ItemAt(ctx context.Context, sessionID string, seq session.HistorySeq) (int, error) {
	var id int
	err := s.read(ctx, sessionID, func(p *Projection) error {
		id = p.ItemAt(seq)
		return nil
	})
	return id, err
}

// Hold implements Source. Nothing that holds a session — its process, its
// subscribers — runs in a worktree that is not loaded, so there is nothing to
// keep beyond the linger.
func (foldsSource) Hold(string) func() { return func() {} }

// read calls view with the session's projection as of the file's version now:
// the one kept, if it was folded from that version, or one folded afresh and
// kept in its place.
func (s foldsSource) read(ctx context.Context, sessionID string, view func(*Projection) error) error {
	meta, ok, err := s.r.Get(sessionID)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("%w: %s", session.ErrSessionNotFound, sessionID)
	}
	// Before the read, so a write racing it leaves a fold newer than its
	// version, which the next read folds again — never one older.
	version, err := s.r.HistoryVersion(sessionID)
	if err != nil {
		return err
	}
	e := s.f.entry(version.File())
	if e == nil {
		p, err := foldFile(ctx, s.r, sessionID, meta.AgentType)
		if err != nil {
			return err
		}
		return view(p)
	}
	e.foldMu.Lock()
	defer e.foldMu.Unlock()
	if e.fold == nil || !e.version.Same(version) || e.agentType != meta.AgentType {
		p, err := foldFile(ctx, s.r, sessionID, meta.AgentType)
		if err != nil {
			return err
		}
		e.fold, e.version, e.agentType = p, version, meta.AgentType
	}
	return view(e.fold)
}

// entry is the file's entry, kept for the linger from now; nil when nothing
// is kept.
func (f *Folds) entry(file string) *foldEntry {
	if f.linger <= 0 {
		return nil
	}
	f.entriesMu.Lock()
	defer f.entriesMu.Unlock()
	until := time.Now().Add(f.linger)
	if e, ok := f.entries[file]; ok {
		e.until = until
		return e
	}
	e := &foldEntry{until: until}
	f.entries[file] = e
	f.arm(file, e, f.linger)
	return e
}

// arm lets e go after d, or later if a read has pushed its deadline back
// meanwhile — checked when the timer fires rather than by resetting it, as
// Live's linger is (armLinger).
func (f *Folds) arm(file string, e *foldEntry, d time.Duration) {
	time.AfterFunc(d, func() { f.expire(file, e) })
}

// expire lets e go if its deadline has passed, and waits again for it if not.
// A read still holding e finishes with it; the next one starts afresh.
func (f *Folds) expire(file string, e *foldEntry) {
	f.entriesMu.Lock()
	defer f.entriesMu.Unlock()
	if f.entries[file] != e {
		return
	}
	if left := time.Until(e.until); left > 0 {
		f.arm(file, e, left)
		return
	}
	delete(f.entries, file)
}
