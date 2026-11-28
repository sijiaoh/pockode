package worktree

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/session"
)

// Two callers loading the same worktree at once used to build a worktree each
// and throw the loser away — a second session store over the same directory,
// whose Close wrote back whatever it had read before the winner's writes. The
// second caller has to wait for the first one's worktree instead.
func TestGet_ConcurrentLoadsOpenOneSessionStore(t *testing.T) {
	repo := initGitRepo(t)
	dataDir := t.TempDir()
	registry := NewRegistry(repo, dataDir)
	if _, _, err := registry.EnsureWorktree("feature-x"); err != nil {
		t.Fatalf("EnsureWorktree: %v", err)
	}
	m := NewManager(registry, agent.NewRegistry(), dataDir, session.LeaseBudgets{})
	t.Cleanup(m.Shutdown)

	var opens atomic.Int32
	firstOpening := make(chan struct{})
	proceed := make(chan struct{})
	open := newFileStore
	newFileStore = func(dir string) (*session.FileStore, error) {
		if opens.Add(1) == 1 {
			close(firstOpening)
			<-proceed
		}
		return open(dir)
	}
	t.Cleanup(func() { newFileStore = open })

	results := make(chan *Worktree, 2)
	get := func() {
		wt, err := m.Get("feature-x")
		if err != nil {
			t.Errorf("Get: %v", err)
		}
		results <- wt
	}
	go get()
	<-firstOpening
	go get()
	// Long enough for the second Get to have opened a store of its own, if it
	// is going to.
	time.Sleep(100 * time.Millisecond)
	close(proceed)

	first, second := <-results, <-results
	if first == nil || second == nil {
		t.FailNow()
	}
	defer m.Release(first)
	defer m.Release(second)
	if first != second {
		t.Error("the two Gets returned different worktrees")
	}
	if n := opens.Load(); n != 1 {
		t.Errorf("session stores opened on the directory = %d, want 1", n)
	}
	if n := m.RefCount(first); n != 2 {
		t.Errorf("refCount = %d, want 2", n)
	}
}

// A worktree unloaded while its CLI is still exiting keeps writing until it
// has: its process's last events, its pending index changes at Close. Loading
// the worktree again in that window used to open a second store that read the
// index before those writes and then overwrote them — or was overwritten by
// them. The load has to wait for the old store to finish.
func TestGet_WaitsForThePreviousStoreToStopWriting(t *testing.T) {
	repo := initGitRepo(t)
	dataDir := t.TempDir()
	registry := NewRegistry(repo, dataDir)
	if _, _, err := registry.EnsureWorktree("feature-x"); err != nil {
		t.Fatalf("EnsureWorktree: %v", err)
	}
	ag := &slowExitAgent{exit: make(chan struct{})}
	agents := agent.NewRegistry()
	agents.Register(session.AgentTypeClaude, ag)
	m := NewManager(registry, agents, dataDir, session.LeaseBudgets{})
	t.Cleanup(m.Shutdown)
	exited := sync.OnceFunc(func() { close(ag.exit) })
	defer exited()

	ctx := context.Background()
	old, err := m.Get("feature-x")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	meta, err := old.SessionStore.Create(ctx, "sess-1", session.CreateSpec{AgentType: session.AgentTypeClaude})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	if _, _, err := old.ProcessManager.GetOrCreateProcess(ctx, meta); err != nil {
		t.Fatalf("GetOrCreateProcess: %v", err)
	}
	// A recoverable change, held in memory until the store flushes or closes.
	if err := old.SessionStore.SetUnread(ctx, "sess-1", true); err != nil {
		t.Fatalf("SetUnread: %v", err)
	}
	m.Release(old)

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

	reloaded := make(chan *Worktree, 1)
	go func() {
		wt, err := m.Get("feature-x")
		if err != nil {
			t.Errorf("Get while the old worktree stops: %v", err)
		}
		reloaded <- wt
	}()
	var wt *Worktree
	early := false
	select {
	case wt = <-reloaded:
		early = true
		t.Error("the worktree was loaded again while its previous session store could still write")
	case <-time.After(200 * time.Millisecond):
	}

	exited()
	<-shutDown
	if !early {
		wt = <-reloaded
	}
	if wt == nil {
		t.FailNow()
	}
	defer m.Release(wt)
	if wt == old {
		t.Fatal("Get returned the worktree that was shut down")
	}

	if _, err := wt.SessionStore.Create(ctx, "sess-2", session.CreateSpec{}); err != nil {
		t.Fatalf("create session in the reloaded worktree: %v", err)
	}
	reader := session.NewDirReader(m.dataDirFor("feature-x"))
	first, found, err := reader.Get("sess-1")
	if err != nil || !found {
		t.Fatalf("sess-1 on disk: found %v, err %v", found, err)
	}
	if !first.Unread {
		t.Error("the old store's last change was lost to the new store")
	}
	if _, found, err := reader.Get("sess-2"); err != nil || !found {
		t.Errorf("sess-2 on disk: found %v, err %v; the new store's write was lost to the old store", found, err)
	}
}

// git can lose a worktree before Pockode unloads it. Deleting a session there
// used to rewrite the index on disk beneath the store still open on it, whose
// next write — here its Close — put the session back.
func TestDeleteSession_OfAWorktreeGoneWhileLoadedGoesThroughItsStore(t *testing.T) {
	repo := initGitRepo(t)
	dataDir := t.TempDir()
	registry := NewRegistry(repo, dataDir)
	if _, _, err := registry.EnsureWorktree("feature-x"); err != nil {
		t.Fatalf("EnsureWorktree: %v", err)
	}
	m := NewManager(registry, agent.NewRegistry(), dataDir, session.LeaseBudgets{})

	ctx := context.Background()
	wt, err := m.Get("feature-x")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	// sess-2 keeps the directory from being pruned with sess-1, which would
	// have the store drop its write instead.
	for _, id := range []string{"sess-1", "sess-2"} {
		if _, err := wt.SessionStore.Create(ctx, id, session.CreateSpec{}); err != nil {
			t.Fatalf("create %s: %v", id, err)
		}
	}
	// A recoverable change, so the store still has something to write at Close.
	if err := wt.SessionStore.SetUnread(ctx, "sess-1", true); err != nil {
		t.Fatalf("SetUnread: %v", err)
	}
	if err := registry.Delete("feature-x"); err != nil {
		t.Fatalf("remove the worktree from git: %v", err)
	}

	if err := m.DeleteSession(ctx, "feature-x", "sess-1"); err != nil {
		t.Fatalf("DeleteSession: %v", err)
	}
	m.Release(wt)
	m.Shutdown()

	reader := session.NewDirReader(m.dataDirFor("feature-x"))
	if _, found, err := reader.Get("sess-1"); err != nil || found {
		t.Errorf("sess-1 on disk after the store closed: found %v, err %v; the store wrote it back", found, err)
	}
	if _, found, err := reader.Get("sess-2"); err != nil || !found {
		t.Errorf("sess-2 on disk: found %v, err %v; want it kept", found, err)
	}
}

// A worktree removed by git is unloaded while its CLI is still exiting, and its
// store writes until it has. A session deleted in that window used to be
// deleted on disk at once and written back by the stopping store's Close; the
// deletion has to wait for the store to let go of the directory.
func TestDeleteSession_WaitsForAStoppingStoreOfAWorktreeThatIsGone(t *testing.T) {
	repo := initGitRepo(t)
	dataDir := t.TempDir()
	registry := NewRegistry(repo, dataDir)
	if _, _, err := registry.EnsureWorktree("feature-x"); err != nil {
		t.Fatalf("EnsureWorktree: %v", err)
	}
	ag := &slowExitAgent{exit: make(chan struct{})}
	agents := agent.NewRegistry()
	agents.Register(session.AgentTypeClaude, ag)
	m := NewManager(registry, agents, dataDir, session.LeaseBudgets{})
	t.Cleanup(m.Shutdown)
	exited := sync.OnceFunc(func() { close(ag.exit) })
	defer exited()

	ctx := context.Background()
	old, err := m.Get("feature-x")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	for _, id := range []string{"sess-1", "sess-2"} {
		if _, err := old.SessionStore.Create(ctx, id, session.CreateSpec{AgentType: session.AgentTypeClaude}); err != nil {
			t.Fatalf("create %s: %v", id, err)
		}
	}
	meta, found, err := old.SessionStore.Get("sess-2")
	if err != nil || !found {
		t.Fatalf("get sess-2: found %v, err %v", found, err)
	}
	if _, _, err := old.ProcessManager.GetOrCreateProcess(ctx, meta); err != nil {
		t.Fatalf("GetOrCreateProcess: %v", err)
	}
	if err := old.SessionStore.SetUnread(ctx, "sess-1", true); err != nil {
		t.Fatalf("SetUnread: %v", err)
	}
	m.Release(old)
	if err := registry.Delete("feature-x"); err != nil {
		t.Fatalf("remove the worktree from git: %v", err)
	}

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

	deleted := make(chan error, 1)
	go func() { deleted <- m.DeleteSession(ctx, "feature-x", "sess-1") }()
	select {
	case err := <-deleted:
		t.Errorf("the session was deleted while the worktree's store could still write (err %v)", err)
		deleted <- err
	case <-time.After(200 * time.Millisecond):
	}

	exited()
	<-shutDown
	if err := <-deleted; err != nil {
		t.Fatalf("DeleteSession: %v", err)
	}

	reader := session.NewDirReader(m.dataDirFor("feature-x"))
	if _, found, err := reader.Get("sess-1"); err != nil || found {
		t.Errorf("sess-1 on disk: found %v, err %v; the stopping store wrote it back", found, err)
	}
	if _, found, err := reader.Get("sess-2"); err != nil || !found {
		t.Errorf("sess-2 on disk: found %v, err %v; want it kept", found, err)
	}
}
