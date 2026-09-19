package middleware

import (
	"crypto/subtle"
	"net/http"
	"strings"
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
func Auth(password string, sessions SessionValidator) func(http.Handler) http.Handler {
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

			if !authorized(r.Header.Get("Authorization"), password, sessions) {
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

func authorized(authHeader, password string, sessions SessionValidator) bool {
	scheme, credential, ok := strings.Cut(authHeader, " ")
	if !ok || scheme != "Bearer" {
		return false
	}
	if subtle.ConstantTimeCompare([]byte(credential), []byte(password)) == 1 {
		return true
	}
	return sessions.Validate(credential)
}
