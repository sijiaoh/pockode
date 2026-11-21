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
// There are two: the MCP API, through which an agent CLI running here drives
// this server's own tools, and the Pockode-local API (package localapi),
// through which the cluster that started this node logs browsers in. Both
// authenticate with the server.json token rather than the user's password, and
// nothing reaching this machine from outside has a reason to call them.
//
// The relay refuses these paths on every port it previews as well, so a
// prefix here takes that path away from the user's own apps: keep each one
// Pockode's own.
func IsLocalOnly(path string) bool {
	return strings.HasPrefix(path, "/api/mcp/") || strings.HasPrefix(path, "/api/pockode-local/")
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
