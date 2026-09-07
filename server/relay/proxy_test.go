package relay

import (
	"context"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// startLocalServer stands in for one of this machine's own HTTP servers and
// reports the port newLocalProxy should be pointed at.
func startLocalServer(t *testing.T, handler http.Handler) int {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)

	parsed, err := url.Parse(server.URL)
	if err != nil {
		t.Fatalf("parse test server URL: %v", err)
	}
	port, err := strconv.Atoi(parsed.Port())
	if err != nil {
		t.Fatalf("parse test server port: %v", err)
	}
	return port
}

// serveProxy exposes newLocalProxy over its own listener so requests reach it
// the same way a relay stream would.
func serveProxy(t *testing.T, backendPort, frontendPort int) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(newLocalProxy(backendPort, frontendPort, testLogger()))
	t.Cleanup(server.Close)
	return server
}

func TestLocalProxyRoutesAPIPathsToBackendPort(t *testing.T) {
	// Which paths are API paths is apiroute's contract and is tested there;
	// what matters here is that each class reaches a different port.
	tests := []struct {
		path string
		want string
	}{
		{"/api/ping", "backend"},
		{"/ws", "backend"},
		{"/health", "backend"},
		{"/", "frontend"},
		{"/assets/app.js", "frontend"},
	}

	backendPort := startLocalServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("backend"))
	}))
	frontendPort := startLocalServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("frontend"))
	}))
	proxy := serveProxy(t, backendPort, frontendPort)

	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			resp, err := http.Get(proxy.URL + tt.path)
			if err != nil {
				t.Fatalf("get %s: %v", tt.path, err)
			}
			defer resp.Body.Close()
			body, _ := io.ReadAll(resp.Body)
			if string(body) != tt.want {
				t.Errorf("%s reached %q, want %q", tt.path, body, tt.want)
			}
		})
	}
}

// The relay carries the public host and client IP; both must reach the local
// server. Host in particular: the WebSocket handler rejects an upgrade whose
// Origin disagrees with it.
func TestLocalProxyForwardsPublicIdentity(t *testing.T) {
	seen := make(chan *http.Request, 1)
	port := startLocalServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen <- r.Clone(context.Background())
	}))
	proxy := serveProxy(t, port, port)

	req, err := http.NewRequest(http.MethodGet, proxy.URL+"/api/ping", nil)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	req.Host = "abc.pockode.com"
	req.Header.Set("X-Forwarded-For", "203.0.113.7")
	req.Header.Set("X-Forwarded-Proto", "https")
	req.Header.Set("X-Forwarded-Host", "abc.pockode.com")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	resp.Body.Close()

	got := <-seen
	if got.Host != "abc.pockode.com" {
		t.Errorf("Host = %q, want abc.pockode.com", got.Host)
	}
	if v := got.Header.Get("X-Forwarded-For"); v != "203.0.113.7" {
		t.Errorf("X-Forwarded-For = %q, want 203.0.113.7", v)
	}
	if v := got.Header.Get("X-Forwarded-Proto"); v != "https" {
		t.Errorf("X-Forwarded-Proto = %q, want https", v)
	}
	if v := got.Header.Get("X-Forwarded-Host"); v != "abc.pockode.com" {
		t.Errorf("X-Forwarded-Host = %q, want abc.pockode.com", v)
	}
}

// The backend accepts with the default same-origin policy, as it does in
// production, so this pins the consequence of preserving Host across the hop:
// rewrite Host and the upgrade is rejected instead of failing subtly later.
func TestLocalProxyRelaysWebSocketUpgrade(t *testing.T) {
	port := startLocalServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close(websocket.StatusNormalClosure, "")
		typ, msg, err := conn.Read(r.Context())
		if err != nil {
			return
		}
		_ = conn.Write(r.Context(), typ, append([]byte("echo:"), msg...))
	}))
	proxy := serveProxy(t, port, port)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(proxy.URL, "http")+"/ws", &websocket.DialOptions{
		HTTPHeader: http.Header{"Origin": {proxy.URL}},
	})
	if err != nil {
		t.Fatalf("dial through local proxy: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	if err := conn.Write(ctx, websocket.MessageText, []byte("ping")); err != nil {
		t.Fatalf("write: %v", err)
	}
	_, got, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(got) != "echo:ping" {
		t.Errorf("response = %q, want %q", got, "echo:ping")
	}
}

// A local backend that is down must produce an explicit 502, not a dead
// stream: the relay has no way to tell silence from a hang.
func TestLocalProxyReturnsBadGatewayWhenBackendIsDown(t *testing.T) {
	proxy := serveProxy(t, closedPort(t), closedPort(t))

	resp, err := http.Get(proxy.URL + "/api/ping")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadGateway {
		t.Errorf("status = %d, want %d", resp.StatusCode, http.StatusBadGateway)
	}
}

// Forwarding a local-only path would put this machine's own tools behind
// nothing but the public URL. Which paths those are is apiroute's contract and
// is tested there; that mcp's endpoint stays among them is pinned by
// mcp.TestAPIPathStaysLocalOnly. What matters here is that the proxy refuses
// one rather than forwarding it.
func TestLocalProxyRefusesLocalOnlyPaths(t *testing.T) {
	reached := false
	port := startLocalServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reached = true
	}))
	proxy := serveProxy(t, port, port)

	resp, err := http.Post(proxy.URL+"/api/mcp/tools/call", "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("status = %d, want %d", resp.StatusCode, http.StatusNotFound)
	}
	if reached {
		t.Error("the local MCP API was forwarded to the backend")
	}
}

// closedPort returns a port nothing is listening on: bind one, then release it.
func closedPort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	if err := listener.Close(); err != nil {
		t.Fatalf("close listener: %v", err)
	}
	return port
}
