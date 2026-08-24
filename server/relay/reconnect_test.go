package relay

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

func newTestManager(connectTimeout time.Duration) *Manager {
	return &Manager{
		log:            slog.New(slog.DiscardHandler),
		newStreamCh:    make(chan *VirtualStream, 8),
		connectTimeout: connectTimeout,
	}
}

// stubRelay is a relay server that can be switched to "stalled": it then holds
// requests open without ever answering. That is what a blackholed network looks
// like to the client — no data, no error, no FIN — as opposed to a refused
// connection, which fails fast on its own.
type stubRelay struct {
	url             string
	stalled         atomic.Bool
	attempts        atomic.Int32
	stalledAttempts atomic.Int32
	connected       chan int
	tokens          chan string
	release         chan struct{}

	liveMu sync.Mutex
	live   []*websocket.Conn
}

// dropTunnels kills the established connections the way a lost network route
// does: the sockets go away without a WebSocket close handshake.
func (s *stubRelay) dropTunnels() {
	s.liveMu.Lock()
	live := s.live
	s.live = nil
	s.liveMu.Unlock()

	for _, conn := range live {
		conn.CloseNow()
	}
}

func (s *stubRelay) track(conn *websocket.Conn) {
	s.liveMu.Lock()
	defer s.liveMu.Unlock()
	s.live = append(s.live, conn)
}

func newStubRelay(t *testing.T) *stubRelay {
	t.Helper()

	s := &stubRelay{
		connected: make(chan int, 8),
		tokens:    make(chan string, 8),
		release:   make(chan struct{}),
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempt := int(s.attempts.Add(1))
		if s.stalled.Load() {
			s.stalledAttempts.Add(1)
			<-s.release
			return
		}

		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.CloseNow()
		s.track(conn)

		var req registerRequest
		if err := wsjson.Read(r.Context(), conn, &req); err != nil {
			return
		}
		resp := map[string]any{
			"jsonrpc": "2.0",
			"id":      1,
			"result":  map[string]string{"status": "ok"},
		}
		if err := wsjson.Write(r.Context(), conn, resp); err != nil {
			return
		}
		s.tokens <- req.Params["relay_token"]
		s.connected <- attempt

		for { // Keep reading so keepalive pings are answered.
			if _, _, err := conn.Read(r.Context()); err != nil {
				return
			}
		}
	}))

	t.Cleanup(func() {
		close(s.release)
		s.dropTunnels()
		srv.Close()
	})

	s.url = "ws" + strings.TrimPrefix(srv.URL, "http") + "/relay"
	return s
}

// A relay that accepts the TCP connection but never completes the WebSocket
// handshake must not park connectAndRun forever: nothing pings yet at this
// stage, so an unbounded dial freezes the whole reconnect loop.
func TestConnectAndRunFailsWhenHandshakeStalls(t *testing.T) {
	s := newStubRelay(t)
	s.stalled.Store(true)

	m := newTestManager(200 * time.Millisecond)

	done := make(chan error, 1)
	go func() { done <- m.connectAndRun(context.Background(), s.url, "token", 1) }()

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("connectAndRun returned nil, want dial error")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("connectAndRun blocked on a stalled handshake; the reconnect loop can never retry")
	}
}

// Same contract one step later: the handshake succeeds but the register
// response never arrives. The multiplexer (and its keepalive) has not started
// yet, so register needs its own bound.
func TestConnectAndRunFailsWhenRegisterResponseStalls(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.CloseNow()
		<-r.Context().Done() // Accept the upgrade, then answer nothing.
	}))
	t.Cleanup(srv.Close)

	m := newTestManager(200 * time.Millisecond)
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/relay"

	done := make(chan error, 1)
	go func() { done <- m.connectAndRun(context.Background(), url, "token", 1) }()

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("connectAndRun returned nil, want register error")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("connectAndRun blocked waiting for a register response; the reconnect loop can never retry")
	}
}

// The register timeout is cancelled as soon as the round-trip finishes, while
// the connection lives on. If that cancellation reached the connection it would
// tear down every tunnel the instant it came up, so pin the behaviour down.
func TestConnectAndRunKeepsTunnelAliveAfterRegister(t *testing.T) {
	s := newStubRelay(t)
	m := newTestManager(200 * time.Millisecond)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan error, 1)
	go func() { done <- m.connectAndRun(ctx, s.url, "token", 1) }()

	select {
	case <-s.connected:
	case <-time.After(5 * time.Second):
		t.Fatal("connection never established")
	}

	select {
	case err := <-done:
		t.Fatalf("tunnel died right after register: %v", err)
	case <-time.After(500 * time.Millisecond):
		// Still up, well past the register round-trip.
	}
}

// The reported bug: after the machine loses its network and gets it back, the
// tunnel must come up again on its own.
func TestRunWithReconnectRecoversAfterNetworkOutage(t *testing.T) {
	s := newStubRelay(t)
	m := newTestManager(200 * time.Millisecond)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan struct{})
	go func() {
		defer close(done)
		m.runWithReconnect(ctx, s.url, "token")
	}()

	select {
	case <-s.connected:
		if token := <-s.tokens; token != "token" {
			t.Fatalf("registered with relay_token %q, want %q", token, "token")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("initial connection never established")
	}

	// Network goes away: the live tunnel dies and new attempts hang unanswered.
	s.stalled.Store(true)
	s.dropTunnels()

	// The outage must outlast at least one reconnect attempt, otherwise the
	// loop only ever sees a clean disconnect and the test would pass even with
	// an unbounded connect path — which is the very bug being guarded against.
	deadline := time.Now().Add(20 * time.Second)
	for s.stalledAttempts.Load() == 0 {
		if time.Now().After(deadline) {
			t.Fatal("no reconnect was attempted while the network was down")
		}
		time.Sleep(10 * time.Millisecond)
	}

	s.stalled.Store(false) // Network is back.

	select {
	case attempt := <-s.connected:
		if attempt < 3 {
			t.Fatalf("reconnected on attempt %d, want an attempt after the stalled one", attempt)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("relay never reconnected after the network recovered")
	}

	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("runWithReconnect did not stop after context cancellation")
	}
}

// Guards against the reconnect loop leaking readers: streams belonging to a
// dead tunnel must be closed, otherwise every jsonrpc2 connection from before
// the outage stays blocked in ReadObject forever.
func TestMultiplexerClosesStreamsWhenRunReturns(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.CloseNow()
		if err := conn.Write(r.Context(), websocket.MessageText,
			[]byte(`{"connection_id":"c1","type":"message","payload":{"jsonrpc":"2.0"}}`)); err != nil {
			return
		}
		<-r.Context().Done()
	}))
	t.Cleanup(srv.Close)

	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/relay"
	conn, _, err := websocket.Dial(context.Background(), url, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}

	newStreamCh := make(chan *VirtualStream, 1)
	mux := NewMultiplexer(conn, newStreamCh, nil, slog.New(slog.DiscardHandler))

	ctx, cancel := context.WithCancel(context.Background())
	runDone := make(chan struct{})
	go func() {
		defer close(runDone)
		mux.Run(ctx)
	}()

	var stream *VirtualStream
	select {
	case stream = <-newStreamCh:
	case <-time.After(5 * time.Second):
		t.Fatal("stream was never created")
	}

	readDone := make(chan error, 1)
	go func() {
		var delivered any
		if err := stream.ReadObject(&delivered); err != nil {
			readDone <- fmt.Errorf("draining the delivered message: %w", err)
			return
		}
		var afterClose any
		readDone <- stream.ReadObject(&afterClose)
	}()

	cancel()
	<-runDone

	select {
	case err := <-readDone:
		if !errors.Is(err, io.EOF) {
			t.Fatalf("ReadObject returned %v, want io.EOF after the tunnel died", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("ReadObject still blocked after Run returned; the stream was never closed")
	}
}
