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

// IsLocalOnly reports whether path belongs to an API that must never be served
// to a client off this machine.
//
// The local MCP API is the one such API: it exists so an agent CLI running here
// can drive this server's own tools, and it authenticates with a token of its
// own rather than the user's. Nothing reaching this machine from outside has a
// reason to call it.
func IsLocalOnly(path string) bool {
	return strings.HasPrefix(path, "/api/mcp/")
}

// RawPrefix is where the raw endpoint answers: RawPrefix + <capability> + "/"
// + <path>. The capability in the path is that route's credential.
const RawPrefix = "/api/raw/"

// IsRaw reports whether path belongs to the raw endpoint, which takes no
// Authorization header and answers every request under it itself — "/api/raw"
// included, so that not even a malformed one is answered without its headers.
func IsRaw(path string) bool {
	return strings.HasPrefix(path, RawPrefix) || path == strings.TrimSuffix(RawPrefix, "/")
}

// LoggablePath is path with the raw endpoint's capability masked, for a log
// line: the capability is a credential, and a log outlives the hours it is
// good for.
func LoggablePath(path string) string {
	rest, ok := strings.CutPrefix(path, RawPrefix)
	if !ok {
		return path
	}
	if _, file, found := strings.Cut(rest, "/"); found {
		return RawPrefix + "<capability>/" + file
	}
	return RawPrefix + "<capability>"
}
