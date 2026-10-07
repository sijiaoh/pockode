package relay

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
)

var testSite = newPreviewSite(&StoredConfig{Subdomain: "abc123", RelayServer: "cloud.pockode.com"})

func previewHost(port int) string {
	return "abc123-" + strconv.Itoa(port) + ".cloud.pockode.com"
}

func TestPreviewSiteRecognizesPreviewHosts(t *testing.T) {
	tests := []struct {
		host     string
		wantPort int
		wantOK   bool
	}{
		{"abc123-5173.cloud.pockode.com", 5173, true},
		{"ABC123-5173.Cloud.Pockode.com", 5173, true},
		{"abc123-5173.cloud.pockode.com:443", 5173, true},
		{"abc123-5173.cloud.pockode.com.", 5173, true},
		{"abc123-1.cloud.pockode.com", 1, true},
		{"abc123-65535.cloud.pockode.com", 65535, true},

		// The app itself.
		{"abc123.cloud.pockode.com", 0, false},
		// Another tunnel's subdomain, or a subdomain that merely starts with ours.
		{"xyz789-5173.cloud.pockode.com", 0, false},
		{"abc1234-5173.cloud.pockode.com", 0, false},
		// Another relay server, or ours one level down.
		{"abc123-5173.other.example", 0, false},
		{"foo.abc123-5173.cloud.pockode.com", 0, false},
		// Not one canonical port number.
		{"abc123-.cloud.pockode.com", 0, false},
		{"abc123-0.cloud.pockode.com", 0, false},
		{"abc123-65536.cloud.pockode.com", 0, false},
		{"abc123-05173.cloud.pockode.com", 0, false},
		{"abc123-+5173.cloud.pockode.com", 0, false},
		{"abc123-51a3.cloud.pockode.com", 0, false},
	}

	for _, tt := range tests {
		t.Run(tt.host, func(t *testing.T) {
			port, ok := testSite.port(tt.host)
			if port != tt.wantPort || ok != tt.wantOK {
				t.Errorf("port(%q) = %d, %v; want %d, %v", tt.host, port, ok, tt.wantPort, tt.wantOK)
			}
		})
	}
}

// servePreviewProxy is serveProxy with this server's own ports set to one
// nothing listens on, so a preview request reaching them fails loudly.
func servePreviewProxy(t *testing.T) *httptest.Server {
	t.Helper()
	unused := closedPort(t)
	return serveProxy(t, unused, unused)
}

func previewRequest(t *testing.T, proxy *httptest.Server, port int, method, path string) *http.Request {
	t.Helper()
	req, err := http.NewRequest(method, proxy.URL+path, nil)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	req.Host = previewHost(port)
	req.AddCookie(&http.Cookie{Name: testSite.cookieName(), Value: testToken})
	return req
}

// noRedirects lets a test read the Location the proxy returned.
var noRedirects = &http.Client{
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

func doRequest(t *testing.T, req *http.Request) (*http.Response, string) {
	t.Helper()
	resp, err := noRedirects.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", req.Method, req.URL.Path, err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp, string(body)
}

// The previewed server must see what it would if the browser had opened
// localhost:<port> itself, or dev servers with a host allowlist answer 403 —
// and some (Next, Rails) read X-Forwarded-Host and -Proto as the request's
// host and scheme.
func TestPreviewProxyPresentsRequestsAsLocalhost(t *testing.T) {
	tests := []struct {
		name       string
		origin     func(port int) string
		wantOrigin func(port int) string
	}{
		{
			name:       "same-origin Origin is rewritten",
			origin:     func(port int) string { return "https://" + previewHost(port) },
			wantOrigin: func(port int) string { return "http://localhost:" + strconv.Itoa(port) },
		},
		{
			name:       "no Origin stays absent",
			origin:     func(int) string { return "" },
			wantOrigin: func(int) string { return "" },
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			seen := make(chan *http.Request, 1)
			port := startLocalServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				seen <- r.Clone(context.Background())
			}))
			proxy := servePreviewProxy(t)

			req := previewRequest(t, proxy, port, http.MethodGet, "/src/main.tsx?t=1")
			if origin := tt.origin(port); origin != "" {
				req.Header.Set("Origin", origin)
			}
			req.Header.Set("X-Forwarded-For", "203.0.113.7")
			req.Header.Set("X-Forwarded-Proto", "https")
			req.Header.Set("X-Forwarded-Host", previewHost(port))
			doRequest(t, req)

			got := <-seen
			wantHost := "localhost:" + strconv.Itoa(port)
			if got.Host != wantHost {
				t.Errorf("Host = %q, want %q", got.Host, wantHost)
			}
			if got.URL.RequestURI() != "/src/main.tsx?t=1" {
				t.Errorf("request URI = %q, want /src/main.tsx?t=1", got.URL.RequestURI())
			}
			if v, want := got.Header.Get("Origin"), tt.wantOrigin(port); v != want {
				t.Errorf("Origin = %q, want %q", v, want)
			}
			if v := got.Header.Get("X-Forwarded-For"); v != "203.0.113.7" {
				t.Errorf("X-Forwarded-For = %q, want 203.0.113.7", v)
			}
			for _, h := range []string{"X-Forwarded-Proto", "X-Forwarded-Host"} {
				if v := got.Header.Get(h); v != "" {
					t.Errorf("%s = %q, want none: it would contradict Host", h, v)
				}
			}
		})
	}
}

// Dev servers build absolute redirects from the Host they were reached with,
// which is localhost:<port> once rewritten.
func TestPreviewProxyRewritesRedirectsToLocalhost(t *testing.T) {
	tests := []struct {
		name     string
		location func(host string) string
		want     func(port int) string
	}{
		{
			name:     "absolute to the previewed port",
			location: func(host string) string { return "http://" + host + "/login?next=%2F#top" },
			want:     func(port int) string { return "https://" + previewHost(port) + "/login?next=%2F#top" },
		},
		{
			name:     "scheme-relative to the previewed port",
			location: func(host string) string { return "//" + host + "/login" },
			want:     func(port int) string { return "https://" + previewHost(port) + "/login" },
		},
		{
			name:     "relative",
			location: func(string) string { return "/login" },
			want:     func(int) string { return "/login" },
		},
		{
			name:     "elsewhere",
			location: func(string) string { return "https://auth.example/authorize" },
			want:     func(int) string { return "https://auth.example/authorize" },
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			port := startLocalServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Location", tt.location(r.Host))
				w.WriteHeader(http.StatusFound)
			}))
			proxy := servePreviewProxy(t)

			resp, _ := doRequest(t, previewRequest(t, proxy, port, http.MethodGet, "/"))
			if got, want := resp.Header.Get("Location"), tt.want(port); got != want {
				t.Errorf("Location = %q, want %q", got, want)
			}
		})
	}
}

// dialPreview opens a WebSocket to the preview host of port, reaching it
// through proxy as the cloud would.
func dialPreview(ctx context.Context, proxy *httptest.Server, port int, origin string) (*websocket.Conn, *http.Response, error) {
	proxyAddr := strings.TrimPrefix(proxy.URL, "http://")
	client := &http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, network, proxyAddr)
		},
	}}
	return websocket.Dial(ctx, "ws://"+previewHost(port)+"/hmr", &websocket.DialOptions{
		HTTPClient: client,
		HTTPHeader: http.Header{
			"Origin": {origin},
			"Cookie": {testSite.cookieName() + "=" + testToken},
		},
	})
}

// The previewed server accepts with coder/websocket's default same-origin
// check, standing in for a dev server's own: it only passes if Host and Origin
// were rewritten together.
//
// The upgrade carries the preview cookie like any other request, and must lose
// it on the way just the same.
func TestPreviewProxyRelaysSameOriginWebSocket(t *testing.T) {
	port := startLocalServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close(websocket.StatusNormalClosure, "")
		_ = conn.Write(r.Context(), websocket.MessageText, []byte("connected; cookie="+r.Header.Get("Cookie")))
	}))
	proxy := servePreviewProxy(t)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn, _, err := dialPreview(ctx, proxy, port, "http://"+previewHost(port))
	if err != nil {
		t.Fatalf("dial through preview: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	_, got, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(got) != "connected; cookie=" {
		t.Errorf("message = %q, want %q", got, "connected; cookie=")
	}
}

// Another site must not be able to open the preview's WebSocket on the user's
// behalf, whatever the previewed server would have allowed.
func TestPreviewProxyRefusesCrossOriginWebSocket(t *testing.T) {
	var reached atomic.Bool
	port := startLocalServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reached.Store(true)
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		conn.CloseNow()
	}))
	proxy := servePreviewProxy(t)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn, resp, err := dialPreview(ctx, proxy, port, "https://evil.example")
	if err == nil {
		conn.CloseNow()
		t.Fatal("cross-origin upgrade succeeded")
	}
	if resp == nil || resp.StatusCode != http.StatusForbidden {
		t.Errorf("response = %v, want status %d", resp, http.StatusForbidden)
	}
	if reached.Load() {
		t.Error("the cross-origin upgrade was forwarded")
	}
}

func TestPreviewProxyReturnsBadGateway(t *testing.T) {
	tests := []struct {
		name string
		port func(t *testing.T) int
		// The body must tell a server that is not running from one that is
		// running but failed: the advice differs.
		want string
	}{
		{name: "nothing listens", port: closedPort, want: "nothing is listening on localhost:"},
		{name: "the server hangs up", port: hangUpPort, want: "did not answer"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			port := tt.port(t)
			proxy := servePreviewProxy(t)

			resp, body := doRequest(t, previewRequest(t, proxy, port, http.MethodGet, "/"))
			if resp.StatusCode != http.StatusBadGateway {
				t.Errorf("status = %d, want %d", resp.StatusCode, http.StatusBadGateway)
			}
			if !strings.Contains(body, tt.want) || !strings.Contains(body, "localhost:"+strconv.Itoa(port)) {
				t.Errorf("body = %q, want it to contain %q and name the port", body, tt.want)
			}
		})
	}
}

// hangUpPort returns a port whose listener accepts connections and closes them
// without answering.
func hangUpPort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { listener.Close() })
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			conn.Close()
		}
	}()
	return listener.Addr().(*net.TCPAddr).Port
}

func TestPreviewProxyDoesNotForward(t *testing.T) {
	tests := []struct {
		name string
		path string
	}{
		{name: "the reserved prefix", path: "/__pockode/anything"},
		// The previewed port is not this server's own: another Pockode on the
		// machine serves the same route.
		{name: "local-only routes on any port", path: "/api/mcp/tools/call"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var reached atomic.Bool
			port := startLocalServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				reached.Store(true)
			}))
			proxy := serveProxy(t, closedPort(t), closedPort(t))

			resp, _ := doRequest(t, previewRequest(t, proxy, port, http.MethodGet, tt.path))
			if resp.StatusCode != http.StatusNotFound {
				t.Errorf("status = %d, want %d", resp.StatusCode, http.StatusNotFound)
			}
			if reached.Load() {
				t.Errorf("%s was forwarded", tt.path)
			}
		})
	}
}
