package relay

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestBuildRemoteURL(t *testing.T) {
	tests := []struct {
		name string
		cfg  *StoredConfig
		want string
	}{
		{
			name: "production",
			cfg: &StoredConfig{
				Subdomain:   "abc123def456ghi789jkl0123",
				RelayServer: "cloud.pockode.com",
			},
			want: "https://abc123def456ghi789jkl0123.cloud.pockode.com",
		},
		{
			name: "local development",
			cfg: &StoredConfig{
				Subdomain:   "dev123",
				RelayServer: "local.pockode.com",
			},
			want: "http://dev123.local.pockode.com",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := buildRemoteURL(tt.cfg)
			if got != tt.want {
				t.Errorf("buildRemoteURL() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestBuildRelayWSURL(t *testing.T) {
	tests := []struct {
		name string
		cfg  *StoredConfig
		want string
	}{
		{
			name: "production",
			cfg: &StoredConfig{
				Subdomain:   "abc123def456ghi789jkl0123",
				RelayServer: "cloud.pockode.com",
			},
			want: "wss://abc123def456ghi789jkl0123.cloud.pockode.com/relay",
		},
		{
			name: "local development",
			cfg: &StoredConfig{
				Subdomain:   "dev123",
				RelayServer: "local.pockode.com",
			},
			want: "ws://dev123.local.pockode.com/relay",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := buildRelayWSURL(tt.cfg)
			if got != tt.want {
				t.Errorf("buildRelayWSURL() = %v, want %v", got, tt.want)
			}
		})
	}
}

// The uplink handshake is the only place compression is agreed, and its result
// is invisible afterwards — so it is checked here against a stand-in cloud
// configured the way the real one is.
//
// Offering no_context_takeover would let the cloud settle on it too, which
// costs interactive traffic all of its compression while bulk responses go on
// compressing normally. Nothing else on either side would look broken.
func TestUplinkDialOptionsNegotiateContextTakeover(t *testing.T) {
	var gotAuth string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
			// Mirrors the cloud relay's AcceptOptions.
			CompressionMode: websocket.CompressionContextTakeover,
		})
		if err != nil {
			return
		}
		conn.Close(websocket.StatusNormalClosure, "")
	}))
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn, resp, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http"), newTestManager(5*time.Second).uplinkDialOptions("secret-token"))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.CloseNow()

	if gotAuth != "Bearer secret-token" {
		t.Errorf("Authorization = %q, want %q", gotAuth, "Bearer secret-token")
	}
	got := resp.Header.Get("Sec-WebSocket-Extensions")
	if !strings.Contains(got, "permessage-deflate") {
		t.Fatalf("Sec-WebSocket-Extensions = %q, want permessage-deflate", got)
	}
	if strings.Contains(got, "no_context_takeover") {
		t.Errorf("Sec-WebSocket-Extensions = %q, want context takeover in both directions", got)
	}
}

// newTestManager builds a Manager with only what the uplink needs, so a test
// can dial without registering with a cloud first.
func newTestManager(connectTimeout time.Duration) *Manager {
	return &Manager{log: testLogger(), connectTimeout: connectTimeout}
}

// A relay that accepts the TCP connection and then answers nothing must not
// park the dial forever: nothing keeps the tunnel honest before the handshake
// completes, so an unbounded dial would freeze the reconnect loop for good.
// That is what a blackholed network looks like from here — no data, no error,
// no FIN — as opposed to a refused connection, which fails fast on its own.
func TestUplinkDialOptionsBoundTheHandshake(t *testing.T) {
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-release
	}))
	// Release before closing: Close waits for the handler, and the handler is
	// waiting on release.
	defer func() {
		close(release)
		server.Close()
	}()

	m := newTestManager(200 * time.Millisecond)
	url := "ws" + strings.TrimPrefix(server.URL, "http")

	done := make(chan error, 1)
	go func() {
		conn, _, err := websocket.Dial(context.Background(), url, m.uplinkDialOptions("token"))
		if err == nil {
			conn.CloseNow()
		}
		done <- err
	}()

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("dial returned nil, want a timeout error")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("dial blocked on a stalled handshake; the reconnect loop can never retry")
	}
}

// The dial timeout is scoped to the handshake by the library, which derives a
// timeout context from it and cancels that context the moment Dial returns. If
// that cancellation reached the established connection instead, every tunnel
// would die exactly connectTimeout after coming up — not on any error path, but
// on the normal one — and the reconnect loop would look like a working relay
// that drops every 15 s.
func TestUplinkDialOptionsDoNotTruncateTheTunnel(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
			CompressionMode: tunnelCompression,
		})
		if err != nil {
			return
		}
		defer conn.CloseNow()
		for {
			typ, data, err := conn.Read(r.Context())
			if err != nil {
				return
			}
			if err := conn.Write(r.Context(), typ, data); err != nil {
				return
			}
		}
	}))
	defer server.Close()

	const dialTimeout = 200 * time.Millisecond
	m := newTestManager(dialTimeout)
	conn, _, err := websocket.Dial(context.Background(),
		"ws"+strings.TrimPrefix(server.URL, "http"), m.uplinkDialOptions("token"))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.CloseNow()

	time.Sleep(2 * dialTimeout)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := conn.Write(ctx, websocket.MessageBinary, []byte("still here")); err != nil {
		t.Fatalf("write once the dial timeout had elapsed: %v", err)
	}
	_, got, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("read once the dial timeout had elapsed: %v", err)
	}
	if string(got) != "still here" {
		t.Fatalf("echoed %q, want %q", got, "still here")
	}
}

// tunnelConn hangs up rather than running a close handshake. A peer that has
// stopped answering never completes one, and waiting on it costs the reconnect
// loop up to 25 s of the library's internal timeouts — which is spent on
// exactly the path where the tunnel is already known to be dead.
func TestTunnelConnCloseDoesNotWaitOnASilentPeer(t *testing.T) {
	accepted := make(chan struct{})
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.CloseNow()
		// Never reads, so the close frame is never answered.
		close(accepted)
		<-release
	}))
	defer func() {
		close(release)
		server.Close()
	}()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	<-accepted

	tunnel := tunnelConn{Conn: websocket.NetConn(ctx, conn, websocket.MessageBinary), ws: conn}

	closed := make(chan struct{})
	go func() {
		defer close(closed)
		_ = tunnel.Close()
	}()

	select {
	case <-closed:
	case <-time.After(2 * time.Second):
		t.Fatal("Close waited on a close handshake the peer will never answer; the reconnect loop stalls with it")
	}
}
