package cluster

import (
	"io/fs"
	"log/slog"
	"net/http"
	"strings"

	"github.com/pockode/server/spa"
)

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

		cleanPath := strings.TrimPrefix(path, "/")
		if cleanPath == "" {
			cleanPath = "index.html"
		}

		if !spa.FileExists(subFS, cleanPath) && !spa.FileExists(subFS, cleanPath+".br") {
			cleanPath = "index.html"
		}

		spa.ServeFileWithBrotli(w, r, subFS, cleanPath)
	})
}
