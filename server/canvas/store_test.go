package canvas

import (
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/pockode/server/session"
)

func render(html string) func(Base) (Draft, error) {
	return func(Base) (Draft, error) {
		return Draft{HTML: html, Change: Change{Kind: ChangeRender}}, nil
	}
}

func mustApply(t *testing.T, s *Store, sessionID string, build func(Base) (Draft, error)) Snapshot {
	t.Helper()
	snap, err := s.Apply(sessionID, build)
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	return snap
}

func mustCurrent(t *testing.T, s *Store, sessionID string) State {
	t.Helper()
	st, err := s.Current(sessionID)
	if err != nil {
		t.Fatalf("Current: %v", err)
	}
	return st
}

func TestStore_NothingDrawn(t *testing.T) {
	s := NewStore(t.TempDir())
	st := mustCurrent(t, s, "s1")
	if st.Revision != 0 || st.HTML != "" || st.Change != nil || st.DrawnAt != nil || st.DrawnFor != nil {
		t.Errorf("state = %+v, want revision 0 and nothing else", st)
	}
}

func TestStore_ApplyNumbersAndRecordsRevisions(t *testing.T) {
	dataDir := t.TempDir()
	s := NewStore(dataDir)

	var pushed []State
	s.SetOnChange(func(sessionID string, st State) {
		if sessionID != "s1" {
			t.Errorf("pushed for %q", sessionID)
		}
		pushed = append(pushed, st)
	})

	first := mustApply(t, s, "s1", render("<p>one</p>"))
	if first.Revision != 1 || first.DrawnFor != nil || first.Change.Kind != ChangeRender {
		t.Errorf("first = %+v", first)
	}

	if err := s.ReportSize("s1", Size{Width: 390, Height: 664}); err != nil {
		t.Fatalf("ReportSize: %v", err)
	}

	empty := ""
	ops := []Op{{Op: OpReplace, Region: "r", HTML: &empty}, {Op: OpRemove, Region: "x"}}
	second := mustApply(t, s, "s1", func(b Base) (Draft, error) {
		if b.Revision != 1 || b.HTML != "<p>one</p>" {
			t.Errorf("base = %+v, want revision 1 with the first page", b)
		}
		if b.ReportedSize == nil || *b.ReportedSize != (Size{Width: 390, Height: 664}) {
			t.Errorf("base reported size = %+v", b.ReportedSize)
		}
		return Draft{HTML: "<p>two</p>", Change: Change{Kind: ChangeUpdate, Ops: ops}}, nil
	})
	if second.Revision != 2 || second.Change.FromRevision != 1 {
		t.Errorf("second = %+v, want revision 2 from 1", second)
	}
	if second.DrawnFor == nil || *second.DrawnFor != (Size{Width: 390, Height: 664}) {
		t.Errorf("drawn_for = %+v, want the reported size", second.DrawnFor)
	}

	if len(pushed) != 2 || pushed[1].Revision != 2 || pushed[1].HTML != "<p>two</p>" {
		t.Fatalf("pushed = %+v", pushed)
	}

	// A store opened afresh reads the same state back from disk.
	reopened := NewStore(dataDir)
	st := mustCurrent(t, reopened, "s1")
	if st.Revision != 2 || st.HTML != "<p>two</p>" || st.Change == nil || st.Change.FromRevision != 1 || len(st.Change.Ops) != 2 {
		t.Errorf("reloaded state = %+v", st)
	}
	if st.Change.Ops[0].HTML == nil || st.Change.Ops[1].HTML != nil {
		t.Errorf("ops lost the empty replace / absent remove html: %+v", st.Change.Ops)
	}
	third := mustApply(t, reopened, "s1", render("<p>three</p>"))
	if third.Revision != 3 || third.DrawnFor == nil {
		t.Errorf("third after reload = %+v, want revision 3 still drawn for the reported size", third)
	}
}

func TestStore_RefusedBuildChangesNothing(t *testing.T) {
	s := NewStore(t.TempDir())
	pushes := 0
	s.SetOnChange(func(string, State) { pushes++ })
	mustApply(t, s, "s1", render("<p>one</p>"))

	refusal := errors.New("lint failed")
	if _, err := s.Apply("s1", func(Base) (Draft, error) { return Draft{}, refusal }); !errors.Is(err, refusal) {
		t.Fatalf("Apply error = %v, want the build's", err)
	}
	if st := mustCurrent(t, s, "s1"); st.Revision != 1 || st.HTML != "<p>one</p>" {
		t.Errorf("state after refusal = %+v", st)
	}
	if pushes != 1 {
		t.Errorf("pushes = %d, want only the successful one", pushes)
	}
	if next := mustApply(t, s, "s1", render("<p>two</p>")); next.Revision != 2 {
		t.Errorf("next revision = %d, want 2: a refusal takes no number", next.Revision)
	}
}

// Parallel calls in one turn apply one after the other, each on the previous
// one's result (docs/canvas-ui.md §3.2).
func TestStore_ApplySerializedPerSession(t *testing.T) {
	s := NewStore(t.TempDir())
	mustApply(t, s, "s1", render("x"))

	const n = 20
	var wg sync.WaitGroup
	for range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := s.Apply("s1", func(b Base) (Draft, error) {
				return Draft{HTML: b.HTML + "x", Change: Change{Kind: ChangeUpdate}}, nil
			}); err != nil {
				t.Errorf("Apply: %v", err)
			}
		}()
	}
	wg.Wait()

	st := mustCurrent(t, s, "s1")
	if st.Revision != n+1 || len(st.HTML) != n+1 {
		t.Errorf("revision %d with %d bytes, want %d of each", st.Revision, len(st.HTML), n+1)
	}
}

// A crash between the snapshot and the state leaves a snapshot nothing names;
// the next revision takes its number and overwrites it.
func TestStore_UnnamedSnapshotIsOverwritten(t *testing.T) {
	dataDir := t.TempDir()
	s := NewStore(dataDir)
	mustApply(t, s, "s1", render("one"))

	stray := snapshotPath(Dir(dataDir, "s1"), 2)
	if err := os.WriteFile(stray, []byte(`{"revision":2,"html":"never named"}`), 0o644); err != nil {
		t.Fatal(err)
	}

	reopened := NewStore(dataDir)
	if st := mustCurrent(t, reopened, "s1"); st.Revision != 1 {
		t.Fatalf("revision = %d, want 1: state.json never named 2", st.Revision)
	}
	mustApply(t, reopened, "s1", render("two"))
	snap, err := reopened.Snapshot("s1", 2)
	if err != nil || snap.HTML != "two" {
		t.Errorf("revision 2 = %+v, %v; want the new page", snap, err)
	}
}

// A state.json that is gone or unreadable must not restart the numbering over
// snapshots the transcript's tool results still name.
func TestStore_LostStateKeepsNumbering(t *testing.T) {
	dataDir := t.TempDir()
	s := NewStore(dataDir)
	mustApply(t, s, "s1", render("one"))
	mustApply(t, s, "s1", render("two"))

	statePath := filepath.Join(Dir(dataDir, "s1"), stateFileName)
	if err := os.WriteFile(statePath, []byte("{broken"), 0o644); err != nil {
		t.Fatal(err)
	}

	reopened := NewStore(dataDir)
	if st := mustCurrent(t, reopened, "s1"); st.Revision != 2 || st.HTML != "two" {
		t.Errorf("state = %+v, want revision 2 recovered from its snapshot", st)
	}
	// The recovery is on disk: a restart before anything else is written does
	// not take the quarantined state for one never written.
	again := NewStore(dataDir)
	if st := mustCurrent(t, again, "s1"); st.Revision != 2 {
		t.Errorf("state after a second restart = %+v, want revision 2", st)
	}
	if next := mustApply(t, again, "s1", render("three")); next.Revision != 3 {
		t.Errorf("next revision = %d, want 3", next.Revision)
	}
}

func TestStore_HistoryAndSnapshot(t *testing.T) {
	s := NewStore(t.TempDir())
	mustApply(t, s, "s1", render("one"))
	if err := s.ReportSize("s1", Size{Width: 400, Height: 700}); err != nil {
		t.Fatal(err)
	}
	mustApply(t, s, "s1", func(Base) (Draft, error) {
		return Draft{HTML: "two!", Change: Change{Kind: ChangeUpdate}}, nil
	})

	entries, err := s.History("s1")
	if err != nil {
		t.Fatalf("History: %v", err)
	}
	if len(entries) != 2 {
		t.Fatalf("entries = %+v", entries)
	}
	if e := entries[0]; e.Revision != 2 || e.ChangeKind != ChangeUpdate || e.Bytes != 4 || e.DrawnFor == nil || e.DrawnAt.IsZero() {
		t.Errorf("newest entry = %+v", e)
	}
	if e := entries[1]; e.Revision != 1 || e.ChangeKind != ChangeRender || e.Bytes != 3 || e.DrawnFor != nil {
		t.Errorf("oldest entry = %+v", e)
	}

	snap, err := s.Snapshot("s1", 1)
	if err != nil || snap.HTML != "one" {
		t.Errorf("Snapshot(1) = %+v, %v", snap, err)
	}
	for _, rev := range []int{0, 3} {
		if _, err := s.Snapshot("s1", rev); !errors.Is(err, ErrNoRevision) {
			t.Errorf("Snapshot(%d) error = %v, want ErrNoRevision", rev, err)
		}
	}
}

func TestStore_Fork(t *testing.T) {
	dataDir := t.TempDir()
	s := NewStore(dataDir)
	for _, html := range []string{"one", "two", "three"} {
		mustApply(t, s, "src", render(html))
	}

	size := &Size{Width: 390, Height: 664}
	if err := s.Fork("src", "fork", 2, size); err != nil {
		t.Fatalf("Fork: %v", err)
	}

	st := mustCurrent(t, s, "fork")
	if st.Revision != 2 || st.HTML != "two" {
		t.Errorf("fork state = %+v, want revision 2", st)
	}
	if _, err := os.Stat(snapshotPath(Dir(dataDir, "fork"), 3)); !os.IsNotExist(err) {
		t.Errorf("revision 3 was copied into the fork: %v", err)
	}

	// Past the source's revision 3, which the fork's agent may remember.
	next := mustApply(t, s, "fork", render("fork's own"))
	if next.Revision != 4 || next.DrawnFor == nil || *next.DrawnFor != *size {
		t.Errorf("fork's next = %+v, want revision 4 drawn for the inherited size", next)
	}
	if snap, err := s.Snapshot("src", 3); err != nil || snap.HTML != "three" {
		t.Errorf("source's revision 3 = %+v, %v; the fork must not touch it", snap, err)
	}
	if snap, err := s.Snapshot("fork", 1); err != nil || snap.HTML != "one" {
		t.Errorf("fork's revision 1 = %+v, %v", snap, err)
	}
}

// A copy that fails leaves the fork with no page, not part of one, but still
// numbered after the revisions its inherited history names.
func TestStore_ForkFailureKeepsTheNumbering(t *testing.T) {
	s := NewStore(t.TempDir())

	if err := s.Fork("src", "fork", 2, nil); err == nil {
		t.Fatal("Fork of revisions the source does not have succeeded")
	}
	if st := mustCurrent(t, s, "fork"); st.Revision != 0 {
		t.Errorf("fork state = %+v, want nothing drawn", st)
	}
	if note, _ := s.ForkNote("fork"); note != forkNoteUncopied {
		t.Errorf("fork note = %q, want the one saying the canvas is empty", note)
	}
	if next := mustApply(t, s, "fork", render("fresh")); next.Revision != 3 {
		t.Errorf("fork's next revision = %d, want 3: 1 and 2 are named by its history", next.Revision)
	}
}

// Every fork numbers on from its source's next-revision floor, a fork of a
// fork that has not drawn yet included, and its first delivery is told which
// page is on the canvas (docs/canvas-ui.md §13.6).
func TestStore_ForkNumbersPastTheSourceAndLeavesANote(t *testing.T) {
	s := NewStore(t.TempDir())
	for _, html := range []string{"one", "two", "three", "four", "five"} {
		mustApply(t, s, "src", render(html))
	}

	if err := s.Fork("src", "fork", 2, nil); err != nil {
		t.Fatalf("Fork: %v", err)
	}
	note, err := s.ForkNote("fork")
	if err != nil || note != forkNoteAt(2) {
		t.Errorf("fork note = %q, %v; want it to name revision 2", note, err)
	}
	if err := s.ForkNoteDelivered("fork", "an older note"); err != nil {
		t.Fatal(err)
	}
	if again, _ := s.ForkNote("fork"); again != note {
		t.Errorf("a note other than the stored one cleared it: %q", again)
	}
	if err := s.ForkNoteDelivered("fork", note); err != nil {
		t.Fatal(err)
	}
	// Read from disk, as after a restart.
	if again, _ := NewStore(s.dataDir).ForkNote("fork"); again != "" {
		t.Errorf("fork note = %q after it was delivered, want none", again)
	}

	// The fork has drawn nothing yet: its revision is still 2, its floor 5.
	if err := s.Fork("fork", "fork2", 1, nil); err != nil {
		t.Fatalf("Fork of the fork: %v", err)
	}
	if next := mustApply(t, s, "fork2", render("own")); next.Revision != 6 {
		t.Errorf("fork of a fork numbered %d, want 6: past everything its source's agent may remember", next.Revision)
	}
	if next := mustApply(t, s, "fork", render("own")); next.Revision != 6 {
		t.Errorf("fork numbered %d, want 6", next.Revision)
	}
	// 3…5 are the source's pages past the cut: never this canvas's, not lost.
	entries, err := s.History("fork")
	if err != nil {
		t.Fatalf("History: %v", err)
	}
	var listed []int
	for _, e := range entries {
		listed = append(listed, e.Revision)
	}
	if !slices.Equal(listed, []int{6, 2, 1}) {
		t.Errorf("fork's history = %v, want [6 2 1]", listed)
	}
	if _, err := s.Snapshot("fork", 4); !errors.Is(err, ErrNoRevision) || !strings.Contains(err.Error(), "not carried into this session") {
		t.Errorf("Snapshot(4) error = %v, want one saying it was not carried into the fork", err)
	}
	// A page it did copy and then lost is lost, not uncarried.
	if err := os.Remove(snapshotPath(Dir(s.dataDir, "fork"), 1)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Snapshot("fork", 1); !errors.Is(err, ErrNoRevision) || !strings.Contains(err.Error(), "lost from disk") {
		t.Errorf("Snapshot(1) error = %v, want one saying it was lost from disk", err)
	}

	// A cut before the first page copies nothing and says nothing, but still
	// numbers past the source.
	if err := s.Fork("src", "fork3", 0, nil); err != nil {
		t.Fatalf("Fork at revision 0: %v", err)
	}
	if note, _ := s.ForkNote("fork3"); note != "" {
		t.Errorf("fork with no page has a note: %q", note)
	}
	if st := mustCurrent(t, s, "fork3"); st.Revision != 0 {
		t.Errorf("fork3 state = %+v, want nothing drawn", st)
	}
	if next := mustApply(t, s, "fork3", render("own")); next.Revision != 6 {
		t.Errorf("fork at revision 0 numbered %d, want 6", next.Revision)
	}
}

// A source whose canvas cannot be read — deleted while the fork was made —
// still leaves the fork numbered past the records it inherited, and its agent
// told the canvas is empty.
func TestStore_ForkFromAnUnreadableSource(t *testing.T) {
	s := NewStore(t.TempDir())
	mustApply(t, s, "src", render("one"))
	mustApply(t, s, "src", render("two"))
	s.OnSessionChange(session.SessionChangeEvent{Op: session.OperationDelete, Session: session.SessionMeta{ID: "src"}})

	if err := s.Fork("src", "fork", 2, nil); err == nil {
		t.Fatal("Fork from a deleted source succeeded")
	}
	if note, _ := s.ForkNote("fork"); note != forkNoteUncopied {
		t.Errorf("fork note = %q, want the one saying the canvas is empty", note)
	}
	if next := mustApply(t, s, "fork", render("fresh")); next.Revision != 3 {
		t.Errorf("fork's next revision = %d, want 3: 1 and 2 are named by its history", next.Revision)
	}
}

// A revision the source lost is left out of the fork, as out of the source's
// own history; the rest is copied.
func TestStore_ForkSkipsALostRevision(t *testing.T) {
	dataDir := t.TempDir()
	s := NewStore(dataDir)
	for _, html := range []string{"one", "two", "three"} {
		mustApply(t, s, "src", render(html))
	}
	if err := os.Remove(snapshotPath(Dir(dataDir, "src"), 1)); err != nil {
		t.Fatal(err)
	}

	if err := s.Fork("src", "fork", 3, nil); err != nil {
		t.Fatalf("Fork: %v", err)
	}
	if st := mustCurrent(t, s, "fork"); st.Revision != 3 || st.HTML != "three" {
		t.Errorf("fork state = %+v, want revision 3", st)
	}
	history, err := s.History("fork")
	if err != nil {
		t.Fatalf("History: %v", err)
	}
	if len(history) != 2 || history[0].Revision != 3 || history[1].Revision != 2 {
		t.Errorf("fork history = %+v, want revisions 3 and 2", history)
	}
}

// A deleted session's canvas is gone, and a write still on its way — a tool
// call that was already running — must not bring its directory back.
func TestStore_DeletedSessionTakesNoWrites(t *testing.T) {
	dataDir := t.TempDir()
	s := NewStore(dataDir)
	mustApply(t, s, "s1", render("one"))

	sessionDir := filepath.Join(dataDir, "sessions", "s1")
	if err := os.RemoveAll(sessionDir); err != nil {
		t.Fatal(err)
	}
	s.OnSessionChange(session.SessionChangeEvent{Op: session.OperationDelete, Session: session.SessionMeta{ID: "s1"}})

	if _, err := s.Apply("s1", render("two")); !errors.Is(err, session.ErrSessionNotFound) {
		t.Errorf("Apply after delete: %v, want ErrSessionNotFound", err)
	}
	if err := s.ReportSize("s1", Size{Width: 1, Height: 1}); !errors.Is(err, session.ErrSessionNotFound) {
		t.Errorf("ReportSize after delete: %v, want ErrSessionNotFound", err)
	}
	if _, err := os.Stat(sessionDir); !os.IsNotExist(err) {
		t.Errorf("the deleted session's directory came back: %v", err)
	}
}

// A write that finished before the delete was announced recreated nothing the
// delete leaves behind: the store removes the directory again.
func TestStore_DeleteRemovesWhatAWriteRecreated(t *testing.T) {
	dataDir := t.TempDir()
	s := NewStore(dataDir)
	// The session store's RemoveAll already ran; this write came after it.
	mustApply(t, s, "s1", render("one"))
	s.OnSessionChange(session.SessionChangeEvent{Op: session.OperationDelete, Session: session.SessionMeta{ID: "s1"}})
	if _, err := os.Stat(filepath.Join(dataDir, "sessions", "s1")); !os.IsNotExist(err) {
		t.Errorf("the recreated directory survived the delete: %v", err)
	}
}

// The delete can land after a write's check and before its end: the write
// recreated the directory the delete had removed, and removes it again.
func TestStore_DeleteDuringWrite(t *testing.T) {
	tests := []struct {
		name string
		// target is the session written to, and deleted mid-write.
		target string
		write  func(s *Store) error
	}{
		{"apply", "s1", func(s *Store) error { _, err := s.Apply("s1", render("two")); return err }},
		{"report size", "s1", func(s *Store) error { return s.ReportSize("s1", Size{Width: 2, Height: 2}) }},
		{"fork", "fork", func(s *Store) error { return s.Fork("s1", "fork", 1, nil) }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dataDir := t.TempDir()
			s := NewStore(dataDir)
			mustApply(t, s, "s1", render("one"))

			s.beforeWritten = func(sessionID string) {
				if sessionID != tt.target {
					return
				}
				// The session store's order: its RemoveAll ran before the
				// write recreated the directory, and its listener runs now —
				// whose own removal, run first, the write then undid.
				s.OnSessionChange(session.SessionChangeEvent{Op: session.OperationDelete, Session: session.SessionMeta{ID: sessionID}})
				if err := os.MkdirAll(Dir(dataDir, sessionID), 0o755); err != nil {
					t.Fatal(err)
				}
			}
			if err := tt.write(s); !errors.Is(err, session.ErrSessionNotFound) {
				t.Errorf("write = %v, want ErrSessionNotFound", err)
			}
			if _, err := os.Stat(filepath.Join(dataDir, "sessions", tt.target)); !os.IsNotExist(err) {
				t.Errorf("the deleted session's directory survived: %v", err)
			}
		})
	}
}

// The delete can land while a build is running, holding the session's canvas.
func TestStore_DeleteDuringApply(t *testing.T) {
	dataDir := t.TempDir()
	s := NewStore(dataDir)
	mustApply(t, s, "s1", render("one"))
	sessionDir := filepath.Join(dataDir, "sessions", "s1")

	_, err := s.Apply("s1", func(Base) (Draft, error) {
		if err := os.RemoveAll(sessionDir); err != nil {
			t.Fatal(err)
		}
		// Must not wait for this Apply: the session store calls it with its
		// own lock held.
		s.OnSessionChange(session.SessionChangeEvent{Op: session.OperationDelete, Session: session.SessionMeta{ID: "s1"}})
		return Draft{HTML: "two", Change: Change{Kind: ChangeRender}}, nil
	})
	if !errors.Is(err, session.ErrSessionNotFound) {
		t.Errorf("Apply = %v, want ErrSessionNotFound", err)
	}
	if _, err := os.Stat(sessionDir); !os.IsNotExist(err) {
		t.Errorf("the deleted session's directory came back: %v", err)
	}
}

// A crash before the first state was written leaves a snapshot nothing ever
// named; it is not adopted, and the next revision overwrites it.
func TestStore_SnapshotWithNoStateIsNotAdopted(t *testing.T) {
	dataDir := t.TempDir()
	dir := Dir(dataDir, "s1")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(snapshotPath(dir, 1), []byte(`{"revision":1,"html":"never named"}`), 0o644); err != nil {
		t.Fatal(err)
	}

	s := NewStore(dataDir)
	if st := mustCurrent(t, s, "s1"); st.Revision != 0 {
		t.Fatalf("state = %+v, want nothing drawn", st)
	}
	if snap := mustApply(t, s, "s1", render("first")); snap.Revision != 1 {
		t.Errorf("revision = %d, want 1", snap.Revision)
	}
}

// One snapshot lost to the disk must not make the session impossible to open:
// the canvas falls back to the revision before it, and the numbering goes on.
func TestStore_LostCurrentSnapshotFallsBack(t *testing.T) {
	dataDir := t.TempDir()
	s := NewStore(dataDir)
	mustApply(t, s, "s1", render("one"))
	mustApply(t, s, "s1", render("two"))
	if err := os.Remove(snapshotPath(Dir(dataDir, "s1"), 2)); err != nil {
		t.Fatal(err)
	}

	reopened := NewStore(dataDir)
	if st := mustCurrent(t, reopened, "s1"); st.Revision != 1 || st.HTML != "one" {
		t.Errorf("state = %+v, want revision 1", st)
	}
	if next := mustApply(t, reopened, "s1", render("three")); next.Revision != 3 {
		t.Errorf("next revision = %d, want 3: revision 2 was named", next.Revision)
	}

	// The lost revision is left out of the history, though the index lists
	// it, and reading it is refused rather than failing.
	entries, err := reopened.History("s1")
	if err != nil {
		t.Fatalf("History: %v", err)
	}
	if len(entries) != 2 || entries[0].Revision != 3 || entries[1].Revision != 1 {
		t.Errorf("history = %+v, want revisions 3 and 1", entries)
	}
	if _, err := reopened.Snapshot("s1", 2); !errors.Is(err, ErrNoRevision) {
		t.Errorf("Snapshot(2) = %v, want ErrNoRevision", err)
	}
}

// An update drawn over a fallen-back canvas came from the revision actually
// shown, not from the one that was lost.
func TestStore_UpdateAfterFallbackNamesItsBase(t *testing.T) {
	dataDir := t.TempDir()
	s := NewStore(dataDir)
	mustApply(t, s, "s1", render("one"))
	mustApply(t, s, "s1", render("two"))
	if err := os.Remove(snapshotPath(Dir(dataDir, "s1"), 2)); err != nil {
		t.Fatal(err)
	}

	reopened := NewStore(dataDir)
	snap := mustApply(t, reopened, "s1", func(b Base) (Draft, error) {
		if b.Revision != 1 || b.HTML != "one" {
			t.Errorf("base = %+v, want revision 1", b)
		}
		return Draft{HTML: b.HTML + "!", Change: Change{Kind: ChangeUpdate}}, nil
	})
	if snap.Revision != 3 || snap.Change.FromRevision != 1 {
		t.Errorf("snapshot = %+v, want revision 3 from 1", snap)
	}
}

// The index is a shortcut: without it the history is read from the snapshots,
// leaving out only what cannot be read.
func TestStore_HistoryWithoutIndex(t *testing.T) {
	dataDir := t.TempDir()
	s := NewStore(dataDir)
	for _, html := range []string{"one", "two", "three"} {
		mustApply(t, s, "s1", render(html))
	}
	dir := Dir(dataDir, "s1")
	if err := os.Remove(filepath.Join(dir, indexFileName)); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(snapshotPath(dir, 2), []byte("{broken"), 0o644); err != nil {
		t.Fatal(err)
	}

	entries, err := s.History("s1")
	if err != nil {
		t.Fatalf("History: %v", err)
	}
	if len(entries) != 2 || entries[0].Revision != 3 || entries[1].Revision != 1 || entries[0].Bytes != 5 {
		t.Errorf("history = %+v, want revisions 3 and 1", entries)
	}
}

// A client may have subscribed to the fork as soon as it was listed, and was
// handed an empty canvas; the copied one is pushed.
func TestStore_ForkPushesTheCopiedCanvas(t *testing.T) {
	s := NewStore(t.TempDir())
	mustApply(t, s, "src", render("one"))
	if st := mustCurrent(t, s, "fork"); st.Revision != 0 {
		t.Fatalf("fork before the copy = %+v", st)
	}

	var pushed []State
	s.SetOnChange(func(id string, st State) {
		if id == "fork" {
			pushed = append(pushed, st)
		}
	})
	if err := s.Fork("src", "fork", 1, nil); err != nil {
		t.Fatalf("Fork: %v", err)
	}
	if len(pushed) != 1 || pushed[0].Revision != 1 || pushed[0].HTML != "one" {
		t.Errorf("pushed = %+v, want revision 1", pushed)
	}
	if st := mustCurrent(t, s, "fork"); st.Revision != 1 {
		t.Errorf("fork state = %+v: the cache read before the copy survived it", st)
	}
	if entries, err := s.History("fork"); err != nil || len(entries) != 1 {
		t.Errorf("fork history = %+v, %v", entries, err)
	}
}

// A fork cut before anything was drawn still keeps the size the user reported.
func TestStore_ForkOfASizeAlone(t *testing.T) {
	s := NewStore(t.TempDir())
	if err := s.Fork("src", "fork", 0, &Size{Width: 390, Height: 664}); err != nil {
		t.Fatalf("Fork: %v", err)
	}
	snap := mustApply(t, s, "fork", render("first"))
	if snap.Revision != 1 || snap.DrawnFor == nil || *snap.DrawnFor != (Size{Width: 390, Height: 664}) {
		t.Errorf("first revision of the fork = %+v", snap)
	}
}
