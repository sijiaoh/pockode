package relay

import (
	"bytes"
	"context"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/pockode/server/authguard"
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

// While passwords are locked out even the right one is refused with a wait;
// a live session cookie and a ticket from the app are not passwords and still
// log in.
func TestPreviewLoginLockedOutKeepsSessionsAndTickets(t *testing.T) {
	p := serveTicketProxy(t)
	host := previewHost(5173)

	// authguard tolerates 5 failures; the 6th starts a 1s lockout.
	for i := range 6 {
		if resp := login(t, p.url, host, "wrong", nil); resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("wrong password %d: status %d, want %d", i+1, resp.StatusCode, http.StatusUnauthorized)
		}
	}

	live := &http.Cookie{Name: testSite.cookieName(), Value: testToken}
	if resp := login(t, p.url, host, "wrong", live); resp.StatusCode != http.StatusNoContent {
		t.Errorf("live session while locked out: status %d, want %d", resp.StatusCode, http.StatusNoContent)
	}
	resp := ticketLogin(t, p.url, host, url.Values{"ticket": {testTicket}}.Encode(), nil)
	if cookies := resp.Cookies(); len(cookies) != 1 || cookies[0].Name != testSite.cookieName() {
		t.Errorf("ticket while locked out: cookies %v, want a session cookie", cookies)
	}

	resp = login(t, p.url, host, testPassword, nil)
	if resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("password while locked out: status %d, want %d", resp.StatusCode, http.StatusTooManyRequests)
	}
	if got := resp.Header.Get("Retry-After"); got != "1" {
		t.Errorf("Retry-After = %q, want 1 (the 1s lockout, rounded up)", got)
	}
	if len(resp.Cookies()) != 0 || p.sessions.issuedCount() != 1 {
		t.Errorf("locked-out password got cookies %v; sessions issued %d, want only the ticket's", resp.Cookies(), p.sessions.issuedCount())
	}
}

// testTicket is a ticket every test ticket set starts out with.
const testTicket = "live-ticket"

type fakeTickets struct {
	liveMu sync.Mutex
	live   map[string]bool
}

func newTestTickets() *fakeTickets {
	return &fakeTickets{live: map[string]bool{testTicket: true}}
}

func (t *fakeTickets) Redeem(ticket string) bool {
	t.liveMu.Lock()
	defer t.liveMu.Unlock()
	live := t.live[ticket]
	delete(t.live, ticket)
	return live
}

func (t *fakeTickets) isLive(ticket string) bool {
	t.liveMu.Lock()
	defer t.liveMu.Unlock()
	return t.live[ticket]
}

// syncBuffer is a log sink the proxy's handler goroutines can write to while
// the test reads it.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

type ticketProxy struct {
	url      string
	sessions *fakeSessions
	tickets  *fakeTickets
	guard    *authguard.Guard
	log      *syncBuffer
}

func serveTicketProxy(t *testing.T) ticketProxy {
	t.Helper()
	p := ticketProxy{sessions: newTestSessions(), tickets: newTestTickets(), guard: authguard.NewFrozen(), log: &syncBuffer{}}
	unused := closedPort(t)
	auth := previewAuth{password: testPassword, guard: p.guard, sessions: p.sessions, tickets: p.tickets}
	p.url = serveProxyWithAuth(t, unused, unused, testSite, auth, slog.New(slog.NewTextHandler(p.log, nil))).URL
	return p
}

// ticketLogin opens the preview login endpoint with query the way the app
// does: a top-level navigation from the app's own host, which is same-site.
func ticketLogin(t *testing.T, proxy, host, query string, cookie *http.Cookie) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, proxy+previewLoginPath+"?"+query, nil)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	req.Host = host
	req.Header.Set("Sec-Fetch-Site", "same-site")
	req.Header.Set("Sec-Fetch-Mode", "navigate")
	req.Header.Set("Sec-Fetch-Dest", "document")
	if cookie != nil {
		req.AddCookie(cookie)
	}
	resp, _ := doRequest(t, req)
	return resp
}

// wantRedirectToRoot checks the ticket leaves the address bar for the preview
// root, and nowhere else, whatever the request asked for.
func wantRedirectToRoot(t *testing.T, resp *http.Response) {
	t.Helper()
	if resp.StatusCode != http.StatusSeeOther || resp.Header.Get("Location") != "/" {
		t.Errorf("status %d, Location %q; want %d to /", resp.StatusCode, resp.Header.Get("Location"), http.StatusSeeOther)
	}
	if got := resp.Header.Get("Referrer-Policy"); got != "no-referrer" {
		t.Errorf("Referrer-Policy = %q, want no-referrer", got)
	}
}

func TestPreviewTicketLoginIssuesSessionCookie(t *testing.T) {
	port, reached := reachablePort(t)
	p := serveTicketProxy(t)
	host := previewHost(port)

	resp := ticketLogin(t, p.url, host, url.Values{"ticket": {testTicket}, "next": {"https://evil.example/"}}.Encode(), nil)
	wantRedirectToRoot(t, resp)
	cookies := resp.Cookies()
	if len(cookies) != 1 || cookies[0].Name != testSite.cookieName() || !cookies[0].HttpOnly || !cookies[0].Secure ||
		cookies[0].SameSite != http.SameSiteLaxMode || cookies[0].MaxAge != previewCookieMaxAge {
		t.Fatalf("cookies = %v, want the password login's session cookie", cookies)
	}
	if p.tickets.isLive(testTicket) {
		t.Error("the ticket is still redeemable after logging in")
	}

	req, _ := http.NewRequest(http.MethodGet, p.url+"/", nil)
	req.Host = host
	req.AddCookie(&http.Cookie{Name: cookies[0].Name, Value: cookies[0].Value})
	if resp, _ := doRequest(t, req); resp.StatusCode != http.StatusOK || !reached.Load() {
		t.Errorf("request with the issued cookie: status %d, forwarded %v", resp.StatusCode, reached.Load())
	}
}

// A ticket that does not redeem lands on the root, where a browser without a
// session gets the password page.
func TestPreviewTicketLoginFallsBackToPasswordPage(t *testing.T) {
	tests := []struct {
		name   string
		ticket string
		spend  bool
	}{
		{name: "spent", ticket: testTicket, spend: true},
		// Expired is the same answer from the ticket set: not redeemable.
		{name: "unknown or expired", ticket: "not-a-ticket"},
		{name: "missing"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := serveTicketProxy(t)
			if tt.spend {
				p.tickets.Redeem(tt.ticket)
			}
			query := ""
			if tt.ticket != "" {
				query = url.Values{"ticket": {tt.ticket}}.Encode()
			}

			resp := ticketLogin(t, p.url, previewHost(5173), query, nil)
			wantRedirectToRoot(t, resp)
			if len(resp.Cookies()) != 0 || p.sessions.issuedCount() != 0 {
				t.Errorf("got cookies %v and %d sessions", resp.Cookies(), p.sessions.issuedCount())
			}
			log := p.log.String()
			if !strings.Contains(log, "ticket not redeemable") {
				t.Errorf("failure not logged; log = %q", log)
			}
			if tt.ticket != "" && strings.Contains(log, tt.ticket) {
				t.Errorf("log carries the ticket: %q", log)
			}
		})
	}
}

// A second tab opened from the app must not spend a session slot, and the
// ticket it carried is spent anyway rather than left in its URL to be reused.
func TestPreviewTicketLoginKeepsLiveSession(t *testing.T) {
	p := serveTicketProxy(t)

	live := &http.Cookie{Name: testSite.cookieName(), Value: testToken}
	resp := ticketLogin(t, p.url, previewHost(5173), url.Values{"ticket": {testTicket}}.Encode(), live)
	wantRedirectToRoot(t, resp)
	if len(resp.Cookies()) != 0 || p.sessions.issuedCount() != 0 {
		t.Errorf("live session got cookies %v and %d new sessions", resp.Cookies(), p.sessions.issuedCount())
	}
	if p.tickets.isLive(testTicket) {
		t.Error("the ticket is still redeemable")
	}
}

// Only a tab of its own redeems a ticket: a frame stays inside whatever page
// embeds it.
func TestPreviewTicketLoginRefusesFrames(t *testing.T) {
	p := serveTicketProxy(t)

	req, err := http.NewRequest(http.MethodGet, p.url+previewLoginPath+"?ticket="+testTicket, nil)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	req.Host = previewHost(5173)
	req.Header.Set("Sec-Fetch-Site", "same-origin")
	req.Header.Set("Sec-Fetch-Mode", "navigate")
	req.Header.Set("Sec-Fetch-Dest", "iframe")
	resp, _ := doRequest(t, req)

	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("status = %d, want %d", resp.StatusCode, http.StatusMethodNotAllowed)
	}
	if len(resp.Cookies()) != 0 || !p.tickets.isLive(testTicket) {
		t.Errorf("a frame got cookies %v or spent the ticket", resp.Cookies())
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
