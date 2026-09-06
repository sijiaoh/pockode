// Package apiroute names the HTTP paths this server answers itself, as opposed
// to the ones belonging to the single-page app.
//
// Two places must agree on that split and would silently diverge otherwise:
// the SPA handler, which serves static files for everything else, and the
// relay's local proxy, which in dev mode sends everything else to a separate
// frontend dev server. Adding a backend endpoint without updating both makes
// it unreachable through the relay in dev.
package apiroute

import "strings"

// IsAPI reports whether path is served by this process's own HTTP API.
func IsAPI(path string) bool {
	return strings.HasPrefix(path, "/api") || path == "/ws" || path == "/health"
}
