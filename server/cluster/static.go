package cluster

import (
	"io/fs"
	"log/slog"
	"net/http"

	"github.com/pockode/server/spa"
)

// newSPAHandler wraps an API handler with embedded SPA static file serving for cluster mode.
func newSPAHandler(apiHandler http.Handler) http.Handler {
	subFS, err := fs.Sub(staticFS, "static")
	if err != nil {
		slog.Error("failed to create sub filesystem for cluster", "error", err)
		return apiHandler
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path

		if path == "/ws" || path == "/health" {
			apiHandler.ServeHTTP(w, r)
			return
		}

		cleanPath, ok := spa.ResolvePath(subFS, path)
		if !ok {
			http.NotFound(w, r)
			return
		}

		spa.ServeFileWithBrotli(w, r, subFS, cleanPath)
	})
}
