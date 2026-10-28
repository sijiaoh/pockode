package relay

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// No relay server gets a scheme of its own: the local development relay is
// TLS like production.
func TestBuildRelayURLs(t *testing.T) {
	cfg := &StoredConfig{Subdomain: "abc123", RelayServer: "local.pockode.com"}
	if got, want := buildRemoteURL(cfg), "https://abc123.local.pockode.com"; got != want {
		t.Errorf("buildRemoteURL() = %v, want %v", got, want)
	}
	if got, want := buildRelayWSURL(cfg), "wss://abc123.local.pockode.com/relay"; got != want {
		t.Errorf("buildRelayWSURL() = %v, want %v", got, want)
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

// The reconnect loop renews credentials only on ErrInvalidToken, so a 401 must
// come back as one and any other refusal must not.
func TestDialUplinkReportsOnlyARejectedTokenAsInvalid(t *testing.T) {
	tests := []struct {
		status      int
		wantInvalid bool
	}{
		{http.StatusUnauthorized, true},
		{http.StatusServiceUnavailable, false},
	}

	for _, tt := range tests {
		t.Run(http.StatusText(tt.status), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tt.status)
			}))
			defer server.Close()

			conn, err := newTestManager(5*time.Second).dialUplink(context.Background(), "ws"+strings.TrimPrefix(server.URL, "http"), "token")
			if err == nil {
				conn.CloseNow()
				t.Fatal("dial succeeded, want an error")
			}
			if got := errors.Is(err, ErrInvalidToken); got != tt.wantInvalid {
				t.Errorf("errors.Is(%v, ErrInvalidToken) = %v, want %v", err, got, tt.wantInvalid)
			}
		})
	}
}

// Renewal makes the check startup makes. A token the cloud has lost track of is
// replaced by a new registration; one it still confirms is kept, since
// registering anew would move the server to a new subdomain for nothing. Only
// a URL that actually moved is reported as a change, and a cloud that demands
// a newer client leaves no URL at all: the rejected one is dead.
func TestRenewCredentials(t *testing.T) {
	stale := StoredConfig{Subdomain: "kept", RelayToken: "old-token", RelayServer: "cloud.pockode.com"}
	registered := StoredConfig{Subdomain: "fresh", RelayToken: "new-token", RelayServer: "cloud.pockode.com"}

	tests := []struct {
		name           string
		refreshStatus  int
		registerStatus int           // 0: registering is not expected
		want           *StoredConfig // nil: renewal fails with wantErr
		wantErr        error
		wantChanges    []string
	}{
		{
			name:           "invalid token re-registers",
			refreshStatus:  http.StatusUnauthorized,
			registerStatus: http.StatusCreated,
			want:           &registered,
			wantChanges:    []string{buildRemoteURL(&registered)},
		},
		{
			name:          "confirmed token is kept",
			refreshStatus: http.StatusOK,
			want:          &stale,
		},
		{
			name:           "refused registration ends remote access",
			refreshStatus:  http.StatusUnauthorized,
			registerStatus: http.StatusForbidden,
			wantErr:        ErrUpgradeRequired,
			wantChanges:    []string{""},
		},
		{
			name:          "refused refresh ends remote access",
			refreshStatus: http.StatusForbidden,
			wantErr:       ErrUpgradeRequired,
			wantChanges:   []string{""},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cloud := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch {
				case r.URL.Path == "/api/relay/refresh" && tt.refreshStatus == http.StatusOK:
					json.NewEncoder(w).Encode(stale)
				case r.URL.Path == "/api/relay/refresh":
					w.WriteHeader(tt.refreshStatus)
				case r.URL.Path == "/api/relay/register" && tt.registerStatus == http.StatusCreated:
					w.WriteHeader(http.StatusCreated)
					json.NewEncoder(w).Encode(registered)
				case r.URL.Path == "/api/relay/register" && tt.registerStatus != 0:
					w.WriteHeader(tt.registerStatus)
				default:
					t.Errorf("unexpected request to %s", r.URL.Path)
					w.WriteHeader(http.StatusInternalServerError)
				}
			}))
			defer cloud.Close()

			dataDir := t.TempDir()
			if err := NewStore(dataDir).Save(&stale); err != nil {
				t.Fatalf("save: %v", err)
			}
			var m *Manager
			var changes []string
			cfg := Config{
				CloudURL: cloud.URL,
				DataDir:  dataDir,
				OnRemoteURLChange: func(url string) {
					// Consumers read the URL back rather than keep the argument,
					// so it has to be in place before they are told.
					if got := m.RemoteURL(); got != url {
						t.Errorf("RemoteURL() during OnRemoteURLChange = %q, want %q", got, url)
					}
					changes = append(changes, url)
				},
			}
			m = NewManager(cfg, 0, 0, testLogger())
			m.setRemoteURL(buildRemoteURL(&stale))

			got, err := m.renewCredentials(context.Background())
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("renewCredentials error = %v, want %v", err, tt.wantErr)
			}

			wantURL := ""
			if tt.want != nil {
				wantURL = buildRemoteURL(tt.want)
				if *got != *tt.want {
					t.Errorf("renewed config = %+v, want %+v", *got, *tt.want)
				}
				saved, err := NewStore(dataDir).Load()
				if err != nil {
					t.Fatalf("load: %v", err)
				}
				if *saved != *tt.want {
					t.Errorf("stored config = %+v, want %+v", *saved, *tt.want)
				}
			}
			if m.RemoteURL() != wantURL {
				t.Errorf("RemoteURL() = %q, want %q", m.RemoteURL(), wantURL)
			}
			if !slices.Equal(changes, tt.wantChanges) {
				t.Errorf("OnRemoteURLChange calls = %q, want %q", changes, tt.wantChanges)
			}
		})
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

	// Unlike TestUplinkDialOptionsBoundTheHandshake, which wants this budget to
	// run out, here the dial has to succeed — so the budget is a backstop, not
	// the thing under test, and sizing it tight makes the test fail for the one
	// reason it is not about. A local handshake runs 1-6ms at the median but
	// spikes to 48-107ms — 120 dials over four runs on a box already at load
	// ~22, three of them with eight busy loops on top. No idle window was
	// available, so those are loaded numbers only. The 200ms this used to use
	// was barely 2x the worst of them and duly timed out under `go test ./...`.
	// 1s is ~10x it; the test costs twice this in wall clock, which is the
	// reason not to go higher still.
	const dialTimeout = time.Second
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
