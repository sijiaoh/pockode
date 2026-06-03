package cluster

import (
	"io"
	"io/fs"
	"log/slog"
	"mime"
	"net/http"
	"path/filepath"
	"strings"
	"time"
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

		if !fileExists(subFS, cleanPath) && !fileExists(subFS, cleanPath+".br") {
			cleanPath = "index.html"
		}

		serveFileWithBrotli(w, r, subFS, cleanPath)
	})
}

func fileExists(fsys fs.FS, path string) bool {
	f, err := fsys.Open(path)
	if err != nil {
		return false
	}
	f.Close()
	return true
}

func serveFileWithBrotli(w http.ResponseWriter, r *http.Request, fsys fs.FS, filePath string) {
	if strings.HasPrefix(filePath, "assets/") {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	}

	w.Header().Set("Vary", "Accept-Encoding")

	acceptsBr := strings.Contains(r.Header.Get("Accept-Encoding"), "br")
	if acceptsBr {
		brPath := filePath + ".br"
		if brFile, err := fsys.Open(brPath); err == nil {
			defer brFile.Close()

			w.Header().Set("Content-Encoding", "br")
			w.Header().Set("Content-Type", getContentType(filePath))
			http.ServeContent(w, r, filePath, time.Time{}, brFile.(io.ReadSeeker))
			return
		}
	}

	file, err := fsys.Open(filePath)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer file.Close()

	w.Header().Set("Content-Type", getContentType(filePath))
	http.ServeContent(w, r, filePath, time.Time{}, file.(io.ReadSeeker))
}

func getContentType(filePath string) string {
	ext := filepath.Ext(filePath)
	if mimeType := mime.TypeByExtension(ext); mimeType != "" {
		return mimeType
	}
	return "application/octet-stream"
}
