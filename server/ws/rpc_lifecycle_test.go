package ws

import (
	"testing"

	"github.com/pockode/server/watch"
)

// recordingWatcher captures Unsubscribe calls so tests can assert that a
// subscription created by an in-flight handler is torn down when the
// connection has already been cleaned up.
type recordingWatcher struct {
	unsubscribed []string
}

func (w *recordingWatcher) Start() error          { return nil }
func (w *recordingWatcher) Stop()                 {}
func (w *recordingWatcher) Unsubscribe(id string) { w.unsubscribed = append(w.unsubscribed, id) }

// A worktree.switch (or auth) can be processed on its own goroutine while the
// connection is simultaneously torn down (mobile clients drop often). Without a
// closed guard the switch would re-bind a worktree after cleanup released it,
// leaking the worktree and every watcher/process it owns forever.
func TestRPCConnState_BindWorktree_RejectedAfterClose(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	wt := env.getMainWorktree()
	defer env.worktreeManager.Release(wt)

	state := &rpcConnState{
		notifier:      NewJSONRPCNotifier(nil),
		subscriptions: map[string]watch.Watcher{},
		closed:        true, // connection already cleaned up
	}

	prev, noop, ok := state.bindWorktree(wt)
	if ok {
		t.Fatal("bindWorktree must reject a bind after the connection is closed")
	}
	if noop || prev != nil {
		t.Errorf("rejected bind should return zero values, got prev=%v noop=%v", prev, noop)
	}
	if state.worktree != nil {
		t.Error("a closed connection must not be re-bound to a worktree")
	}
}

// Pointer (not name) equality drives the no-op check so that a stale worktree
// instance is never mistaken for the live one.
func TestRPCConnState_BindWorktree_NoopOnSameInstance(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	wt := env.getMainWorktree()
	defer env.worktreeManager.Release(wt)

	state := &rpcConnState{
		notifier:      NewJSONRPCNotifier(nil),
		subscriptions: map[string]watch.Watcher{},
	}

	if prev, noop, ok := state.bindWorktree(wt); !ok || noop || prev != nil {
		t.Fatalf("first bind should be a real switch, got prev=%v noop=%v ok=%v", prev, noop, ok)
	}
	// The first bind subscribed our (conn-less) notifier to the shared worktree;
	// detach it so a later watcher notification can't reach a nil connection.
	defer wt.Unsubscribe(state.notifier)
	prev, noop, ok := state.bindWorktree(wt)
	if !ok || !noop {
		t.Fatalf("re-binding the same instance should be a no-op, got noop=%v ok=%v", noop, ok)
	}
	if prev != wt {
		t.Error("no-op bind should report the already-bound worktree as prev")
	}
}

// trackSubscription must drop (and unsubscribe) a subscription created by an
// in-flight handler once the connection is closed, otherwise the watcher slot
// leaks because cleanup already ran and will never see it.
func TestRPCConnState_TrackSubscription_UnsubscribesAfterClose(t *testing.T) {
	watcher := &recordingWatcher{}
	state := &rpcConnState{
		subscriptions: map[string]watch.Watcher{},
		closed:        true,
	}

	state.trackSubscription("sub-1", watcher)

	if len(watcher.unsubscribed) != 1 || watcher.unsubscribed[0] != "sub-1" {
		t.Errorf("expected orphaned subscription to be unsubscribed, got %v", watcher.unsubscribed)
	}
	if _, tracked := state.subscriptions["sub-1"]; tracked {
		t.Error("closed connection must not retain the subscription")
	}
}

func TestRPCConnState_TrackSubscription_TracksWhenOpen(t *testing.T) {
	watcher := &recordingWatcher{}
	state := &rpcConnState{
		subscriptions: map[string]watch.Watcher{},
	}

	state.trackSubscription("sub-1", watcher)

	if len(watcher.unsubscribed) != 0 {
		t.Errorf("open connection should not unsubscribe, got %v", watcher.unsubscribed)
	}
	if state.subscriptions["sub-1"] != watcher {
		t.Error("open connection should retain the subscription for later cleanup")
	}
}
