package relay

import (
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func dialTestMux(t *testing.T, handler http.HandlerFunc) *Multiplexer {
	t.Helper()

	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/relay"
	conn, _, err := websocket.Dial(context.Background(), wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}

	mux := NewMultiplexer(conn, make(chan *VirtualStream, 1), nil, slog.Default())
	// Ping often so tests exercise several cycles quickly, but leave the timeout
	// generous: a pong that does arrive must never be judged late. Deciding a
	// healthy loopback connection is dead because the machine was busy is the
	// exact false positive keepAlive exists to avoid, and a test that reproduces
	// it under load is testing the scheduler rather than the code. Tests that
	// need the timeout to fire shorten it themselves.
	mux.pingInterval = 20 * time.Millisecond
	mux.pingTimeout = 5 * time.Second
	return mux
}

// A relay server that goes silent (stops reading, so it never answers pings)
// simulates the host waking from sleep with a half-open connection. keepAlive
// must detect this and make Run return so runWithReconnect can reconnect.
func TestMultiplexerKeepAliveDetectsDeadConnection(t *testing.T) {
	serverDone := make(chan struct{})
	defer close(serverDone)

	mux := dialTestMux(t, func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		<-serverDone // Never read, so pings are never answered.
	})

	// This is the one test that needs the timeout to elapse, so it has to be
	// short enough to fit the budget below. Being on a slow machine only makes
	// the pong later, which is the outcome this test wants either way.
	mux.pingTimeout = 50 * time.Millisecond

	start := time.Now()
	runErr := make(chan error, 1)
	go func() { runErr <- mux.Run(context.Background()) }()

	select {
	case err := <-runErr:
		if err == nil {
			t.Fatal("Run returned nil, want error from closed connection")
		}
		// Attribute the return to a ping cycle, not an unrelated immediate
		// close: it must take at least one ping interval to fire.
		if elapsed := time.Since(start); elapsed < mux.pingInterval {
			t.Fatalf("Run returned after %v, before the first ping could time out", elapsed)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not return; keepalive failed to detect the dead connection")
	}
}

// A responsive server must not trigger a false-positive close: as long as pongs
// arrive, Run stays up across many ping cycles.
func TestMultiplexerKeepAliveHealthyConnectionStaysUp(t *testing.T) {
	mux := dialTestMux(t, func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		for { // Keep reading so control pings are answered with pongs.
			if _, _, err := c.Read(r.Context()); err != nil {
				return
			}
		}
	})

	runErr := make(chan error, 1)
	go func() { runErr <- mux.Run(context.Background()) }()

	select {
	case err := <-runErr:
		t.Fatalf("Run returned unexpectedly on healthy connection: %v", err)
	case <-time.After(300 * time.Millisecond):
		// Survived multiple ping cycles.
	}
	mux.conn.Close(websocket.StatusNormalClosure, "")
}
