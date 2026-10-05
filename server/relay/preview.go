package relay

import (
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"slices"
	"strconv"
	"strings"
)

// previewReservedPrefix is the path space a preview host keeps for Pockode
// itself. Nothing under it reaches the previewed app.
const previewReservedPrefix = "/__pockode/"

// previewSite recognizes the hosts the cloud routes to this tunnel for a port
// preview: "<subdomain>-<port>.<relay server>", alongside the app's own
// "<subdomain>.<relay server>". The cloud passes the public Host through
// unchanged, so the port is read from it here.
type previewSite struct {
	// scheme is the public scheme of the preview URL, the same as the app's.
	scheme string
	// labelPrefix is "<subdomain>-".
	labelPrefix string
	domain      string
}

func newPreviewSite(cfg *StoredConfig) previewSite {
	return previewSite{
		scheme:      publicScheme(cfg),
		labelPrefix: cfg.Subdomain + "-",
		domain:      cfg.RelayServer,
	}
}

// port returns the local port a preview host names; ok is false for any
// other host.
func (s previewSite) port(host string) (port int, ok bool) {
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	// The cloud routes a fully qualified "....com." as a preview too, so it
	// has to be read as one here.
	host = strings.TrimSuffix(host, ".")
	label, domain, ok := strings.Cut(host, ".")
	if !ok || !strings.EqualFold(domain, s.domain) {
		return 0, false
	}
	if len(label) <= len(s.labelPrefix) || !strings.EqualFold(label[:len(s.labelPrefix)], s.labelPrefix) {
		return 0, false
	}
	digits := label[len(s.labelPrefix):]
	port, err := strconv.Atoi(digits)
	// One spelling per port, so "-05173" is not a second name for 5173.
	if err != nil || port < 1 || port > 65535 || strconv.Itoa(port) != digits {
		return 0, false
	}
	return port, true
}

// previewProxy forwards preview requests to localhost:<port>, for a browser
// logged in to the app (see previewAuth) and only from the preview's own
// origin (see sameOriginOrNavigation).
//
// Dev servers check the Host and Origin they are reached with against an
// allowlist that knows localhost but not the preview host (Vite's
// allowedHosts, Next's allowedDevOrigins) and answer 403 otherwise. So the
// request is made to look as if the browser had opened localhost:<port>
// itself: Host and a same-origin Origin are rewritten to it, and a redirect
// back to it is rewritten to the preview URL.
type previewProxy struct {
	site      previewSite
	auth      previewAuth
	transport http.RoundTripper
	log       *slog.Logger
}

func (p *previewProxy) serve(w http.ResponseWriter, r *http.Request, port int) {
	if !sameOriginOrNavigation(r) {
		http.Error(w, "Pockode preview: cross-origin request refused", http.StatusForbidden)
		return
	}
	if r.URL.Path == previewLoginPath {
		p.serveLogin(w, r)
		return
	}
	if strings.HasPrefix(r.URL.Path, previewReservedPrefix) {
		http.NotFound(w, r)
		return
	}
	if !p.authenticated(r) {
		challenge(w, r)
		return
	}

	local := localAuthority(port)
	publicHost := r.Host
	proxy := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.Out.URL.Scheme = "http"
			pr.Out.URL.Host = local
			pr.Out.Host = local
			if origin := pr.In.Header.Get("Origin"); origin != "" && originHostIs(origin, pr.In.Host) {
				pr.Out.Header.Set("Origin", "http://"+local)
			}
			stripCookie(pr.Out.Header, p.site.cookieName())
			// Only the client address: a public X-Forwarded-Host or -Proto
			// would contradict the localhost Host and Origin, and frameworks
			// that trust them (Next's Server Actions, Rails' host check)
			// refuse the request.
			if values := pr.In.Header.Values("X-Forwarded-For"); len(values) > 0 {
				pr.Out.Header["X-Forwarded-For"] = slices.Clone(values)
			}
		},
		Transport: p.transport,
		ModifyResponse: func(resp *http.Response) error {
			// Host alone, so a scheme-relative "//localhost:<port>/..." is
			// caught as well.
			if loc, err := url.Parse(resp.Header.Get("Location")); err == nil && strings.EqualFold(loc.Host, local) {
				loc.Scheme = p.site.scheme
				loc.Host = publicHost
				resp.Header.Set("Location", loc.String())
			}
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			if r.Context().Err() != nil {
				return
			}
			// Nothing listening is the user's own state, not a fault, and a
			// dev client keeps retrying while its server is down, so it logs
			// at debug; the 502 body is what tells the user.
			var opErr *net.OpError
			if errors.As(err, &opErr) && opErr.Op == "dial" {
				p.log.Debug("preview target unreachable", "port", port, "error", err)
				http.Error(w, fmt.Sprintf("Pockode preview: nothing is listening on %s. Start your server on this machine, then reload.", local), http.StatusBadGateway)
				return
			}
			p.log.Warn("preview proxy failed", "port", port, "method", r.Method, "path", r.URL.Path, "error", err)
			http.Error(w, fmt.Sprintf("Pockode preview: %s did not answer: %v", local, err), http.StatusBadGateway)
		},
	}
	proxy.ServeHTTP(w, r)
}

// sameOriginOrNavigation keeps other sites' pages from using the preview
// session. Every preview host shares the relay domain with every other user's
// app and preview, so they are all same-site to each other and SameSite=Lax
// still sends the cookie along; same-site is not good enough here, same-origin
// is.
//
// A safe-method top-level navigation is let through from anywhere, so that a
// link to the preview keeps working: the page it opens is the preview's own,
// out of reach of the page that linked to it. A frame is not: it stays inside
// the page that embeds it, which could overlay it to steer the user's clicks.
// Everything else — frames, fetches, subresources, form posts, WebSocket
// upgrades — must come from the preview itself.
//
// Sec-Fetch-Site decides when present, as in net/http's
// CrossOriginProtection: a same-origin request may still say "Origin: null"
// (a page with Referrer-Policy: no-referrer posting to itself). Without it,
// Origin decides by the rule the app's /ws gets from coder/websocket: no
// Origin, or one whose host is the request's Host. Either way it has to be
// enforced here, since the forwarded request's Origin is rewritten to
// localhost and the previewed server may not check it at all.
func sameOriginOrNavigation(r *http.Request) bool {
	if (r.Method == http.MethodGet || r.Method == http.MethodHead) &&
		r.Header.Get("Sec-Fetch-Mode") == "navigate" && r.Header.Get("Sec-Fetch-Dest") == "document" {
		return true
	}
	switch r.Header.Get("Sec-Fetch-Site") {
	case "same-origin", "none":
		return true
	case "":
		origin := r.Header.Get("Origin")
		return origin == "" || originHostIs(origin, r.Host)
	default:
		return false
	}
}

func originHostIs(origin, host string) bool {
	u, err := url.Parse(origin)
	return err == nil && strings.EqualFold(u.Host, host)
}
