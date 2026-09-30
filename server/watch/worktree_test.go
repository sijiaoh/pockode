package watch

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
)

type fakeWorktreePoller struct {
	mu    sync.Mutex
	state WorktreeState
}

func (p *fakeWorktreePoller) set(state WorktreeState) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.state = state
}

func (p *fakeWorktreePoller) poll(ctx context.Context) (WorktreeState, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.state, ctx.Err()
}

func lastIsGitRepo(t *testing.T, n *captureNotifier) bool {
	t.Helper()
	var params worktreeChangedParams
	if err := json.Unmarshal(n.last(), &params); err != nil {
		t.Fatalf("unmarshal worktree.changed: %v", err)
	}
	return params.IsGitRepo
}

// The repository appearing and disappearing are both changes, and each
// notification carries the state it announces.
func TestWorktreeWatcher_NotifiesGitRepoTransitions(t *testing.T) {
	poller := &fakeWorktreePoller{}
	w := NewWorktreeWatcher(poller.poll)
	t.Cleanup(w.Stop)

	notifier := &captureNotifier{}
	isGitRepo, err := w.Subscribe("client-1", notifier)
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	if isGitRepo {
		t.Fatal("Subscribe reported a git repository before there was one")
	}

	w.checkAndNotify()
	if notifier.count() != 0 {
		t.Fatalf("an unchanged poll notified %d time(s)", notifier.count())
	}

	poller.set(WorktreeState{IsGitRepo: true, Fingerprint: "main"})
	w.checkAndNotify()
	if notifier.count() != 1 || !lastIsGitRepo(t, notifier) {
		t.Fatalf("after git init: %d notification(s), want one with is_git_repo=true", notifier.count())
	}

	poller.set(WorktreeState{})
	w.checkAndNotify()
	if notifier.count() != 2 || lastIsGitRepo(t, notifier) {
		t.Fatalf("after .git removed: %d notification(s), want a second with is_git_repo=false", notifier.count())
	}
}

// Polling pauses while nobody is subscribed, so a repository created in that
// time must still be what the next subscriber is told.
func TestWorktreeWatcher_SubscribeReadsFreshState(t *testing.T) {
	poller := &fakeWorktreePoller{}
	w := NewWorktreeWatcher(poller.poll)
	if err := w.Start(); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(w.Stop)

	poller.set(WorktreeState{IsGitRepo: true, Fingerprint: "main"})

	isGitRepo, err := w.Subscribe("client-1", &captureNotifier{})
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	if !isGitRepo {
		t.Error("Subscribe answered from the poll taken before git init")
	}
}
