package canvas

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pockode/server/filestore"
	"github.com/pockode/server/session"
)

// ErrNoRevision is returned for a revision the canvas does not have.
var ErrNoRevision = errors.New("the canvas has no such revision")

const (
	stateFileName = "state.json"
	indexFileName = "revisions.jsonl"
	snapshotExt   = ".json"
	filePerm      = 0o644
)

// Dir is where one session's canvas lives: under the session's own directory,
// so deleting the session deletes its canvas (session.FileStore.Delete).
func Dir(dataDir, sessionID string) string {
	return filepath.Join(dataDir, "sessions", sessionID, "canvas")
}

func snapshotPath(dir string, revision int) string {
	return filepath.Join(dir, strconv.Itoa(revision)+snapshotExt)
}

// stateFile is state.json: which snapshot is current, and the size the user
// last reported. The snapshot itself is a file of its own, so a new revision
// rewrites a few bytes here rather than the whole page twice.
type stateFile struct {
	Revision     int   `json:"revision"`
	ReportedSize *Size `json:"reported_size,omitempty"`
}

// Base is what a new revision is built from: the canvas as it is now.
type Base struct {
	// Revision is 0 when nothing has been drawn yet, and HTML is then empty.
	Revision int
	HTML     string
	// ReportedSize is the size the next revision will be recorded as drawn
	// for, nil when no message has reported one.
	ReportedSize *Size
}

// Draft is a new revision as its builder produced it. The store numbers it,
// stamps the size and time, and for an update fills in the revision it came
// from — none of which a builder could get wrong if it never chooses them.
type Draft struct {
	HTML   string
	Change Change
}

// Store owns the canvas of every session in one data directory: the state of
// each, kept in memory once read, and the snapshots on disk.
//
// Every change to one session's canvas is serialized, including the build of
// the new document, so two tool calls made in parallel apply one after the
// other and the second sees the first one's result (docs/canvas-ui.md §3.2).
type Store struct {
	dataDir string

	canvasesMu sync.Mutex
	canvases   map[string]*sessionCanvas
	// deleted are the sessions deleted while this store was running. A write
	// for one — a tool call that was already on its way — would recreate the
	// directory the delete just removed, and nothing would ever remove it
	// again. Session ids are never reused, so the set only grows by deletions.
	deleted map[string]bool

	onChange func(sessionID string, state State)

	// beforeWritten runs between a write and its check for a delete that
	// landed during it; only tests set it, to land one there.
	beforeWritten func(sessionID string)
}

type sessionCanvas struct {
	// canvasMu guards the fields below and is held across every read-modify-
	// write of this session's files.
	canvasMu sync.Mutex
	loaded   bool
	// gone is set when the session is deleted, and read right before a write.
	// Guarded by canvasesMu rather than canvasMu: the delete must not wait on a
	// write in flight (see OnSessionChange).
	gone    bool
	file    stateFile
	current *Snapshot
}

var _ session.OnChangeListener = (*Store)(nil)

func NewStore(dataDir string) *Store {
	return &Store{
		dataDir:  dataDir,
		canvases: make(map[string]*sessionCanvas),
		deleted:  make(map[string]bool),
	}
}

// SetOnChange installs what hears every new canvas state — the chat
// subscription pushing chat.canvas_state. Set before the store is used.
func (s *Store) SetOnChange(fn func(sessionID string, state State)) {
	s.onChange = fn
}

func (s *Store) notify(sessionID string, state State) {
	if s.onChange != nil {
		s.onChange(sessionID, state)
	}
}

// OnSessionChange forgets a deleted session; its files went with the session's
// directory.
//
// Called with the session store's lock held, so it takes nothing but
// canvasesMu, which is never held while anything else is: canvasMu may be held
// by a write in flight, and that write must not be waited for here.
func (s *Store) OnSessionChange(event session.SessionChangeEvent) {
	if event.Op != session.OperationDelete {
		return
	}
	s.canvasesMu.Lock()
	if c, ok := s.canvases[event.Session.ID]; ok {
		c.gone = true
		delete(s.canvases, event.Session.ID)
	}
	s.deleted[event.Session.ID] = true
	s.canvasesMu.Unlock()

	// A write that passed its check before gone was set may have recreated the
	// directory after the delete removed it. Removed again here if it finished
	// first; otherwise the write itself sees gone afterwards (see written).
	s.removeSessionDir(event.Session.ID)
}

func (s *Store) removeSessionDir(sessionID string) {
	if err := os.RemoveAll(filepath.Dir(Dir(s.dataDir, sessionID))); err != nil {
		slog.Error("failed to remove a deleted session's canvas", "sessionId", sessionID, "error", err)
	}
}

// lockedCanvas returns the session's canvas, read from disk if this is the
// first time, with canvasMu held. The caller unlocks it.
func (s *Store) lockedCanvas(sessionID string) (*sessionCanvas, error) {
	s.canvasesMu.Lock()
	if s.deleted[sessionID] {
		s.canvasesMu.Unlock()
		return nil, fmt.Errorf("canvas of session %s: %w", sessionID, session.ErrSessionNotFound)
	}
	c, ok := s.canvases[sessionID]
	if !ok {
		c = &sessionCanvas{}
		s.canvases[sessionID] = c
	}
	s.canvasesMu.Unlock()

	c.canvasMu.Lock()
	if c.loaded {
		return c, nil
	}
	if err := c.load(Dir(s.dataDir, sessionID)); err != nil {
		c.canvasMu.Unlock()
		return nil, fmt.Errorf("load canvas of session %s: %w", sessionID, err)
	}
	c.loaded = true
	return c, nil
}

// writable reports whether c's session still exists, as the last check before
// a write. Caller holds canvasMu.
func (s *Store) writable(c *sessionCanvas, sessionID string) error {
	s.canvasesMu.Lock()
	gone := c.gone
	s.canvasesMu.Unlock()
	if gone {
		return fmt.Errorf("canvas of session %s: %w", sessionID, session.ErrSessionNotFound)
	}
	return nil
}

// written is the check after a write, for a delete that landed during it: the
// write may have recreated the directory the delete had just removed, and the
// delete's own removal may have run before the write did. Between the two
// checks every order is covered, because gone is set before that removal.
func (s *Store) written(c *sessionCanvas, sessionID string) error {
	if s.beforeWritten != nil {
		s.beforeWritten(sessionID)
	}
	if err := s.writable(c, sessionID); err != nil {
		s.removeSessionDir(sessionID)
		return err
	}
	return nil
}

func (c *sessionCanvas) load(dir string) error {
	statePath := filepath.Join(dir, stateFileName)
	_, statErr := os.Stat(statePath)

	var file stateFile
	found, err := filestore.ReadJSONOrQuarantine(statePath, "canvas state", &file)
	if err != nil {
		return err
	}
	if !found {
		file = stateFile{}
		if statErr == nil {
			// The state was there and was too damaged to read, so it has just
			// been quarantined. Tool results in the transcript name the
			// revisions it counted, so the numbering goes on after the highest
			// snapshot rather than starting again over them. The reported size
			// is lost; the next message reports it again.
			if file.Revision, err = highestSnapshot(dir); err != nil {
				return err
			}
			// Written back at once: left to the next draw, a restart before it
			// would find no state at all and take that for one never written.
			// A failure only loses that protection, and the next draw writes
			// the state anyway, so it is no reason to refuse the session.
			if err := writeState(dir, file); err != nil {
				slog.Error("failed to write back a recovered canvas state",
					"dir", dir, "revision", file.Revision, "error", err)
			}
		}
		// With no state at all, nothing was ever named: a snapshot left by a
		// crash before the first state was written is overwritten by the next
		// revision, like any snapshot beyond the state's revision.
	}

	c.file = file
	c.current = readableSnapshot(dir, file.Revision)
	return nil
}

// readableSnapshot is the newest snapshot at or below revision that can be
// read, nil when none can. Normally that is revision itself. One lost to the
// disk — a rename a power cut undid — must not make the session impossible to
// open, so the canvas falls back to the revision before it, and says so in the
// log; the numbering still goes on after revision.
func readableSnapshot(dir string, revision int) *Snapshot {
	for r := revision; r >= 1; r-- {
		snap, err := readSnapshot(dir, r)
		if err == nil {
			return &snap
		}
		slog.Error("canvas revision unreadable, falling back to the one before it",
			"dir", dir, "revision", r, "error", err)
	}
	return nil
}

func (c *sessionCanvas) state() State {
	if c.current == nil {
		return State{}
	}
	return c.current.state()
}

// Current is the session's canvas as it is now; revision 0 before anything was
// drawn.
func (s *Store) Current(sessionID string) (State, error) {
	c, err := s.lockedCanvas(sessionID)
	if err != nil {
		return State{}, err
	}
	defer c.canvasMu.Unlock()
	return c.state(), nil
}

// Apply draws a new revision. build is handed the canvas as it is and returns
// the new document, or an error that leaves the canvas as it was; it runs with
// the session's canvas locked, so whatever it decides from the base is still
// true when the result is stored. It must not call back into this store, nor
// into the session store, whose change listeners this store is one of.
//
// It is what canvas_render and canvas_update call: a render returns
// Change{Kind: ChangeRender}, an update Change{Kind: ChangeUpdate, Ops: …}.
// The caller is responsible for the session being a canvas session.
func (s *Store) Apply(sessionID string, build func(Base) (Draft, error)) (Snapshot, error) {
	c, err := s.lockedCanvas(sessionID)
	if err != nil {
		return Snapshot{}, err
	}
	snap, err := s.applyLocked(c, sessionID, build)
	c.canvasMu.Unlock()
	if err != nil {
		return Snapshot{}, err
	}

	// After unlocking, since the push needs nothing the lock guards. Two
	// revisions may then be announced out of order, which costs nothing: each
	// notification carries the whole state, and the highest revision wins.
	s.notify(sessionID, snap.state())
	return snap, nil
}

func (s *Store) applyLocked(c *sessionCanvas, sessionID string, build func(Base) (Draft, error)) (Snapshot, error) {
	// The base is the snapshot actually current, which after a lost snapshot
	// is older than the state's revision (readableSnapshot); the new one is
	// still numbered after the state's, which the transcript has named.
	base := Base{ReportedSize: copySize(c.file.ReportedSize)}
	if c.current != nil {
		base.Revision = c.current.Revision
		base.HTML = c.current.HTML
	}

	draft, err := build(base)
	if err != nil {
		return Snapshot{}, err
	}

	change := draft.Change
	if change.Kind == ChangeUpdate {
		change.FromRevision = base.Revision
	}
	snap := Snapshot{
		Revision: c.file.Revision + 1,
		HTML:     draft.HTML,
		DrawnFor: base.ReportedSize,
		Change:   change,
		DrawnAt:  time.Now().UTC(),
	}

	if err := s.writable(c, sessionID); err != nil {
		return Snapshot{}, err
	}

	// The snapshot first, then the state that names it: a crash between the
	// two leaves a snapshot nothing names yet, which the next revision
	// overwrites. The index line last, because it is only a shortcut —
	// History reads the snapshot of any revision the index lacks.
	dir := Dir(s.dataDir, sessionID)
	data, err := json.Marshal(snap)
	if err != nil {
		return Snapshot{}, fmt.Errorf("encode canvas snapshot: %w", err)
	}
	if err := filestore.WriteFileAtomic(snapshotPath(dir, snap.Revision), data, filePerm); err != nil {
		return Snapshot{}, fmt.Errorf("write canvas snapshot: %w", err)
	}
	file := stateFile{Revision: snap.Revision, ReportedSize: c.file.ReportedSize}
	if err := writeState(dir, file); err != nil {
		return Snapshot{}, err
	}
	if err := filestore.AppendJSONL(filepath.Join(dir, indexFileName), snap.entry()); err != nil {
		slog.Warn("failed to index a canvas revision; history will read its snapshot instead",
			"sessionId", sessionID, "revision", snap.Revision, "error", err)
	}
	if err := s.written(c, sessionID); err != nil {
		return Snapshot{}, err
	}
	c.file = file
	c.current = &snap
	return snap, nil
}

// ReportSize records the size of the user's canvas a message reported, which
// the next revision is recorded as drawn for. It is not pushed: no client
// draws it.
func (s *Store) ReportSize(sessionID string, size Size) error {
	c, err := s.lockedCanvas(sessionID)
	if err != nil {
		return err
	}
	defer c.canvasMu.Unlock()

	if c.file.ReportedSize != nil && *c.file.ReportedSize == size {
		return nil
	}
	if err := s.writable(c, sessionID); err != nil {
		return err
	}
	file := c.file
	file.ReportedSize = &size
	if err := writeState(Dir(s.dataDir, sessionID), file); err != nil {
		return err
	}
	if err := s.written(c, sessionID); err != nil {
		return err
	}
	c.file = file
	return nil
}

// HistoryEntry is one revision as the history list shows it, without its page.
type HistoryEntry struct {
	Revision   int        `json:"revision"`
	ChangeKind ChangeKind `json:"change_kind"`
	DrawnFor   *Size      `json:"drawn_for,omitempty"`
	DrawnAt    time.Time  `json:"drawn_at"`
	// Bytes is the size of the revision's document.
	Bytes int `json:"bytes"`
}

func (s Snapshot) entry() HistoryEntry {
	return HistoryEntry{
		Revision:   s.Revision,
		ChangeKind: s.Change.Kind,
		DrawnFor:   s.DrawnFor,
		DrawnAt:    s.DrawnAt,
		Bytes:      len(s.HTML),
	}
}

// History lists every revision of the session's canvas, newest first.
//
// It reads revisions.jsonl, one small line per revision, rather than every
// snapshot: a long session's pages add up to tens of megabytes. A revision the
// index lacks — its line lost to a crash — is read from its snapshot, and one
// whose snapshot cannot be read either is left out and logged, so one lost
// file does not cost the user the whole list.
func (s *Store) History(sessionID string) ([]HistoryEntry, error) {
	c, err := s.lockedCanvas(sessionID)
	if err != nil {
		return nil, err
	}
	revision := c.file.Revision
	c.canvasMu.Unlock()

	// Read outside the lock: nothing up to the revision just read is ever
	// rewritten, so nothing can change under the reads.
	dir := Dir(s.dataDir, sessionID)
	indexed, err := readIndex(dir)
	if err != nil {
		return nil, err
	}
	entries := make([]HistoryEntry, 0, revision)
	for r := revision; r >= 1; r-- {
		// A stat rather than a read: the line says what the snapshot holds,
		// and only whether it is still there can have changed.
		if e, ok := indexed[r]; ok {
			if _, err := os.Stat(snapshotPath(dir, r)); err == nil {
				entries = append(entries, e)
				continue
			}
		}
		snap, err := readSnapshot(dir, r)
		if err != nil {
			slog.Error("canvas revision unreadable, left out of the history",
				"sessionId", sessionID, "revision", r, "error", err)
			continue
		}
		entries = append(entries, snap.entry())
	}
	return entries, nil
}

func readIndex(dir string) (map[int]HistoryEntry, error) {
	lines, _, err := filestore.ReadJSONL(filepath.Join(dir, indexFileName), 0)
	if err != nil {
		return nil, fmt.Errorf("read canvas index: %w", err)
	}
	indexed := make(map[int]HistoryEntry, len(lines))
	for _, line := range lines {
		var e HistoryEntry
		if err := json.Unmarshal(line, &e); err == nil && e.Revision > 0 {
			indexed[e.Revision] = e
		}
	}
	return indexed, nil
}

// Snapshot reads one revision whole. ErrNoRevision for one the canvas does
// not have yet, or never will.
func (s *Store) Snapshot(sessionID string, revision int) (Snapshot, error) {
	c, err := s.lockedCanvas(sessionID)
	if err != nil {
		return Snapshot{}, err
	}
	current := c.file.Revision
	c.canvasMu.Unlock()

	if revision < 1 || revision > current {
		return Snapshot{}, fmt.Errorf("%w: revision %d, the canvas is at %d", ErrNoRevision, revision, current)
	}
	snap, err := readSnapshot(Dir(s.dataDir, sessionID), revision)
	if errors.Is(err, fs.ErrNotExist) {
		return Snapshot{}, fmt.Errorf("%w: revision %d was lost from disk", ErrNoRevision, revision)
	}
	return snap, err
}

// Fork gives a new session the canvas as it was at revision, with reported as
// its reported size (both from ForkPoint). Revisions 1…revision are hard-linked
// rather than copied, as attachments are: a snapshot is only ever replaced by a
// rename, never written in place, so the two sessions can share the file. The
// fork's next revision is revision + 1; the source's later ones are not taken,
// so the numbers cannot collide.
//
// The fork's canvas is locked throughout, and pushed once copied: a client
// that subscribed to the fork as soon as it was listed was handed the empty
// canvas, and has to hear about this one.
//
// A snapshot below revision the source lost is left out, as the source's own
// history leaves it out. On error the fork is left with no page at all rather
// than part of one — but still numbered after revision, because the history it
// inherited names revisions 1…revision, and a new page under one of those
// numbers would be read back as the page that record drew.
func (s *Store) Fork(sourceID, forkID string, revision int, reported *Size) error {
	if revision == 0 && reported == nil {
		return nil
	}
	c, err := s.lockedCanvas(forkID)
	if err != nil {
		return err
	}
	err = s.writable(c, forkID)
	if err == nil {
		if err = s.fork(sourceID, forkID, revision, reported); err != nil {
			s.forkNumberingOnly(forkID, revision, reported)
		}
		if writtenErr := s.written(c, forkID); writtenErr != nil {
			err = writtenErr
		}
	}
	// Read back from disk on next use, whatever was cached before the copy.
	c.loaded = false
	c.canvasMu.Unlock()
	if err != nil {
		return err
	}

	state, err := s.Current(forkID)
	if err != nil {
		return err
	}
	s.notify(forkID, state)
	return nil
}

func (s *Store) fork(sourceID, forkID string, revision int, reported *Size) error {
	srcDir := Dir(s.dataDir, sourceID)
	dstDir := Dir(s.dataDir, forkID)
	if err := os.MkdirAll(dstDir, 0o755); err != nil {
		return fmt.Errorf("create canvas dir: %w", err)
	}
	copied := 0
	for r := 1; r <= revision; r++ {
		err := linkOrCopy(snapshotPath(srcDir, r), snapshotPath(dstDir, r))
		if errors.Is(err, fs.ErrNotExist) {
			slog.Error("canvas revision lost from disk, left out of the fork",
				"sessionId", forkID, "sourceSessionId", sourceID, "revision", r)
			continue
		}
		if err != nil {
			return fmt.Errorf("copy canvas revision %d: %w", r, err)
		}
		copied++
	}
	if revision > 0 && copied == 0 {
		return fmt.Errorf("copy canvas: none of revisions 1…%d is on disk", revision)
	}
	if err := writeState(dstDir, stateFile{Revision: revision, ReportedSize: copySize(reported)}); err != nil {
		return err
	}
	return forkIndex(srcDir, dstDir, revision)
}

// forkNumberingOnly leaves a fork whose copy failed with no page and the
// numbering going on after revision (see Fork).
func (s *Store) forkNumberingOnly(forkID string, revision int, reported *Size) {
	dir := Dir(s.dataDir, forkID)
	if err := os.RemoveAll(dir); err != nil {
		slog.Error("failed to remove a canvas that could not be copied into a fork",
			"sessionId", forkID, "error", err)
		return
	}
	err := os.MkdirAll(dir, 0o755)
	if err == nil {
		err = writeState(dir, stateFile{Revision: revision, ReportedSize: copySize(reported)})
	}
	if err != nil {
		slog.Error("failed to keep a fork's canvas numbering after a failed copy; its next revision may reuse a number its history names",
			"sessionId", forkID, "revision", revision, "error", err)
	}
}

// forkIndex gives the fork the source's index lines up to revision. Not
// fatal to the fork when it fails: History reads the snapshots instead.
func forkIndex(srcDir, dstDir string, revision int) error {
	indexed, err := readIndex(srcDir)
	if err != nil {
		slog.Warn("failed to copy the canvas index into a fork", "dir", dstDir, "error", err)
		return nil
	}
	var buf bytes.Buffer
	for r := 1; r <= revision; r++ {
		e, ok := indexed[r]
		if !ok {
			continue
		}
		line, err := json.Marshal(e)
		if err != nil {
			return fmt.Errorf("encode canvas index: %w", err)
		}
		buf.Write(line)
		buf.WriteByte('\n')
	}
	if buf.Len() == 0 {
		return nil
	}
	if err := filestore.WriteFileAtomic(filepath.Join(dstDir, indexFileName), buf.Bytes(), filePerm); err != nil {
		slog.Warn("failed to copy the canvas index into a fork", "dir", dstDir, "error", err)
	}
	return nil
}

func linkOrCopy(src, dst string) error {
	err := os.Link(src, dst)
	if err == nil {
		return nil
	}
	// A missing source or an existing destination is a fault a copy would
	// only hide. Anything else is a filesystem that refuses links (or a source
	// on another device), which gets a copy; a snapshot is at most a few
	// hundred kilobytes.
	if errors.Is(err, fs.ErrNotExist) || errors.Is(err, fs.ErrExist) {
		return err
	}
	slog.Debug("hard link refused, copying the canvas revision instead", "src", src, "error", err)
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	return filestore.WriteFileAtomic(dst, data, filePerm)
}

func writeState(dir string, file stateFile) error {
	data, err := json.Marshal(file)
	if err != nil {
		return fmt.Errorf("encode canvas state: %w", err)
	}
	if err := filestore.WriteFileAtomic(filepath.Join(dir, stateFileName), data, filePerm); err != nil {
		return fmt.Errorf("write canvas state: %w", err)
	}
	return nil
}

// readSnapshot reads without a lock: a snapshot is only ever written by a
// rename, so a reader sees a whole file or none.
func readSnapshot(dir string, revision int) (Snapshot, error) {
	data, err := os.ReadFile(snapshotPath(dir, revision))
	if err != nil {
		return Snapshot{}, fmt.Errorf("read canvas revision %d: %w", revision, err)
	}
	var snap Snapshot
	if err := json.Unmarshal(data, &snap); err != nil {
		return Snapshot{}, fmt.Errorf("parse canvas revision %d: %w", revision, err)
	}
	return snap, nil
}

// highestSnapshot is the highest revision with a snapshot file in dir, 0 when
// there is none.
func highestSnapshot(dir string) (int, error) {
	entries, err := os.ReadDir(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("read canvas dir: %w", err)
	}
	highest := 0
	for _, e := range entries {
		name, ok := strings.CutSuffix(e.Name(), snapshotExt)
		if !ok || e.IsDir() {
			continue
		}
		if r, err := strconv.Atoi(name); err == nil {
			highest = max(highest, r)
		}
	}
	return highest, nil
}

func copySize(s *Size) *Size {
	if s == nil {
		return nil
	}
	c := *s
	return &c
}
