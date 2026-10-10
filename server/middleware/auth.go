package middleware

import (
	"net/http"
	"strings"
	"time"

	"github.com/pockode/server/authguard"
	"github.com/pockode/server/password"
)

// SessionValidator reports whether a bearer credential is a live session token.
// It is an interface so this package does not depend on where sessions are
// kept; authsession.Store implements it.
type SessionValidator interface {
	Validate(token string) bool
}

// Auth accepts either the server password or a session token as the bearer
// credential. The password stays usable directly so that curl and scripts have
// something to send; browsers exchange it for a session token and send that.
//
// passwordGuard must be the process's one guard, shared with every other
// place that checks the password, or each entry point would grant its own
// round of guesses.
func Auth(serverPassword string, passwordGuard *authguard.Guard, sessions SessionValidator) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Health check, WebSocket, and the local MCP API bypass this middleware:
			// WebSocket and the MCP API authenticate themselves (the MCP API uses a
			// separate, locally-generated token, not the user-facing password).
			// Match the MCP route exactly (not a prefix) so any future /api/mcp/*
			// route is auth-protected by default rather than silently exposed.
			if r.URL.Path == "/health" || r.URL.Path == "/ws" || r.URL.Path == "/api/mcp/tools/call" {
				next.ServeHTTP(w, r)
				return
			}

			ok, retryAfter := authorized(r.Header.Get("Authorization"), serverPassword, passwordGuard, sessions)
			if retryAfter > 0 {
				w.Header().Set("Retry-After", authguard.RetryAfterSeconds(retryAfter))
				http.Error(w, "Too many failed password attempts, try again later", http.StatusTooManyRequests)
				return
			}
			if !ok {
				// A missing header, a malformed one and a wrong credential all
				// get the same reply: telling an unauthenticated caller which
				// of the three it got wrong is information it has not earned.
				http.Error(w, "Invalid credentials", http.StatusUnauthorized)
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}

// authorized tries the credential as a session token first, so a logged-in
// device keeps working while passwords are locked out. Only a bearer
// credential that is not a session counts as a password attempt; a request
// with no credential at all guessed nothing.
func authorized(authHeader, serverPassword string, passwordGuard *authguard.Guard, sessions SessionValidator) (ok bool, retryAfter time.Duration) {
	scheme, credential, found := strings.Cut(authHeader, " ")
	if !found || scheme != "Bearer" {
		return false, 0
	}
	if sessions.Validate(credential) {
		return true, 0
	}
	return passwordGuard.Attempt(func() bool { return password.Matches(credential, serverPassword) })
}
