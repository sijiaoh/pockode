package worktree

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/session"
)

// slowExitAgent starts sessions whose CLI does not exit until exit is closed,
// running as whichever profile it is told is current.
type slowExitAgent struct {
	profileMu sync.Mutex
	profile   string
	exit      chan struct{}
}

func (a *slowExitAgent) CurrentProfile() (string, error) {
	a.profileMu.Lock()
	defer a.profileMu.Unlock()
	return a.profile, nil
}

func (a *slowExitAgent) setProfile(id string) {
	a.profileMu.Lock()
	a.profile = id
	a.profileMu.Unlock()
}

func (a *slowExitAgent) Start(context.Context, agent.StartOptions) (agent.Session, error) {
	return &slowExitSession{events: make(chan agent.AgentEvent), exit: a.exit}, nil
}

type slowExitSession struct {
	events    chan agent.AgentEvent
	exit      chan struct{}
	closeOnce sync.Once
}

func (s *slowExitSession) Events() <-chan agent.AgentEvent { return s.events }
func (s *slowExitSession) SendMessage(agent.Prompt) error  { return nil }
func (s *slowExitSession) SendPermissionResponse(agent.PermissionRequestData, agent.PermissionChoice) error {
	return nil
}
func (s *slowExitSession) SendInterrupt() error { return nil }
func (s *slowExitSession) Close() {
	s.closeOnce.Do(func() {
		go func() {
			<-s.exit
			close(s.events)
		}()
	})
}

// A worktree being deleted is no longer loaded, but its CLIs are still exiting:
// releasing a profile waits for them like for any other, rather than report
// that nothing runs as it while one still does.
func TestReleaseProfile_SeesAWorktreeStillStopping(t *testing.T) {
	repo := initGitRepo(t)
	dataDir := t.TempDir()
	registry := NewRegistry(repo, dataDir)
	if _, _, err := registry.EnsureWorktree("feature-x"); err != nil {
		t.Fatalf("EnsureWorktree: %v", err)
	}
	ag := &slowExitAgent{profile: "A", exit: make(chan struct{})}
	agents := agent.NewRegistry()
	agents.Register(session.AgentTypeClaude, ag)
	m := NewManager(registry, agents, dataDir, session.LeaseBudgets{})
	t.Cleanup(m.Shutdown)
	exited := sync.OnceFunc(func() { close(ag.exit) })
	defer exited()

	wt, err := m.Get("feature-x")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	ctx := context.Background()
	meta, err := wt.SessionStore.Create(ctx, "sess-1", session.CreateSpec{AgentType: session.AgentTypeClaude})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	if _, _, err := wt.ProcessManager.GetOrCreateProcess(ctx, meta); err != nil {
		t.Fatalf("GetOrCreateProcess: %v", err)
	}
	m.Release(wt)

	shutDown := make(chan struct{})
	go func() {
		m.ForceShutdown("feature-x")
		close(shutDown)
	}()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, loaded := m.loaded("feature-x"); !loaded {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the worktree was never unloaded")
		}
		time.Sleep(5 * time.Millisecond)
	}
	ag.setProfile("B")

	short, cancel := context.WithTimeout(ctx, 50*time.Millisecond)
	defer cancel()
	if _, err := m.ReleaseProfile(short, session.AgentTypeClaude, "A"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("ReleaseProfile while the deleted worktree's CLI is exiting = %v, want the deadline", err)
	}

	exited()
	<-shutDown
	if busy, err := m.ReleaseProfile(ctx, session.AgentTypeClaude, "A"); err != nil || len(busy) != 0 {
		t.Fatalf("ReleaseProfile after the worktree stopped = %v, %v; want nothing left", busy, err)
	}
}
