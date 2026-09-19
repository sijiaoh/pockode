package cluster

import (
	"net/http"

	"github.com/pockode/server/middleware"
)

// Exposes /health, /ws, and static file endpoints.
func newHandler(password string, sessions middleware.SessionValidator, devMode bool, wsHandler *wsHandler) http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	})

	mux.Handle("GET /ws", wsHandler)

	authedMux := middleware.Auth(password, sessions)(mux)

	if !devMode {
		return newSPAHandler(authedMux)
	}

	return authedMux
}
