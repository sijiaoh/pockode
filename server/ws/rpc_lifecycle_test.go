package ws

import (
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/sourcegraph/jsonrpc2"
)

// idleStream is a jsonrpc2 stream that never yields a message and records what
// is written to it, so a test can build a real *jsonrpc2.Conn and observe when
// a handler replies.
type idleStream struct {
	written chan any
	closed  chan struct{}
}

func newIdleStream() *idleStream {
	return &idleStream{written: make(chan any, 4), closed: make(chan struct{})}
}

func (s *idleStream) ReadObject(any) error { <-s.closed; return io.EOF }
func (s *idleStream) WriteObject(v any) error {
	s.written <- v
	return nil
}
func (s *idleStream) Close() error { close(s.closed); return nil }

// jsonrpc2 starts dispatching on its own goroutine as soon as NewConn is
// called, which is before HandleStream can finish wiring the state — and on a
// relay stream the client's first request is often already buffered, so this is
// the common case, not a corner one. A handler that ran early would subscribe
// the still-nil notifier to the worktree, an entry cleanup can never remove
// because it unsubscribes the real one: the connection dies, the entry stays,
// and the next worktree notification dereferences it.
func TestRPCMethodHandler_HandleWaitsForConnectionState(t *testing.T) {
	state := &rpcConnState{ready: make(chan struct{}), log: slog.New(slog.DiscardHandler)}
	handler := &rpcMethodHandler{
		RPCHandler: &RPCHandler{},
		state:      state,
		log:        slog.New(slog.DiscardHandler),
	}

	// The stream never yields a request, so this connection only ever dispatches
	// what the test hands to Handle directly.
	stream := newIdleStream()
	conn := jsonrpc2.NewConn(bgCtx, stream, handler)

	// Unauthenticated, so the handler's first act once it may run is to reply
	// with an error — which is what makes "did it run yet" observable.
	go handler.Handle(bgCtx, conn, &jsonrpc2.Request{Method: "work.list.subscribe"})

	select {
	case reply := <-stream.written:
		t.Fatalf("Handle ran against a connection state that was still being built: replied %v", reply)
	case <-time.After(50 * time.Millisecond):
	}

	state.setConn(conn)
	if state.notifier == nil || state.subscriptions == nil {
		t.Fatal("setConn must publish the notifier and subscription map before releasing handlers")
	}

	select {
	case <-stream.written:
	case <-time.After(5 * time.Second):
		t.Fatal("Handle stayed blocked after the connection state was ready")
	}
}

// A worktree.switch (or auth) can be processed on its own goroutine while the
// connection is simultaneously torn down (mobile clients drop often). Without a
// closed guard the switch would re-bind a worktree after cleanup released it,
// leaking the worktree and every watcher/process it owns forever.
func TestRPCConnState_BindWorktree_RejectedAfterClose(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	wt := env.getMainWorktree()
	defer env.worktreeManager.Release(wt)

	state := &rpcConnState{
		notifier: NewJSONRPCNotifier(nil),
		closed:   true, // connection already cleaned up
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
		notifier: NewJSONRPCNotifier(nil),
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
