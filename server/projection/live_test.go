package projection

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pockode/server/session"
)

// rawRecord writes a record body as given, for appending test lines through a
// real store.
type rawRecord json.RawMessage

func (r rawRecord) MarshalJSON() ([]byte, error) { return r, nil }
func (rawRecord) HistoryRecord()                 {}

// liveLines is a session's history as the tests append it: "turn|record", as
// history takes them.
var liveLines = []string{
	prompt1, started1,
	`T1|{"type":"text","content":"working"}`,
	asked, askedQ2,
	`T1|{"type":"plan","tool_use_id":"c1","steps":[{"id":"1","text":"a","status":"pending"}]}`,
	answer1In,
	prompt2,
	`T1|{"type":"message_ingested","message_id":"m2"}`,
	`T1|{"type":"done"}`,
	started2,
	`T2|{"type":"request_cancelled","request_id":"q2","reason":"work_closed"}`,
	`-|{"type":"message","content":"last","message_id":"m4"}`,
}

func newTracked(t *testing.T) (*session.FileStore, *Live) {
	t.Helper()
	store, err := session.NewFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return store, Track(store)
}

func createSession(t *testing.T, store *session.FileStore, id string) {
	t.Helper()
	if _, err := store.Create(context.Background(), id, session.CreateSpec{AgentType: session.AgentTypeClaude}); err != nil {
		t.Fatal(err)
	}
}

func appendLine(t *testing.T, store *session.FileStore, id, line string) {
	t.Helper()
	turn, rec, _ := strings.Cut(line, "|")
	tag := session.InTurn(turn)
	switch turn {
	case "null":
		tag = session.NoTurn
	case "-":
		tag = session.HistoryTurn{}
	}
	if _, err := store.AppendToHistory(context.Background(), id, rawRecord(rec), tag); err != nil {
		t.Error(err)
	}
}

// fileState is the projection of what the store's file holds now.
func fileState(t *testing.T, store *session.FileStore, id string) State {
	t.Helper()
	records, err := store.GetHistory(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	return Fold(records, session.AgentTypeClaude).State()
}

// writtenFileState is writtenState of what the store's file holds now: the
// fold of the file, but for a history of nothing but messages, which Live
// knows it has just written (Projection.AppendWritten).
func writtenFileState(t *testing.T, store *session.FileStore, id string) State {
	t.Helper()
	records, err := store.GetHistory(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	return writtenState(records)
}

// resident says Live keeps a folded projection of the session.
func resident(l *Live, id string) bool {
	e := l.lookup(id)
	if e == nil {
		return false
	}
	e.foldMu.Lock()
	defer e.foldMu.Unlock()
	return e.loaded
}

func liveState(t *testing.T, l *Live, id string) State {
	t.Helper()
	s, err := l.State(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// TestLive_IsTheFoldOfTheFile: whenever a session is first read — before any
// record, part way, after all — and however many records are appended after,
// what Live holds is the fold of the file as it stands.
func TestLive_IsTheFoldOfTheFile(t *testing.T) {
	for firstRead := 0; firstRead <= len(liveLines); firstRead++ {
		store, l := newTracked(t)
		createSession(t, store, "s")
		l.Hold("s")
		for i, line := range liveLines {
			if i == firstRead {
				liveState(t, l, "s")
				if !resident(l, "s") {
					t.Fatal("a held session read is not kept")
				}
			}
			appendLine(t, store, "s", line)
			if i >= firstRead {
				if got, want := liveState(t, l, "s"), writtenFileState(t, store, "s"); !reflect.DeepEqual(got, want) {
					t.Fatalf("first read before record %d, after record %d:\n  live %+v\n  file %+v", firstRead, i, got, want)
				}
			}
		}
		if got, want := liveState(t, l, "s"), fileState(t, store, "s"); !reflect.DeepEqual(got, want) {
			t.Errorf("first read before record %d, at the end:\n  live %+v\n  file %+v", firstRead, got, want)
		}
	}
}

// TestLive_ReadsSeeEveryReturnedAppend: with appends and first reads racing,
// a read holds every record whose append returned before it started, and is
// the fold of some prefix of the file — never a record twice or out of order.
func TestLive_ReadsSeeEveryReturnedAppend(t *testing.T) {
	for round := 0; round < 20; round++ {
		store, l := newTracked(t)
		createSession(t, store, "s")
		l.Hold("s")
		records := history(liveLines...)
		prefixes := make([][]State, len(records)+1)
		for i := range prefixes {
			prefixes[i] = readings(records[:i])
		}

		var appended sync.Mutex
		returned := 0
		done := make(chan struct{})
		go func() {
			defer close(done)
			for _, line := range liveLines {
				appendLine(t, store, "s", line)
				appended.Lock()
				returned++
				appended.Unlock()
			}
		}()

		var readers sync.WaitGroup
		for r := 0; r < 4; r++ {
			readers.Add(1)
			go func() {
				defer readers.Done()
				for {
					appended.Lock()
					atLeast := returned
					appended.Unlock()
					s, err := l.State(context.Background(), "s")
					if err != nil {
						t.Error(err)
						return
					}
					if !matchesPrefix(s, prefixes[atLeast:]) {
						t.Errorf("round %d: a read after %d appends returned is no prefix of at least that many:\n  %+v", round, atLeast, s)
						return
					}
					select {
					case <-done:
						return
					default:
					}
				}
			}()
		}
		readers.Wait()
		<-done
		if got, want := liveState(t, l, "s"), prefixes[len(records)][0]; !reflect.DeepEqual(got, want) {
			t.Errorf("round %d: at the end:\n  live %+v\n  file %+v", round, got, want)
		}
	}
}

func matchesPrefix(s State, prefixes [][]State) bool {
	for _, readings := range prefixes {
		for _, p := range readings {
			if reflect.DeepEqual(s, p) {
				return true
			}
		}
	}
	return false
}

// writtenState is the projection of records as Live folds them when it hears
// of each as it is written (Projection.AppendWritten).
func writtenState(records []json.RawMessage) State {
	p := New(session.AgentTypeClaude)
	for _, raw := range records {
		p.AppendWritten(raw)
	}
	return p.State()
}

// readings are what a read of a history holding records can say: what Live
// holds when it heard of them as written — the first —, or what it reads off
// the file when it loads right then. The two differ while the history is
// nothing but messages, which the file cannot tell the version of
// (agent.TurnInference).
func readings(records []json.RawMessage) []State {
	return []State{writtenState(records), Fold(records, session.AgentTypeClaude).State()}
}

// TestLive_Lifecycle: a projection is let go with the history it describes —
// a deleted session has none, a replaced history is read again, and a session
// created again under a deleted one's id starts from nothing.
func TestLive_Lifecycle(t *testing.T) {
	ctx := context.Background()
	store, l := newTracked(t)
	createSession(t, store, "s")
	l.Hold("s")
	for _, line := range liveLines {
		appendLine(t, store, "s", line)
	}
	liveState(t, l, "s")

	t.Run("replaced", func(t *testing.T) {
		if err := store.WriteHistory(ctx, "s", history(prompt1, started1)); err != nil {
			t.Fatal(err)
		}
		if got, want := liveState(t, l, "s"), fileState(t, store, "s"); !reflect.DeepEqual(got, want) {
			t.Errorf("after WriteHistory:\n  live %+v\n  file %+v", got, want)
		}
		appendLine(t, store, "s", `T1|{"type":"done"}`)
		assertStrings(t, "turns after appending to the replaced history", turnsShape(liveState(t, l, "s")), []string{"T1:completed"})
	})

	t.Run("deleted", func(t *testing.T) {
		if err := store.Delete(ctx, "s"); err != nil {
			t.Fatal(err)
		}
		if _, err := l.State(ctx, "s"); !errors.Is(err, session.ErrSessionNotFound) {
			t.Errorf("State of a deleted session: err = %v, want ErrSessionNotFound", err)
		}
		if n := len(l.sessions); n != 0 {
			t.Errorf("%d projections held after the only session was deleted", n)
		}
	})

	t.Run("created again", func(t *testing.T) {
		createSession(t, store, "s")
		if got := liveState(t, l, "s"); !reflect.DeepEqual(got, Fold(nil, session.AgentTypeClaude).State()) {
			t.Errorf("a session created again under a deleted id: %+v", got)
		}
	})
}

// TestFromReader_IsTheSameProjection: a directory read without a store has
// the projection its store holds.
func TestFromReader_IsTheSameProjection(t *testing.T) {
	dir := t.TempDir()
	store, err := session.NewFileStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	l := Track(store)
	createSession(t, store, "s")
	for _, line := range liveLines {
		appendLine(t, store, "s", line)
	}

	got, err := FromReader(session.NewDirReader(dir)).State(context.Background(), "s")
	if err != nil {
		t.Fatal(err)
	}
	if want := liveState(t, l, "s"); !reflect.DeepEqual(got, want) {
		t.Errorf("DirReader:\n  %+v\nlive:\n  %+v", got, want)
	}
	if _, err := FromReader(session.NewDirReader(dir)).State(context.Background(), "nope"); !errors.Is(err, session.ErrSessionNotFound) {
		t.Errorf("unknown session: err = %v, want ErrSessionNotFound", err)
	}
}

// interposed lets a test act between a store writing a record and Live
// hearing of it (before), just after a reset reaches Live (afterReset), and
// hand Live's next Get a session as it was earlier (staleGet).
type interposed struct {
	*session.FileStore
	before     func()
	afterReset func()
	staleGet   *session.SessionMeta
	// afterRead runs once a history read has its records.
	afterRead func()
	// reads counts the history reads.
	reads atomic.Int32
}

func (s *interposed) GetHistory(ctx context.Context, sessionID string) ([]json.RawMessage, error) {
	s.reads.Add(1)
	records, err := s.FileStore.GetHistory(ctx, sessionID)
	if f := s.afterRead; f != nil {
		s.afterRead = nil
		f()
	}
	return records, err
}

func (s *interposed) Get(sessionID string) (session.SessionMeta, bool, error) {
	if meta := s.staleGet; meta != nil {
		s.staleGet = nil
		return *meta, true, nil
	}
	return s.FileStore.Get(sessionID)
}

func (s *interposed) SetHistoryObserver(o session.HistoryObserver) {
	s.FileStore.SetHistoryObserver(observerFunc{o, s})
}

type observerFunc struct {
	session.HistoryObserver
	s *interposed
}

func (o observerFunc) HistoryAppended(sessionID string, seq session.HistorySeq, line json.RawMessage) {
	if o.s.before != nil {
		o.s.before()
	}
	o.HistoryObserver.HistoryAppended(sessionID, seq, line)
}

func (o observerFunc) HistoryReset(sessionID string) {
	o.HistoryObserver.HistoryReset(sessionID)
	if f := o.s.afterReset; f != nil {
		o.s.afterReset = nil
		f()
	}
}

// TestLive_FirstReadBetweenAWriteAndItsReport: a session first read after a
// record reached the file but before the store reported it has the record from
// the file, and does not fold it again when the report arrives.
func TestLive_FirstReadBetweenAWriteAndItsReport(t *testing.T) {
	store, err := session.NewFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s := &interposed{FileStore: store}
	l := Track(s)
	createSession(t, store, "s")
	l.Hold("s")
	appendLine(t, store, "s", prompt1)

	s.before = func() {
		s.before = nil
		liveState(t, l, "s")
	}
	appendLine(t, store, "s", started1)

	assertStrings(t, "turns", turnsShape(liveState(t, l, "s")), []string{"T1:open"})
}

// TestLive_FirstReadRacingADelete: a read that found the session just before
// it was deleted, and loaded its file after the reset, holds nothing once it
// returns — and a session created again under the id reads its own history,
// not the deleted one's, also when it was created while that read was loading.
func TestLive_FirstReadRacingADelete(t *testing.T) {
	ctx := context.Background()
	store, s, l := trackedWithHistory(t)
	l.Hold("s")
	meta, _, _ := store.Get("s")
	s.afterReset = func() {
		// Inside Delete: unlisted and reset, the file not yet removed.
		s.staleGet = &meta
		liveState(t, l, "s")
	}
	if err := store.Delete(ctx, "s"); err != nil {
		t.Fatal(err)
	}
	if n := len(l.sessions); n != 0 {
		t.Errorf("%d projections held after a read raced the deletion", n)
	}

	createSession(t, store, "s")
	assertRecreated(t, store, l)

	t.Run("created again while the read loads", func(t *testing.T) {
		store, s, l := trackedWithHistory(t)
		l.Hold("s")
		meta, _, _ := store.Get("s")
		loaded, resume, read := make(chan struct{}), make(chan struct{}), make(chan struct{})
		s.afterReset = func() {
			s.staleGet = &meta
			s.afterRead = func() {
				close(loaded)
				<-resume
			}
			go func() {
				defer close(read)
				if _, err := l.State(ctx, "s"); err != nil {
					t.Error(err)
				}
			}()
			<-loaded
		}
		if err := store.Delete(ctx, "s"); err != nil {
			t.Fatal(err)
		}
		createSession(t, store, "s")
		close(resume)
		<-read
		assertRecreated(t, store, l)
	})
}

// trackedWithHistory is a store holding session "s" with liveLines, tracked
// through interposed. Nothing holds "s" yet.
func trackedWithHistory(t *testing.T) (*session.FileStore, *interposed, *Live) {
	t.Helper()
	store, err := session.NewFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s := &interposed{FileStore: store}
	l := Track(s)
	createSession(t, store, "s")
	for _, line := range liveLines {
		appendLine(t, store, "s", line)
	}
	return store, s, l
}

func assertRecreated(t *testing.T, store *session.FileStore, l *Live) {
	t.Helper()
	appendLine(t, store, "s", prompt1)
	appendLine(t, store, "s", started1)
	if got, want := liveState(t, l, "s"), fileState(t, store, "s"); !reflect.DeepEqual(got, want) {
		t.Errorf("created again after the race:\n  live %+v\n  file %+v", got, want)
	}
}

// TestLive_HeldOnlyWhileActive: a session's projection is kept from the first
// read while something holds it, until the last holder lets go — however many
// times each releases — and a session nobody holds is read right from the
// file, also after appends it was not there to hear.
func TestLive_HeldOnlyWhileActive(t *testing.T) {
	store, l := newTracked(t)
	l.linger = 0 // TestLive_LingersOnceLetGo
	createSession(t, store, "s")
	half := len(liveLines) / 2
	for _, line := range liveLines[:half] {
		appendLine(t, store, "s", line)
	}
	assertFile := func(when string) {
		t.Helper()
		if got, want := liveState(t, l, "s"), fileState(t, store, "s"); !reflect.DeepEqual(got, want) {
			t.Fatalf("%s:\n  live %+v\n  file %+v", when, got, want)
		}
	}

	assertFile("never held")
	if resident(l, "s") {
		t.Fatal("a session nobody holds is kept after a read")
	}

	process := l.Hold("s")
	subscriber := l.Hold("s")
	if resident(l, "s") {
		t.Fatal("a held session is folded before anything reads it")
	}
	assertFile("held, first read")
	if !resident(l, "s") {
		t.Fatal("a held session is not kept after a read")
	}

	process()
	process()
	if !resident(l, "s") {
		t.Fatal("let go while a holder remains (a release counted twice?)")
	}
	subscriber()
	if resident(l, "s") || len(l.holds) != 0 {
		t.Fatalf("still kept after the last release: resident %v, holds %v", resident(l, "s"), l.holds)
	}

	for _, line := range liveLines[half:] {
		appendLine(t, store, "s", line)
	}
	assertFile("released, then appended to")
	if resident(l, "s") {
		t.Fatal("a released session is kept after a read")
	}

	l.Hold("s")
	assertFile("held again")
	appendLine(t, store, "s", `T2|{"type":"done"}`)
	assertFile("held again, then appended to")
}

// TestLive_LastReleaseDuringAFirstRead: a read loading a held session when its
// last holder lets go returns what it loaded and keeps nothing; a hold taken
// meanwhile reads the file afresh rather than the entry that was let go.
func TestLive_LastReleaseDuringAFirstRead(t *testing.T) {
	store, s, l := trackedWithHistory(t)
	release := l.Hold("s")

	var heldAgain func()
	appended := make(chan struct{})
	s.afterRead = func() {
		release()
		// lookup, not resident: the read holds the entry's fold lock.
		if l.lookup("s") != nil {
			t.Error("kept past the last release")
		}
		heldAgain = l.Hold("s")
		// Not on this goroutine: an entry wrongly kept would have the append
		// wait for the read's fold lock.
		go func() {
			defer close(appended)
			appendLine(t, store, "s", prompt1)
		}()
	}
	got := liveState(t, l, "s")
	<-appended
	if want := Fold(history(liveLines...), session.AgentTypeClaude).State(); !reflect.DeepEqual(got, want) {
		t.Errorf("the read racing the release:\n  got  %+v\n  want %+v", got, want)
	}
	if resident(l, "s") {
		t.Error("the entry the read loaded was kept after its release")
	}

	appendLine(t, store, "s", started1)
	if got, want := liveState(t, l, "s"), fileState(t, store, "s"); !reflect.DeepEqual(got, want) {
		t.Errorf("held again during the read:\n  live %+v\n  file %+v", got, want)
	}
	heldAgain()
}

// TestLive_HoldsComingAndGoing: with holders coming and going while records
// are appended and read, every read still holds every record whose append had
// returned and is the fold of a prefix of the file, and the end agrees with
// the file.
func TestLive_HoldsComingAndGoing(t *testing.T) {
	for round := 0; round < 20; round++ {
		store, l := newTracked(t)
		l.linger = 0 // TestLive_LingersOnceLetGo
		createSession(t, store, "s")
		records := history(liveLines...)
		prefixes := make([][]State, len(records)+1)
		for i := range prefixes {
			prefixes[i] = readings(records[:i])
		}

		var appended sync.Mutex
		returned := 0
		done := make(chan struct{})
		go func() {
			defer close(done)
			for _, line := range liveLines {
				appendLine(t, store, "s", line)
				appended.Lock()
				returned++
				appended.Unlock()
			}
		}()

		var workers sync.WaitGroup
		for r := 0; r < 3; r++ {
			workers.Add(2)
			go func() {
				defer workers.Done()
				for {
					l.Hold("s")()
					select {
					case <-done:
						return
					default:
					}
				}
			}()
			go func() {
				defer workers.Done()
				release := l.Hold("s")
				defer func() { release() }()
				for i := 0; ; i++ {
					if i%3 == 0 {
						release()
						release = l.Hold("s")
					}
					appended.Lock()
					atLeast := returned
					appended.Unlock()
					s, err := l.State(context.Background(), "s")
					if err != nil {
						t.Error(err)
						return
					}
					if !matchesPrefix(s, prefixes[atLeast:]) {
						t.Errorf("round %d: a read after %d appends returned is no prefix of at least that many:\n  %+v", round, atLeast, s)
						return
					}
					select {
					case <-done:
						return
					default:
					}
				}
			}()
		}
		workers.Wait()
		<-done
		if len(l.holds) != 0 || len(l.sessions) != 0 {
			t.Fatalf("round %d: kept after every holder let go: holds %v, %d entries", round, l.holds, len(l.sessions))
		}
		l.Hold("s")
		if got, want := liveState(t, l, "s"), prefixes[len(records)][0]; !reflect.DeepEqual(got, want) {
			t.Errorf("round %d: at the end:\n  live %+v\n  file %+v", round, got, want)
		}
	}
}

// A held session's pages are cut from what Live keeps: the file is read once,
// however many pages are asked for and whatever is appended meanwhile, and
// each page is the one the file's fold gives. Let go, it lingers: the pages
// after are still cut from it.
func TestLive_PagesOfAHeldSessionReadTheFileOnce(t *testing.T) {
	store, s, l := trackedWithHistory(t)
	ctx := context.Background()
	release := l.Hold("s")

	page := func() string {
		t.Helper()
		page, err := l.Page(ctx, "s", session.NoHistorySeq, MaxPageSize)
		if err != nil {
			t.Fatal(err)
		}
		return jsonOf(t, page)
	}
	filePage := func() string {
		t.Helper()
		records, err := store.GetHistory(ctx, "s")
		if err != nil {
			t.Fatal(err)
		}
		return pageJSON(t, Fold(records, session.AgentTypeClaude))
	}

	first := page()
	appendLine(t, store, "s", `T2|{"type":"text","content":"more"}`)
	if got, want := page(), filePage(); got != want || got == first {
		t.Errorf("after an append:\n  live %s\n  file %s", got, want)
	}
	if _, err := l.Page(ctx, "s", 3, 1); err != nil {
		t.Fatal(err)
	}
	if got := s.reads.Load(); got != 1 {
		t.Errorf("history read %d times while held, want once", got)
	}

	release()
	appendLine(t, store, "s", `T2|{"type":"text","content":"after"}`)
	if got, want := page(), filePage(); got != want {
		t.Errorf("let go, then appended to:\n  live %s\n  file %s", got, want)
	}
	page()
	if got := s.reads.Load(); got != 1 {
		t.Errorf("history read %d times, want once: a session let go lingers", got)
	}
	if _, err := l.Page(ctx, "missing", session.NoHistorySeq, 0); !errors.Is(err, session.ErrSessionNotFound) {
		t.Errorf("unknown session: err = %v, want ErrSessionNotFound", err)
	}
}

// TestLive_LingersOnceLetGo: a session's projection outlives its last holder,
// and a read of one nobody holds, by the linger — kept current meanwhile, each
// read pushing the end back — and is let go when it runs out.
func TestLive_LingersOnceLetGo(t *testing.T) {
	store, s, l := trackedWithHistory(t)
	// Ended by hand (expireLinger), so no step depends on the clock.
	l.linger = time.Hour
	ctx := context.Background()
	gone := func() bool {
		l.sessionsMu.Lock()
		defer l.sessionsMu.Unlock()
		return len(l.holds) == 0 && len(l.sessions) == 0 && len(l.lingering) == 0
	}
	letGo := func(when string) {
		t.Helper()
		expireLinger(l, "s")
		if !gone() {
			t.Fatalf("%s: still kept once the linger ran out: holds %v", when, l.holds)
		}
	}

	// Read with nobody holding it: folded once, then lingering.
	for range 3 {
		if _, err := l.Page(ctx, "s", session.NoHistorySeq, 0); err != nil {
			t.Fatal(err)
		}
	}
	if got := s.reads.Load(); got != 1 {
		t.Errorf("history read %d times by reads nobody held, want once", got)
	}
	appendLine(t, store, "s", `T2|{"type":"text","content":"while lingering"}`)
	if got, want := liveState(t, l, "s"), fileState(t, store, "s"); !reflect.DeepEqual(got, want) {
		t.Errorf("appended to while lingering:\n  live %+v\n  file %+v", got, want)
	}
	letGo("read with nobody holding it")

	// Held and let go: lingers again, and a hold taken meanwhile is not
	// counted twice.
	release := l.Hold("s")
	liveState(t, l, "s")
	reads := s.reads.Load()
	release()
	again := l.Hold("s")
	again()
	liveState(t, l, "s")
	if got := s.reads.Load(); got != reads {
		t.Errorf("history read again after a release, while lingering")
	}
	letGo("held and let go")

	if _, _, err := l.TakeUpdate(ctx, "s"); err != nil {
		t.Fatal(err)
	}
	if !gone() {
		t.Error("an update taken for a session nobody holds made it linger")
	}
	liveState(t, l, "s")
	if got := s.reads.Load(); got != reads+1 {
		t.Errorf("history read %d times after the linger ran out, want %d", got, reads+1)
	}

	// Lingering only, its history replaced: the update after the next write
	// has nobody to tell, and does not fold the file for nobody; nor is it a
	// break.
	reads = s.reads.Load()
	if err := store.WriteHistory(ctx, "s", history(prompt1, started1)); err != nil {
		t.Fatal(err)
	}
	appendLine(t, store, "s", `T1|{"type":"text","content":"after the reset"}`)
	if _, continuous, err := l.TakeUpdate(ctx, "s"); err != nil || !continuous {
		t.Errorf("update after a lingering session's reset: continuous %v, err %v", continuous, err)
	}
	if got := s.reads.Load(); got != reads {
		t.Errorf("history read %d times by an update nobody waits on, want %d", got, reads)
	}
	if got, want := liveState(t, l, "s"), fileState(t, store, "s"); !reflect.DeepEqual(got, want) {
		t.Errorf("read after the reset:\n  live %+v\n  file %+v", got, want)
	}
}

// TestLive_AnUpdateThatLoads: a held session whose projection was let go
// loads it again on the next record written, and the update is what that
// record changed — the call it settled among it — not nothing.
func TestLive_AnUpdateThatLoads(t *testing.T) {
	store, _, l := trackedWithHistory(t)
	l.linger = 0
	ctx := context.Background()
	release := l.Hold("s")
	defer release()
	liveState(t, l, "s")
	if err := store.WriteHistory(ctx, "s", history(prompt1, started1,
		`T1|{"type":"tool_call","tool_use_id":"tu","tool_name":"Bash"}`)); err != nil {
		t.Fatal(err)
	}
	appendLine(t, store, "s", `T1|{"type":"tool_result","tool_use_id":"tu","tool_result":"ok"}`)
	u, continuous, err := l.TakeUpdate(ctx, "s")
	if err != nil {
		t.Fatal(err)
	}
	if continuous {
		t.Error("an update after the held session's history was replaced is continuous")
	}
	if len(u.Items) != 1 || u.Items[0].Item.Tool == nil || u.Items[0].Item.Tool.Status != ItemSucceeded {
		t.Errorf("update = %+v, want the call the record settled", u)
	}
	if got, want := liveState(t, l, "s"), fileState(t, store, "s"); !reflect.DeepEqual(got, want) {
		t.Errorf("loaded by an update:\n  live %+v\n  file %+v", got, want)
	}

	// A read that loads it between a record and that record's update leaves
	// the update to say what the record changed.
	if err := store.WriteHistory(ctx, "s", history(prompt1, started1,
		`T1|{"type":"tool_call","tool_use_id":"tu2","tool_name":"Bash"}`)); err != nil {
		t.Fatal(err)
	}
	if _, _, err := l.TakeUpdate(ctx, "s"); err != nil {
		t.Fatal(err)
	}
	l.HistoryReset("s")
	appendLine(t, store, "s", `T1|{"type":"tool_result","tool_use_id":"tu2","tool_result":"ok"}`)
	if got, want := liveState(t, l, "s"), fileState(t, store, "s"); !reflect.DeepEqual(got, want) {
		t.Errorf("loaded by a read:\n  live %+v\n  file %+v", got, want)
	}
	u, _, err = l.TakeUpdate(ctx, "s")
	if err != nil {
		t.Fatal(err)
	}
	if len(u.Items) != 1 || u.Items[0].Item.Tool == nil || u.Items[0].Item.Tool.ToolUseID != "tu2" || u.Items[0].Item.Tool.Status != ItemSucceeded {
		t.Errorf("update after a read loaded it = %+v, want the call the record settled", u)
	}
}

// expireLinger runs the session's linger out now.
func expireLinger(l *Live, sessionID string) {
	l.sessionsMu.Lock()
	h := l.lingering[sessionID]
	if h != nil {
		h.until = time.Time{}
	}
	l.sessionsMu.Unlock()
	if h != nil {
		l.endLinger(sessionID, h)
	}
}
