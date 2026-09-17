package worktree

import (
	"context"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/pockode/server/session"
	"github.com/pockode/server/watch"
	"github.com/pockode/server/work"
)

func TestForceShutdown_RemovesDataDirectory(t *testing.T) {
	dataDir := t.TempDir()
	worktreesDir := filepath.Join(dataDir, "worktrees")
	wtDataDir := filepath.Join(worktreesDir, "feature-1")

	// Create the data directory structure
	if err := os.MkdirAll(filepath.Join(wtDataDir, "sessions"), 0755); err != nil {
		t.Fatalf("failed to create test directory: %v", err)
	}

	// Create a test file inside
	testFile := filepath.Join(wtDataDir, "sessions", "test.json")
	if err := os.WriteFile(testFile, []byte("{}"), 0644); err != nil {
		t.Fatalf("failed to create test file: %v", err)
	}

	m := &Manager{
		dataDir:   dataDir,
		worktrees: make(map[string]*Worktree),
	}

	m.ForceShutdown("feature-1")

	// Verify the data directory is removed
	if _, err := os.Stat(wtDataDir); !os.IsNotExist(err) {
		t.Errorf("worktree data directory still exists after ForceShutdown")
	}

	// Verify the parent worktrees directory still exists
	if _, err := os.Stat(worktreesDir); os.IsNotExist(err) {
		t.Errorf("parent worktrees directory was unexpectedly removed")
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
