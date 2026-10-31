package ws

import (
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/sourcegraph/jsonrpc2"
)

// blockingHandler holds every request until its context ends, the way a
// commit message draft holds its AI CLI.
type blockingHandler struct {
	started chan struct{}
	ended   chan struct{}
}

func (h blockingHandler) Handle(ctx context.Context, _ *jsonrpc2.Conn, _ *jsonrpc2.Request) {
	close(h.started)
	<-ctx.Done()
	// Long enough that a Close that did not wait would return first.
	time.Sleep(50 * time.Millisecond)
	close(h.ended)
}

// TestConnections_CloseEndsConnectionsAndWaitsForRequests covers what
// http.Server.Shutdown leaves out: a hijacked connection is closed, the request
// running on it sees its context end, and Close returns only once that request
// has.
func TestConnections_CloseEndsConnectionsAndWaitsForRequests(t *testing.T) {
	conns := NewConnections()
	handler := blockingHandler{started: make(chan struct{}), ended: make(chan struct{})}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Errorf("accept: %v", err)
			return
		}
		conns.Serve(r.Context(), conn, func(ctx context.Context) {
			stream := NewWebSocketStream(conn, slog.New(slog.DiscardHandler))
			rpcConn := jsonrpc2.NewConn(ctx, stream, conns.AsyncHandler(handler))
			<-rpcConn.DisconnectNotify()
		})
	}))
	defer srv.Close()

	client, err := dialTestClient(bgCtx, srv.URL)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer client.CloseNow()
	if err := client.Write(bgCtx, websocket.MessageText, []byte(`{"jsonrpc":"2.0","id":1,"method":"block"}`)); err != nil {
		t.Fatalf("write: %v", err)
	}
	select {
	case <-handler.started:
	case <-time.After(5 * time.Second):
		t.Fatal("request never started")
	}

	// A client reads all the time, which is what answers the close handshake.
	ctx, cancel := context.WithTimeout(bgCtx, 5*time.Second)
	defer cancel()
	readErr := make(chan error, 1)
	go func() {
		_, _, err := client.Read(ctx)
		readErr <- err
	}()

	conns.Close(5*time.Second, slog.New(slog.DiscardHandler))

	select {
	case <-handler.ended:
	default:
		t.Fatal("Close returned while a request was still running")
	}
	err = <-readErr
	if status := websocket.CloseStatus(err); status != websocket.StatusGoingAway {
		t.Errorf("client read ended with %v, want close status %v", err, websocket.StatusGoingAway)
	}
}

func TestConnections_RefusesAfterClose(t *testing.T) {
	conns := NewConnections()
	conns.Close(time.Second, slog.New(slog.DiscardHandler))

	var served atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Errorf("accept: %v", err)
			return
		}
		conns.Serve(r.Context(), conn, func(context.Context) { served.Store(true) })
	}))
	defer srv.Close()

	client, err := dialTestClient(bgCtx, srv.URL)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer client.CloseNow()
	ctx, cancel := context.WithTimeout(bgCtx, 5*time.Second)
	defer cancel()
	_, _, err = client.Read(ctx)
	if status := websocket.CloseStatus(err); status != websocket.StatusGoingAway {
		t.Errorf("client read ended with %v, want close status %v", err, websocket.StatusGoingAway)
	}
	if served.Load() {
		t.Error("a connection arriving after Close was served")
	}
}
