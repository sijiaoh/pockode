package worktree

import (
	"context"
	"sync"
	"testing"

	"github.com/pockode/server/session"
)

// Work usage aggregation asks the manager for a worktree's session usage by
// name, and the answer has to come from that worktree's own session index — the
// main one and a named one keep theirs in different places, and a work item
// pinned to a worktree carries only the name.
//
// It must also answer without building the worktree: a story whose tasks ran in
// a worktree nobody is using would otherwise start it up — watchers, process
// manager and all — because someone opened a page showing numbers.
func TestManagerSessionUsages(t *testing.T) {
	ctx := context.Background()
	dataDir := t.TempDir()
	m := &Manager{dataDir: dataDir, worktrees: make(map[string]*Worktree)}

	for name, usage := range map[string]int64{"": 11, "feature-x": 22} {
		store, err := session.NewFileStore(m.dataDirFor(name))
		if err != nil {
			t.Fatalf("NewFileStore(%q): %v", name, err)
		}
		if _, err := store.Create(ctx, "sess-"+name, session.CreateSpec{}); err != nil {
			t.Fatalf("Create in %q: %v", name, err)
		}
		report := session.UsageReport{Added: session.TokenUsage{InputTokens: usage}}
		if err := store.AddUsage(ctx, "sess-"+name, report); err != nil {
			t.Fatalf("AddUsage in %q: %v", name, err)
		}
	}

	for _, tc := range []struct {
		worktree  string
		sessionID string
		want      int64
	}{
		{worktree: "", sessionID: "sess-", want: 11},
		{worktree: "feature-x", sessionID: "sess-feature-x", want: 22},
	} {
		usages, err := m.SessionUsages(tc.worktree)
		if err != nil {
			t.Fatalf("SessionUsages(%q): %v", tc.worktree, err)
		}
		if got := usages[tc.sessionID].InputTokens; got != tc.want {
			t.Errorf("SessionUsages(%q)[%q] = %d, want %d", tc.worktree, tc.sessionID, got, tc.want)
		}
		if len(usages) != 1 {
			t.Errorf("SessionUsages(%q) returned %d sessions, want only its own", tc.worktree, len(usages))
		}
	}

	if len(m.worktrees) != 0 {
		t.Errorf("reading usage built %d worktrees", len(m.worktrees))
	}

	// A worktree that has never run anything is not an error to ask about.
	usages, err := m.SessionUsages("never-used")
	if err != nil || len(usages) != 0 {
		t.Errorf("SessionUsages(unused) = %+v, err=%v", usages, err)
	}
}

type recordingSessionListener struct {
	mu      sync.Mutex
	changed []string
}

func (l *recordingSessionListener) OnSessionChange(event session.SessionChangeEvent) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.changed = append(l.changed, event.Session.ID)
}

func (l *recordingSessionListener) count() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.changed)
}

// Worktrees are built lazily by whoever needs one first, and AutoResumer resolves
// senders for the work it restarts while the server is still wiring itself up —
// so a worktree can already exist when the listener is registered. Missing it
// would freeze that worktree's work usage for the whole process, silently.
func TestManagerSetSessionChangeListenerReachesExistingWorktrees(t *testing.T) {
	ctx := context.Background()
	m := &Manager{dataDir: t.TempDir(), worktrees: make(map[string]*Worktree)}

	store, err := session.NewFileStore(m.dataDirFor(""))
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	m.worktrees[""] = &Worktree{Name: "", SessionStore: store}

	listener := &recordingSessionListener{}
	m.SetSessionChangeListener(listener)

	if _, err := store.Create(ctx, "sess-1", session.CreateSpec{}); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := store.AddUsage(ctx, "sess-1", session.UsageReport{
		Added: session.TokenUsage{InputTokens: 3},
	}); err != nil {
		t.Fatalf("AddUsage: %v", err)
	}

	if listener.count() < 2 {
		t.Errorf("listener heard %d changes, want the create and the usage report", listener.count())
	}
}

// The worktree name here comes from a stored work item, not from the registry
// that normally vouches for it, so it must not be able to name a path outside
// the data directory.
func TestManagerSessionUsagesRejectsEscapingName(t *testing.T) {
	m := &Manager{dataDir: t.TempDir(), worktrees: make(map[string]*Worktree)}

	for _, name := range []string{"../elsewhere", "a/../../b", "/absolute"} {
		if _, err := m.SessionUsages(name); err == nil {
			t.Errorf("SessionUsages(%q) was allowed", name)
		}
	}
}
