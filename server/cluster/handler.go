package cluster

import (
	"net/http"

	"github.com/pockode/server/middleware"
)

// Exposes /health, /ws, /api/me, /api/login, /api/logout, and static file endpoints.
func newHandler(token string, devMode bool, wsHandler *wsHandler) http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	})

	// Returns 200 if authenticated (cookie valid), 401 otherwise (handled by Auth middleware)
	mux.HandleFunc("GET /api/me", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	// Auth endpoints (no auth required)
	mux.HandleFunc("POST /api/login", middleware.LoginHandler(token, devMode))
	mux.HandleFunc("POST /api/logout", middleware.LogoutHandler(devMode))

	mux.Handle("GET /ws", wsHandler)

	authedMux := middleware.Auth(token)(mux)

	if !devMode {
		return newSPAHandler(authedMux)
	}

	return authedMux
}
