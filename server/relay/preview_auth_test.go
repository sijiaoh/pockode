package relay

import (
	"context"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

const (
	testPassword = "correct horse"
	// testToken is a session every test store starts out with.
	testToken = "live-token"
)

type fakeSessions struct {
	liveMu sync.Mutex
	live   map[string]bool
	issued int
}

func newTestSessions() *fakeSessions {
	return &fakeSessions{live: map[string]bool{testToken: true}}
}

func (s *fakeSessions) Issue() (string, error) {
	s.liveMu.Lock()
	defer s.liveMu.Unlock()
	s.issued++
	token := "issued-" + strconv.Itoa(s.issued)
	s.live[token] = true
	return token, nil
}

func (s *fakeSessions) Validate(token string) bool {
	s.liveMu.Lock()
	defer s.liveMu.Unlock()
	return s.live[token]
}

func (s *fakeSessions) issuedCount() int {
	s.liveMu.Lock()
	defer s.liveMu.Unlock()
	return s.issued
}

// reachablePort starts a previewed server and reports whether anything got
// through to it.
func reachablePort(t *testing.T) (int, *atomic.Bool) {
	t.Helper()
	var reached atomic.Bool
	port := startLocalServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reached.Store(true)
	}))
	return port, &reached
}

func TestPreviewRefusesWithoutLiveSession(t *testing.T) {
	tests := []struct {
		name   string
		cookie string
	}{
		{name: "no cookie"},
		{name: "unknown session", cookie: "__Host-pockode_preview=forged"},
		// Any other subdomain of the relay domain can set this one, which is
		// why https reads only the __Host- name.
		{name: "the http cookie name under https", cookie: "pockode_preview=" + testToken},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			port, reached := reachablePort(t)
			proxy := servePreviewProxy(t)

			req := previewRequest(t, proxy, port, http.MethodGet, "/")
			req.Header.Del("Cookie")
			if tt.cookie != "" {
				req.Header.Set("Cookie", tt.cookie)
			}
			resp, _ := doRequest(t, req)

			if resp.StatusCode != http.StatusUnauthorized {
				t.Errorf("status = %d, want %d", resp.StatusCode, http.StatusUnauthorized)
			}
			if reached.Load() {
				t.Error("an unauthenticated request was forwarded")
			}
		})
	}
}

// Only a page load gets the login form; anything else gets a bare 401 rather
// than a form nobody will see.
func TestPreviewServesLoginPageOnlyToPageLoads(t *testing.T) {
	tests := []struct {
		name     string
		mode     string
		accept   string
		wantPage bool
	}{
		{name: "page load", mode: "navigate", wantPage: true},
		{name: "fetch", mode: "cors"},
		{name: "page load without fetch metadata", accept: "text/html,*/*", wantPage: true},
		{name: "script without fetch metadata", accept: "*/*"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			proxy := servePreviewProxy(t)

			req := previewRequest(t, proxy, closedPort(t), http.MethodGet, "/")
			req.Header.Del("Cookie")
			if tt.mode != "" {
				req.Header.Set("Sec-Fetch-Mode", tt.mode)
			}
			if tt.accept != "" {
				req.Header.Set("Accept", tt.accept)
			}
			resp, body := doRequest(t, req)

			if resp.StatusCode != http.StatusUnauthorized {
				t.Errorf("status = %d, want %d", resp.StatusCode, http.StatusUnauthorized)
			}
			if gotPage := strings.Contains(body, previewLoginPath); gotPage != tt.wantPage {
				t.Errorf("login page served = %v, want %v; body = %q", gotPage, tt.wantPage, body)
			}
		})
	}
}

// login posts password to the preview login endpoint of host, through proxy.
func login(t *testing.T, proxy string, host, password string, cookie *http.Cookie) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, proxy+previewLoginPath, strings.NewReader(url.Values{"password": {password}}.Encode()))
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	req.Host = host
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Sec-Fetch-Site", "same-origin")
	if cookie != nil {
		req.AddCookie(cookie)
	}
	resp, _ := doRequest(t, req)
	return resp
}

func TestPreviewLoginIssuesSessionCookie(t *testing.T) {
	tests := []struct {
		name        string
		relayServer string
		wantName    string
		wantSecure  bool
	}{
		{name: "https", relayServer: "cloud.pockode.com", wantName: "__Host-pockode_preview", wantSecure: true},
		// The local development relay is plain http, where a Secure or
		// __Host- cookie would never be sent back.
		{name: "http", relayServer: "local.pockode.com", wantName: "pockode_preview"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			port, reached := reachablePort(t)
			sessions := newTestSessions()
			unused := closedPort(t)
			site := newPreviewSite(&StoredConfig{Subdomain: "abc123", RelayServer: tt.relayServer})
			proxy := serveProxyFor(t, unused, unused, site, sessions)
			host := "abc123-" + strconv.Itoa(port) + "." + tt.relayServer

			resp := login(t, proxy.URL, host, testPassword, nil)
			if resp.StatusCode != http.StatusNoContent {
				t.Fatalf("status = %d, want %d", resp.StatusCode, http.StatusNoContent)
			}
			cookies := resp.Cookies()
			if len(cookies) != 1 {
				t.Fatalf("cookies = %v, want exactly one", cookies)
			}
			c := cookies[0]
			if c.Name != tt.wantName || c.Secure != tt.wantSecure || !c.HttpOnly ||
				c.SameSite != http.SameSiteLaxMode || c.Path != "/" || c.Domain != "" ||
				c.MaxAge != 400*24*60*60 {
				t.Errorf("cookie = %+v, want %s; Secure=%v; HttpOnly; SameSite=Lax; Path=/; no Domain; Max-Age 400 days",
					c, tt.wantName, tt.wantSecure)
			}

			// The cookie is what the next request is let through on.
			req, _ := http.NewRequest(http.MethodGet, proxy.URL+"/", nil)
			req.Host = host
			req.AddCookie(&http.Cookie{Name: c.Name, Value: c.Value})
			if resp, _ := doRequest(t, req); resp.StatusCode != http.StatusOK || !reached.Load() {
				t.Errorf("request with the issued cookie: status %d, forwarded %v", resp.StatusCode, reached.Load())
			}
		})
	}
}

func TestPreviewLoginRefusesWrongPassword(t *testing.T) {
	sessions := newTestSessions()
	unused := closedPort(t)
	proxy := serveProxyFor(t, unused, unused, testSite, sessions)

	resp := login(t, proxy.URL, previewHost(5173), "wrong", nil)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("status = %d, want %d", resp.StatusCode, http.StatusUnauthorized)
	}
	if len(resp.Cookies()) != 0 || sessions.issuedCount() != 0 {
		t.Errorf("wrong password got cookies %v and %d sessions", resp.Cookies(), sessions.issuedCount())
	}
}

// A second tab submitting the login form after the first must not spend a
// session slot.
func TestPreviewLoginKeepsLiveSession(t *testing.T) {
	sessions := newTestSessions()
	unused := closedPort(t)
	proxy := serveProxyFor(t, unused, unused, testSite, sessions)

	live := &http.Cookie{Name: testSite.cookieName(), Value: testToken}
	resp := login(t, proxy.URL, previewHost(5173), testPassword, live)
	if resp.StatusCode != http.StatusNoContent {
		t.Errorf("status = %d, want %d", resp.StatusCode, http.StatusNoContent)
	}
	if len(resp.Cookies()) != 0 || sessions.issuedCount() != 0 {
		t.Errorf("live session got cookies %v and %d new sessions", resp.Cookies(), sessions.issuedCount())
	}
}

func TestPreviewDoesNotForwardSessionCookie(t *testing.T) {
	name := testSite.cookieName()
	tests := []struct {
		name    string
		cookies []string
		want    string
	}{
		{name: "among the app's cookies", cookies: []string{"a=1; " + name + "=" + testToken + "; b=2"}, want: "a=1; b=2"},
		{name: "in a header of its own", cookies: []string{"a=1", name + "=" + testToken}, want: "a=1"},
		{name: "alone", cookies: []string{name + "=" + testToken}, want: ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			seen := make(chan *http.Request, 1)
			port := startLocalServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				seen <- r.Clone(context.Background())
			}))
			proxy := servePreviewProxy(t)

			req := previewRequest(t, proxy, port, http.MethodGet, "/")
			req.Header["Cookie"] = tt.cookies
			doRequest(t, req)

			got := <-seen
			if v := strings.Join(got.Header.Values("Cookie"), "|"); v != tt.want {
				t.Errorf("Cookie = %q, want %q", v, tt.want)
			}
		})
	}
}

// Every user's app and previews share the relay domain, so another user's page
// is same-site to this preview and its requests carry the session cookie.
func TestPreviewRefusesRequestsFromOtherOrigins(t *testing.T) {
	other := "https://xyz789-3000.cloud.pockode.com"
	// self stands for the preview's own origin, whose port is only known once
	// the previewed server is up.
	const self = "<self>"
	tests := []struct {
		name    string
		method  string
		path    string
		headers map[string]string
		allowed bool
	}{
		{name: "same-origin fetch", method: http.MethodPost, path: "/api", headers: map[string]string{"Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors"}, allowed: true},
		// A page with Referrer-Policy: no-referrer posting to itself.
		{name: "same-origin post with a null Origin", method: http.MethodPost, path: "/api", headers: map[string]string{"Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "same-origin", "Origin": "null"}, allowed: true},
		{name: "typed into the address bar", method: http.MethodGet, path: "/", headers: map[string]string{"Sec-Fetch-Site": "none", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document"}, allowed: true},
		{name: "link from another user's preview", method: http.MethodGet, path: "/", headers: map[string]string{"Sec-Fetch-Site": "same-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document"}, allowed: true},
		{name: "frame on the preview's own page", method: http.MethodGet, path: "/", headers: map[string]string{"Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "iframe"}, allowed: true},
		{name: "same-host Origin without fetch metadata", method: http.MethodPost, path: "/api", headers: map[string]string{"Origin": self}, allowed: true},
		{name: "frame on another user's preview", method: http.MethodGet, path: "/", headers: map[string]string{"Sec-Fetch-Site": "same-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "iframe"}},
		{name: "fetch from another user's preview", method: http.MethodGet, path: "/api", headers: map[string]string{"Sec-Fetch-Site": "same-site", "Sec-Fetch-Mode": "cors", "Origin": other}},
		{name: "script tag on another user's preview", method: http.MethodGet, path: "/main.js", headers: map[string]string{"Sec-Fetch-Site": "same-site", "Sec-Fetch-Mode": "no-cors"}},
		{name: "form post from another user's preview", method: http.MethodPost, path: "/api", headers: map[string]string{"Sec-Fetch-Site": "same-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document", "Origin": other}},
		{name: "foreign Origin without fetch metadata", method: http.MethodPost, path: "/api", headers: map[string]string{"Origin": other}},
		{name: "login from another user's preview", method: http.MethodPost, path: previewLoginPath, headers: map[string]string{"Sec-Fetch-Site": "same-site", "Sec-Fetch-Mode": "cors", "Origin": other}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			port, reached := reachablePort(t)
			sessions := newTestSessions()
			unused := closedPort(t)
			proxy := serveProxyFor(t, unused, unused, testSite, sessions)

			body := url.Values{"password": {testPassword}}.Encode()
			req, err := http.NewRequest(tt.method, proxy.URL+tt.path, strings.NewReader(body))
			if err != nil {
				t.Fatalf("build request: %v", err)
			}
			req.Host = previewHost(port)
			req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
			req.AddCookie(&http.Cookie{Name: testSite.cookieName(), Value: testToken})
			for k, v := range tt.headers {
				req.Header.Set(k, strings.ReplaceAll(v, self, "https://"+previewHost(port)))
			}
			resp, _ := doRequest(t, req)

			if tt.allowed {
				if resp.StatusCode != http.StatusOK || !reached.Load() {
					t.Errorf("status %d, forwarded %v; want it forwarded", resp.StatusCode, reached.Load())
				}
				return
			}
			if resp.StatusCode != http.StatusForbidden {
				t.Errorf("status = %d, want %d", resp.StatusCode, http.StatusForbidden)
			}
			if reached.Load() || sessions.issuedCount() != 0 {
				t.Errorf("refused request was forwarded (%v) or issued %d sessions", reached.Load(), sessions.issuedCount())
			}
		})
	}
}
