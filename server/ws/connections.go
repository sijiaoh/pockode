package ws

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/sourcegraph/jsonrpc2"
)

// Connections are the WebSocket connections a handler is serving, kept so that
// a shutdown can end them and wait for what is running on them.
//
// http.Server.Shutdown does neither: a WebSocket is a hijacked connection,
// which the server stops tracking the moment it is handed over. Left alone, a
// connection lives until the process exits, and so does every request running
// on it — including a commit message draft, whose AI CLI is killed only when
// its connection's context ends. Where the process does not exit right away (a
// restart on Windows waits on its successor) a client would also stay connected
// to a server that is no longer there instead of reconnecting to the new one.
type Connections struct {
	stopCtx context.Context
	stop    context.CancelFunc

	// stateMu orders a connection or request being added against Close
	// starting to wait: a WaitGroup must not gain a member while being waited
	// on from zero.
	stateMu sync.Mutex
	closed  bool
	running sync.WaitGroup
}

// NewConnections returns an empty set.
func NewConnections() *Connections {
	ctx, cancel := context.WithCancel(context.Background())
	return &Connections{stopCtx: ctx, stop: cancel}
}

// Serve runs serve for conn. The context serve gets ends, and conn is closed
// with StatusGoingAway, when Close is called; a connection arriving after that
// is closed at once.
func (c *Connections) Serve(ctx context.Context, conn *websocket.Conn, serve func(ctx context.Context)) {
	if !c.add() {
		conn.Close(websocket.StatusGoingAway, "server shutting down")
		return
	}
	defer c.running.Done()

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	stopAfter := context.AfterFunc(c.stopCtx, func() {
		cancel()
		conn.Close(websocket.StatusGoingAway, "server shutting down")
	})
	defer stopAfter()

	serve(ctx)
}

// AsyncHandler is jsonrpc2.AsyncHandler with every request counted, so that
// Close waits for requests still running after their connection has ended.
//
// A request arriving once Close has begun is dropped. That is rare but not
// impossible: a handler that closes its own connection (an auth refusal) lets
// Serve return while the read loop may still dispatch one more request, and
// counting that one while Close is already waiting is what a WaitGroup
// forbids.
func (c *Connections) AsyncHandler(h jsonrpc2.Handler) jsonrpc2.Handler {
	return asyncHandler{h: h, conns: c}
}

type asyncHandler struct {
	h     jsonrpc2.Handler
	conns *Connections
}

func (a asyncHandler) Handle(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	if !a.conns.add() {
		return
	}
	go func() {
		defer a.conns.running.Done()
		a.h.Handle(ctx, conn, req)
	}()
}

// add counts one more connection or request, unless Close has begun.
func (c *Connections) add() bool {
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	if c.closed {
		return false
	}
	c.running.Add(1)
	return true
}

// Close ends every connection and waits, up to timeout, for them and the
// requests running on them to finish. Requests see their context end, which is
// what stops the subprocesses they started. One that ignores it is reported
// rather than waited for, so it cannot hold a shutdown forever.
func (c *Connections) Close(timeout time.Duration, log *slog.Logger) {
	c.stateMu.Lock()
	c.closed = true
	c.stateMu.Unlock()
	c.stop()

	done := make(chan struct{})
	go func() {
		c.running.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(timeout):
		log.Warn("shutdown timed out waiting for websocket requests to finish", "timeout", timeout)
	}
}
