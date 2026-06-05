// Package spa provides utilities for serving Single Page Applications.
package spa

import (
	"io"
	"io/fs"
	"mime"
	"net/http"
	"path/filepath"
	"strings"
	"time"
)

// FileExists checks if a file exists in the given filesystem.
func FileExists(fsys fs.FS, path string) bool {
	f, err := fsys.Open(path)
	if err != nil {
		return false
	}
	f.Close()
	return true
}

// ServeFileWithBrotli serves a file, using pre-compressed .br version if available and client accepts brotli.
func ServeFileWithBrotli(w http.ResponseWriter, r *http.Request, fsys fs.FS, filePath string) {
	// Hashed assets (in /assets/) can be cached indefinitely
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
			w.Header().Set("Content-Type", GetContentType(filePath))
			http.ServeContent(w, r, filePath, time.Time{}, brFile.(io.ReadSeeker))
			return
		}
	}

	// Serve uncompressed file
	file, err := fsys.Open(filePath)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer file.Close()

	w.Header().Set("Content-Type", GetContentType(filePath))
	http.ServeContent(w, r, filePath, time.Time{}, file.(io.ReadSeeker))
}

// GetContentType returns the MIME type for a file path based on its extension.
func GetContentType(filePath string) string {
	ext := filepath.Ext(filePath)
	if mimeType := mime.TypeByExtension(ext); mimeType != "" {
		return mimeType
	}
	return "application/octet-stream"
}
