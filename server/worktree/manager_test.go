package worktree

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/session"
	"github.com/pockode/server/watch"
	"github.com/pockode/server/work"
)

// Deleting a worktree must not destroy the conversations that happened in it.
// A work usually runs in a worktree of its own and that worktree is cleaned up
// once the work is done, so removing the data here threw away the record of the
// work as part of tidying up after it.
func TestForceShutdown_KeepsSessionData(t *testing.T) {
	dataDir := t.TempDir()
	m := &Manager{dataDir: dataDir, worktrees: make(map[string]*Worktree)}
	createSessionIn(t, m, "feature-1", "sess-1")

	m.ForceShutdown("feature-1")

	reader, err := m.SessionReader("feature-1")
	if err != nil {
		t.Fatalf("SessionReader: %v", err)
	}
	sessions, err := reader.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(sessions) != 1 || sessions[0].ID != "sess-1" {
		t.Errorf("sessions after deleting the worktree = %+v, want the one that was there", sessions)
	}
}

// stubWorkSource answers which work item a session runs, which is all the
// session list reads from the work layer.
type stubWorkSource struct{ works []work.Work }

func (s *stubWorkSource) List() ([]work.Work, error) { return s.works, nil }

func (s *stubWorkSource) FindBySessionID(sessionID string) (work.Work, bool, error) {
	for _, w := range s.works {
		if w.SessionID == sessionID {
			return w, true, nil
		}
	}
	return work.Work{}, false, nil
}

type capturingNotifier struct {
	mu    sync.Mutex
	count int
}

func (n *capturingNotifier) Notify(context.Context, watch.Notification) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.count++
	return nil
}

func (n *capturingNotifier) calls() int {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.count
}

// A session names the work item it runs — on its list row and on its detail —
// so the worktree that work lives in has to hear when the relation changes. The
// manager is what routes it there, and it is the only thing that knows which
// worktrees exist.
func TestOnWorkChange_ReachesTheSessionWatchersOfTheWorksWorktree(t *testing.T) {
	dataDir := t.TempDir()
	sessionStore, err := session.NewFileStore(dataDir)
	if err != nil {
		t.Fatalf("session.NewFileStore: %v", err)
	}
	if _, err := sessionStore.Create(context.Background(), "sess-1", session.CreateSpec{}); err != nil {
		t.Fatalf("create session: %v", err)
	}

	item := work.Work{ID: "work-1", SessionID: "sess-1", Worktree: "feature-1"}
	works := &stubWorkSource{works: []work.Work{item}}
	listWatcher := watch.NewSessionListWatcher(sessionStore, works)
	listWatcher.Start()
	defer listWatcher.Stop()
	detailWatcher := watch.NewSessionDetailWatcher(sessionStore, works)
	detailWatcher.Start()
	defer detailWatcher.Stop()

	m := &Manager{
		worktrees: map[string]*Worktree{
			"feature-1": {
				Name:                 "feature-1",
				SessionStore:         sessionStore,
				SessionListWatcher:   listWatcher,
				SessionDetailWatcher: detailWatcher,
			},
		},
	}

	listNotifier := &capturingNotifier{}
	if _, err := listWatcher.Subscribe("client-1", listNotifier, watch.SessionListFilter{}); err != nil {
		t.Fatalf("subscribe to the list: %v", err)
	}
	detailNotifier := &capturingNotifier{}
	if _, err := detailWatcher.Subscribe("client-2", "sess-1", detailNotifier); err != nil {
		t.Fatalf("subscribe to the detail: %v", err)
	}

	// A work in a worktree nobody has loaded reaches nobody; the event that
	// follows is what proves the first one was handled and dropped.
	m.OnWorkChange(work.ChangeEvent{
		Op:   work.OperationUpdate,
		Work: work.Work{ID: "work-2", SessionID: "sess-1", Worktree: "feature-2"},
	})
	m.OnWorkChange(work.ChangeEvent{Op: work.OperationUpdate, Work: item})

	deadline := time.Now().Add(2 * time.Second)
	for listNotifier.calls() == 0 || detailNotifier.calls() == 0 {
		if time.Now().After(deadline) {
			t.Fatalf("the work's own worktree was never notified: list %d, detail %d",
				listNotifier.calls(), detailNotifier.calls())
		}
		time.Sleep(5 * time.Millisecond)
	}
	if got := listNotifier.calls(); got != 1 {
		t.Errorf("notified the list %d times, want once — a work belongs to one worktree", got)
	}
	if got := detailNotifier.calls(); got != 1 {
		t.Errorf("notified the detail %d times, want once — a work belongs to one worktree", got)
	}
}

// createSessionIn records a session in the on-disk index of the given worktree,
// the way a real session start does.
func createSessionIn(t *testing.T, m *Manager, worktree, sessionID string) {
	t.Helper()
	store, err := session.NewFileStore(m.dataDirFor(worktree))
	if err != nil {
		t.Fatalf("session store for worktree %q: %v", worktree, err)
	}
	if _, err := store.Create(context.Background(), sessionID, session.CreateSpec{}); err != nil {
		t.Fatalf("create session %s: %v", sessionID, err)
	}
}

// Sessions are stored per worktree, so anything holding a bare session id — an
// MCP caller's identity, a record keyed by session — can only reach the store
// that owns it through this.
func TestResolveSessionWorktree(t *testing.T) {
	repo := initGitRepo(t)
	dataDir := t.TempDir()
	registry := NewRegistry(repo, dataDir)
	if _, _, err := registry.EnsureWorktree("feature-x"); err != nil {
		t.Fatalf("EnsureWorktree: %v", err)
	}

	m := &Manager{registry: registry, dataDir: dataDir, worktrees: make(map[string]*Worktree)}
	createSessionIn(t, m, "", "main-session")
	createSessionIn(t, m, "feature-x", "feature-session")

	for sessionID, want := range map[string]string{"main-session": "", "feature-session": "feature-x"} {
		got, err := m.ResolveSessionWorktree(sessionID)
		if err != nil {
			t.Fatalf("ResolveSessionWorktree(%q): %v", sessionID, err)
		}
		if got != want {
			t.Errorf("ResolveSessionWorktree(%q) = %q, want %q", sessionID, got, want)
		}
	}

	if _, err := m.ResolveSessionWorktree("no-such-session"); !errors.Is(err, ErrSessionNotFound) {
		t.Errorf("unknown session: err = %v, want ErrSessionNotFound", err)
	}
	// An empty id belongs to nobody; it must not resolve to the main worktree.
	if _, err := m.ResolveSessionWorktree(""); !errors.Is(err, ErrSessionNotFound) {
		t.Errorf("empty session id: err = %v, want ErrSessionNotFound", err)
	}
}

// StartupTurns is what work.Engine.RecoverStartup reads, and it runs before any
// Manager exists — so it has to answer for the main worktree and the named ones
// alike, straight off the file, with nothing built.
func TestStartupTurns_ReadsEveryWorktreesIndexFromDisk(t *testing.T) {
	dataDir := t.TempDir()
	m := &Manager{dataDir: dataDir, worktrees: make(map[string]*Worktree)}
	createSessionIn(t, m, "", "sess-main")
	createSessionIn(t, m, "feature-x", "sess-feature")

	turns := StartupTurns{DataDir: dataDir}
	for _, tt := range []struct{ worktree, sessionID string }{
		{"", "sess-main"},
		{"feature-x", "sess-feature"},
	} {
		got, err := turns.SessionTurns(tt.worktree)
		if err != nil {
			t.Fatalf("SessionTurns(%q): %v", tt.worktree, err)
		}
		if _, found := got[tt.sessionID]; !found {
			t.Errorf("SessionTurns(%q) = %+v, want it to name %s", tt.worktree, got, tt.sessionID)
		}
	}

	// A worktree with no sessions is not an error; a name that is not a
	// directory name is, because it is about to become a path.
	if got, err := turns.SessionTurns("nobody"); err != nil || len(got) != 0 {
		t.Errorf("SessionTurns(\"nobody\") = %+v/%v, want empty/nil", got, err)
	}
	if _, err := turns.SessionTurns(filepath.Join("..", "escape")); err == nil {
		t.Error("a name that escapes the data dir was accepted")
	}
}

// The sessions of a deleted work go with it. Before this they only went while
// their worktree still existed — and a work whose worktree was cleaned up when
// it finished is exactly the work most likely to be deleted afterwards, so the
// data kept past the worktree's deletion had no way out at all.
func TestDeleteSessions_ReachesAWorktreeThatIsGone(t *testing.T) {
	m, dataDir := managerOverDeletedWorktree(t, "feature-x", "sess-1", "sess-2")

	m.DeleteSessions(context.Background(), "feature-x", []string{"sess-1"})

	if got := sessionIDsIn(t, m, "feature-x"); len(got) != 1 || got[0] != "sess-2" {
		t.Errorf("sessions after deleting a work's session = %v, want only sess-2", got)
	}
	if _, err := os.Stat(filepath.Join(dataDir, "worktrees", "feature-x", "sessions", "sess-1")); !os.IsNotExist(err) {
		t.Errorf("the deleted session's directory is still there: %v", err)
	}
}

// A session that belongs to no work item is deleted by hand, and a worktree
// that no longer exists is precisely where such a session is stranded: it can
// never be continued, so deleting it is the only thing left to do with it.
func TestDeleteSession_ReachesAWorktreeThatIsGone(t *testing.T) {
	m, _ := managerOverDeletedWorktree(t, "feature-x", "sess-1", "sess-2")

	if err := m.DeleteSession(context.Background(), "feature-x", "sess-1"); err != nil {
		t.Fatalf("DeleteSession: %v", err)
	}

	if got := sessionIDsIn(t, m, "feature-x"); len(got) != 1 || got[0] != "sess-2" {
		t.Errorf("sessions after a manual delete = %v, want only sess-2", got)
	}
	sources, err := m.SessionSources()
	if err != nil {
		t.Fatalf("SessionSources: %v", err)
	}
	if len(sources) != 1 || sources[0].Name != "feature-x" || sources[0].SessionCount != 1 || sources[0].Exists {
		t.Errorf("sources = %+v, want the deleted worktree with one session left", sources)
	}
}

// Once the last session of a deleted worktree is gone there is nothing left to
// read there, so the worktree stops being offered as a place to look — and the
// directory it was stored in goes too, rather than staying empty forever.
func TestDeleteSession_LastOneTakesTheDeletedWorktreeWithIt(t *testing.T) {
	m, dataDir := managerOverDeletedWorktree(t, "feature-x", "sess-1")

	if err := m.DeleteSession(context.Background(), "feature-x", "sess-1"); err != nil {
		t.Fatalf("DeleteSession: %v", err)
	}

	sources, err := m.SessionSources()
	if err != nil {
		t.Fatalf("SessionSources: %v", err)
	}
	if len(sources) != 0 {
		t.Errorf("sources = %+v, want none: the only worktree with data has none left", sources)
	}
	if _, err := os.Stat(filepath.Join(dataDir, "worktrees", "feature-x")); !os.IsNotExist(err) {
		t.Errorf("the emptied data directory is still there: %v", err)
	}
}

// A session in a worktree that still exists is deleted through that worktree's
// store — the one thing allowed to write its directory, and the only thing that
// can close a process the session may still have running.
func TestDeleteSession_GoesThroughTheStoreOfAnExistingWorktree(t *testing.T) {
	repo := initGitRepo(t)
	dataDir := t.TempDir()
	registry := NewRegistry(repo, dataDir)
	if _, _, err := registry.EnsureWorktree("feature-x"); err != nil {
		t.Fatalf("EnsureWorktree: %v", err)
	}
	m := NewManager(registry, agent.NewRegistry(), dataDir, session.LeaseBudgets{})
	t.Cleanup(m.Shutdown)

	wt, err := m.Get("feature-x")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	defer m.Release(wt)
	if _, err := wt.SessionStore.Create(context.Background(), "sess-1", session.CreateSpec{}); err != nil {
		t.Fatalf("create session: %v", err)
	}

	if err := m.DeleteSession(context.Background(), "feature-x", "sess-1"); err != nil {
		t.Fatalf("DeleteSession: %v", err)
	}

	// Read back through the live store: a delete written underneath it would be
	// invisible here, and would come back the next time it persisted.
	sessions, err := wt.SessionStore.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(sessions) != 0 {
		t.Errorf("sessions = %+v, want none", sessions)
	}
	if _, err := os.Stat(m.dataDirFor("feature-x")); err != nil {
		t.Errorf("the data directory of a worktree that still exists was removed: %v", err)
	}
}

// managerOverDeletedWorktree leaves the named worktree's sessions stored with
// the worktree itself gone — the state deleting a worktree leaves behind.
func managerOverDeletedWorktree(t *testing.T, name string, sessionIDs ...string) (*Manager, string) {
	t.Helper()
	repo := initGitRepo(t)
	dataDir := t.TempDir()
	registry := NewRegistry(repo, dataDir)
	if _, _, err := registry.EnsureWorktree(name); err != nil {
		t.Fatalf("EnsureWorktree: %v", err)
	}

	m := &Manager{registry: registry, dataDir: dataDir, worktrees: make(map[string]*Worktree)}
	for _, sessionID := range sessionIDs {
		createSessionIn(t, m, name, sessionID)
	}

	if err := registry.Delete(name); err != nil {
		t.Fatalf("delete worktree %q: %v", name, err)
	}
	m.ForceShutdown(name)
	return m, dataDir
}

func sessionIDsIn(t *testing.T, m *Manager, worktree string) []string {
	t.Helper()
	reader, err := m.SessionReader(worktree)
	if err != nil {
		t.Fatalf("SessionReader(%q): %v", worktree, err)
	}
	sessions, err := reader.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	ids := make([]string, len(sessions))
	for i, sess := range sessions {
		ids[i] = sess.ID
	}
	return ids
}

// Deleting a worktree keeps its directory for the sessions in it. One whose
// sessions were all deleted while it was still alive has none to keep, and is
// not entitled to an empty directory for the life of the project.
func TestForceShutdown_RemovesADataDirectoryWithNoSessionsLeft(t *testing.T) {
	repo := initGitRepo(t)
	dataDir := t.TempDir()
	registry := NewRegistry(repo, dataDir)
	if _, _, err := registry.EnsureWorktree("feature-x"); err != nil {
		t.Fatalf("EnsureWorktree: %v", err)
	}
	m := &Manager{registry: registry, dataDir: dataDir, worktrees: make(map[string]*Worktree)}

	// A store with nothing in it is what a worktree looks like once its last
	// session has been deleted through it.
	if _, err := session.NewFileStore(m.dataDirFor("feature-x")); err != nil {
		t.Fatalf("session.NewFileStore: %v", err)
	}

	if err := registry.Delete("feature-x"); err != nil {
		t.Fatalf("delete worktree: %v", err)
	}
	m.ForceShutdown("feature-x")

	if _, err := os.Stat(m.dataDirFor("feature-x")); !os.IsNotExist(err) {
		t.Errorf("the data directory of a deleted worktree with no sessions is still there: %v", err)
	}
}
