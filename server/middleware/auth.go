package middleware

import (
	"crypto/subtle"
	"net/http"
	"strings"
)

func Auth(token string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Health check, WebSocket, and the local MCP API bypass this middleware:
			// WebSocket and the MCP API authenticate themselves (the MCP API uses a
			// separate, locally-generated token, not the user-facing --auth-token).
			// Match the MCP route exactly (not a prefix) so any future /api/mcp/*
			// route is auth-protected by default rather than silently exposed.
			if r.URL.Path == "/health" || r.URL.Path == "/ws" || r.URL.Path == "/api/mcp/tools/call" {
				next.ServeHTTP(w, r)
				return
			}

			authHeader := r.Header.Get("Authorization")
			if authHeader == "" {
				http.Error(w, "Unauthorized", http.StatusUnauthorized)
				return
			}

			parts := strings.SplitN(authHeader, " ", 2)
			if len(parts) != 2 || parts[0] != "Bearer" {
				http.Error(w, "Invalid authorization header", http.StatusUnauthorized)
				return
			}

			if subtle.ConstantTimeCompare([]byte(parts[1]), []byte(token)) != 1 {
				http.Error(w, "Invalid token", http.StatusUnauthorized)
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}
