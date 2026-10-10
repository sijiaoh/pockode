package relay

import (
	"net/http"
	"strings"

	"github.com/pockode/server/password"
)

// previewLoginPath is where the login page posts the password, and where the
// app opens a preview tab with a one-time ticket (GET ?ticket=...). It sits
// under previewReservedPrefix, so no previewed app can shadow it.
const previewLoginPath = previewReservedPrefix + "preview/login"

// previewLoginMaxBody bounds a login request: a form with one password in it.
const previewLoginMaxBody = 64 << 10

// previewCookieMaxAge is the longest lifetime browsers honor (400 days,
// RFC 6265bis). Expiry is the session store's call, as it is for the app's own
// session token; the cookie only has to outlive it.
const previewCookieMaxAge = 400 * 24 * 60 * 60

// previewTicketParam is the query parameter a ticket login carries the ticket in.
const previewTicketParam = "ticket"

// previewAuth is the app's own password and sessions, which port previews are
// guarded by, and the one-time tickets the logged-in app logs a preview tab in
// with.
//
// A cookie rather than the app's bearer token: navigations, subresources and
// a dev server's HMR socket carry no Authorization header, and an HttpOnly
// cookie can only be set by an HTTP response — hence a login endpoint instead
// of the WebSocket auth RPC.
type previewAuth struct {
	password string
	sessions SessionStore
	tickets  TicketRedeemer
}

// cookieName carries the "__Host-" prefix under https, which keeps another
// subdomain of the relay domain from planting a cookie of the same name for
// this host. Plain http cannot carry the prefix.
func (s previewSite) cookieName() string {
	if s.scheme == "https" {
		return "__Host-pockode_preview"
	}
	return "pockode_preview"
}

func (p *previewProxy) authenticated(r *http.Request) bool {
	c, err := r.Cookie(p.site.cookieName())
	return err == nil && p.auth.sessions.Validate(c.Value)
}

func (p *previewProxy) serveLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet && isDocumentNavigation(r) {
		p.serveTicketLogin(w, r)
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	// A second tab logging in after the first must not spend a session slot.
	if p.authenticated(r) {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	// Anyone can reach this before logging in, and form parsing would otherwise
	// take a body of any size — spilling a multipart one to temporary files.
	r.Body = http.MaxBytesReader(w, r.Body, previewLoginMaxBody)
	if !password.Matches(r.PostFormValue("password"), p.auth.password) {
		p.log.Warn("invalid preview password", "host", r.Host)
		http.Error(w, "invalid password", http.StatusUnauthorized)
		return
	}
	token, err := p.auth.sessions.Issue()
	if err != nil {
		p.log.Error("failed to issue preview session", "error", err)
		http.Error(w, "failed to issue session: "+err.Error(), http.StatusInternalServerError)
		return
	}
	p.setSessionCookie(w, token)
	w.WriteHeader(http.StatusNoContent)
}

// serveTicketLogin exchanges a one-time ticket from the logged-in app for a
// session, then redirects to the preview root so the ticket leaves the address
// bar and the history entry. The target is fixed: taking one from the request
// would make this an open redirect. A ticket that does not redeem lands on the
// root all the same, which shows the password page to a browser without a
// session.
func (p *previewProxy) serveTicketLogin(w http.ResponseWriter, r *http.Request) {
	ticket := r.URL.Query().Get(previewTicketParam)
	// Spent either way: a live session needs no new one, but the ticket is
	// still sitting in this URL, which should not stay redeemable.
	redeemed := p.auth.tickets.Redeem(ticket)
	switch {
	case p.authenticated(r):
		// A second tab opened from the app must not spend a session slot.
	case !redeemed:
		// Never the ticket itself: a live one in a log is a login.
		p.log.Warn("preview login ticket not redeemable: spent, expired or missing", "host", r.Host)
	default:
		token, err := p.auth.sessions.Issue()
		if err != nil {
			p.log.Error("failed to issue preview session", "error", err)
			http.Error(w, "failed to issue session: "+err.Error(), http.StatusInternalServerError)
			return
		}
		p.setSessionCookie(w, token)
	}
	w.Header().Set("Cache-Control", "no-store")
	// Nothing loads from this URL, so the ticket should never be a Referer;
	// this keeps it so even should a browser render the redirect's body.
	w.Header().Set("Referrer-Policy", "no-referrer")
	http.Redirect(w, r, "/", http.StatusSeeOther)
}

func (p *previewProxy) setSessionCookie(w http.ResponseWriter, token string) {
	http.SetCookie(w, &http.Cookie{
		Name:     p.site.cookieName(),
		Value:    token,
		Path:     "/",
		MaxAge:   previewCookieMaxAge,
		Secure:   p.site.scheme == "https",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})
}

// challenge answers a request without a live session. Only a page load gets
// the login form; to anything else an HTML body would be noise.
func challenge(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if !isPageLoad(r) {
		http.Error(w, "Pockode preview: not logged in", http.StatusUnauthorized)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusUnauthorized)
	_, _ = w.Write([]byte(previewLoginPage))
}

// isDocumentNavigation is a page load into a tab of its own, not a frame. The
// app only ever opens a ticket in a tab, so anything else carrying one was not
// sent by the app and does not get to spend it.
func isDocumentNavigation(r *http.Request) bool {
	if dest := r.Header.Get("Sec-Fetch-Dest"); dest != "" && dest != "document" {
		return false
	}
	return isPageLoad(r)
}

// isPageLoad falls back to Accept for browsers that send no fetch metadata.
func isPageLoad(r *http.Request) bool {
	if mode := r.Header.Get("Sec-Fetch-Mode"); mode != "" {
		return mode == "navigate"
	}
	return r.Method == http.MethodGet && strings.Contains(r.Header.Get("Accept"), "text/html")
}

// stripCookie removes the named cookie from h, so a preview session token
// never reaches the previewed app, which could log or echo it.
func stripCookie(h http.Header, name string) {
	var kept []string
	for _, line := range h.Values("Cookie") {
		for part := range strings.SplitSeq(line, ";") {
			part = strings.TrimSpace(part)
			if n, _, _ := strings.Cut(part, "="); part != "" && n != name {
				kept = append(kept, part)
			}
		}
	}
	if len(kept) == 0 {
		h.Del("Cookie")
		return
	}
	h.Set("Cookie", strings.Join(kept, "; "))
}

// previewLoginPage reloads on success: the address bar still holds the page
// the user asked for, so there is nowhere to redirect to.
const previewLoginPage = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pockode preview</title>
<style>
body{font-family:system-ui,sans-serif;max-width:22rem;margin:20vh auto 0;padding:0 1rem}
form{display:flex;flex-direction:column;gap:.75rem}
input,button{font:inherit;padding:.6rem}
#error{color:#c00;min-height:1.2em;margin:0}
</style>
</head>
<body>
<h1>Pockode preview</h1>
<form id="login">
<input type="password" name="password" placeholder="Password" autocomplete="current-password" required autofocus>
<button type="submit">Log in</button>
<p id="error" role="alert"></p>
</form>
<script>
document.getElementById("login").addEventListener("submit", async (e) => {
  e.preventDefault();
  const error = document.getElementById("error");
  error.textContent = "";
  try {
    const res = await fetch("/__pockode/preview/login", { method: "POST", body: new URLSearchParams(new FormData(e.target)) });
    if (res.ok) { location.reload(); return; }
    error.textContent = res.status === 401 ? "Wrong password." : "Login failed: " + (await res.text());
  } catch (err) {
    error.textContent = "Login failed: " + err;
  }
});
</script>
</body>
</html>
`
