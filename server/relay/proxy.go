package relay

import (
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"slices"
	"strconv"
	"time"

	"github.com/pockode/server/apiroute"
)

// localResponseHeaderTimeout bounds how long a local backend may take to start
// answering a relayed request. It deliberately is not a whole-request timeout:
// the relayed WebSocket and streaming responses are open-ended by design.
// Kept below the cloud's own header timeout (server/relay/tunnel.go in
// pockode-cloud, 60 s) so a wedged backend surfaces as this 502 rather than an
// opaque relay failure.
const localResponseHeaderTimeout = 30 * time.Second

// maxIdleLocalConns keeps a connection pooled per concurrent relayed request.
// Sized to the relay's per-tunnel stream budget so a busy page load does not
// re-dial localhost for every asset.
const maxIdleLocalConns = 32

// forwardedHeaders are set by the cloud relay from the public request. Rewrite
// strips them from the outbound request, so they are copied back explicitly;
// otherwise the local backend would see only this process as the client.
var forwardedHeaders = []string{"X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto"}

// newLocalProxy builds the handler served on every relay stream: a reverse
// proxy onto this machine's own HTTP servers, minus the routes that must not
// leave the machine. Routing is by path because in dev mode the SPA is served
// by a separate frontend dev server; in production both ports are the same and
// the split is a no-op. Both path questions are answered by apiroute, which the
// SPA handler shares.
func newLocalProxy(backendPort, frontendPort int, log *slog.Logger) http.Handler {
	backend := localAuthority(backendPort)
	frontend := localAuthority(frontendPort)

	proxy := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			authority := frontend
			if apiroute.IsAPI(pr.In.URL.Path) {
				authority = backend
			}
			pr.Out.URL.Scheme = "http"
			pr.Out.URL.Host = authority
			// Keep the public host the browser used. The WebSocket handler
			// rejects an upgrade whose Origin disagrees with Host, and the SPA
			// builds absolute URLs from it. Redundant while the URL is
			// rewritten field by field (req.Clone already carried Host), but
			// not against switching to ProxyRequest.SetURL, which clears it.
			pr.Out.Host = pr.In.Host
			for _, header := range forwardedHeaders {
				// Clone: Values returns the inbound request's own slice, and
				// the outbound request must not share its backing array.
				if values := pr.In.Header.Values(header); len(values) > 0 {
					pr.Out.Header[http.CanonicalHeaderKey(header)] = slices.Clone(values)
				}
			}
		},
		Transport: &http.Transport{
			DialContext: (&net.Dialer{Timeout: 5 * time.Second}).DialContext,
			// net/http defaults to 2 idle connections per host, which would
			// make every relayed request past the second re-dial localhost.
			// The relay caps its concurrent streams, so this bounds naturally.
			MaxIdleConnsPerHost:   maxIdleLocalConns,
			ResponseHeaderTimeout: localResponseHeaderTimeout,
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			if r.Context().Err() != nil {
				return
			}
			log.Error("local proxy failed", "method", r.Method, "path", r.URL.Path, "error", err)
			http.Error(w, "bad gateway", http.StatusBadGateway)
		},
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// The relay is the only thing that could make a local-only route
		// remotely reachable, so it is the only thing that can refuse it — and
		// it has to do so before a port is chosen, since in the default
		// single-port setup routing alone would not keep it out of reach.
		// 404 because from the outside the route does not exist.
		if apiroute.IsLocalOnly(r.URL.Path) {
			http.NotFound(w, r)
			return
		}
		proxy.ServeHTTP(w, r)
	})
}

func localAuthority(port int) string {
	return net.JoinHostPort("localhost", strconv.Itoa(port))
}
