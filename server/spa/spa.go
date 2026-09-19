// Package spa provides utilities for serving Single Page Applications.
package spa

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// assetsPrefix is where Vite emits content-hashed files. Their names change on
// every build, so a missing one is a stale reference rather than an SPA route.
const assetsPrefix = "assets/"

// ResolvePath maps a request path to the file to serve. Unknown paths fall back
// to index.html so client-side routing works, except under assetsPrefix: a
// missing hashed asset must 404 instead of being answered with HTML the browser
// would then refuse to execute. Returns false when the request has no file.
func ResolvePath(fsys fs.FS, urlPath string) (string, bool) {
	cleanPath := strings.TrimPrefix(urlPath, "/")
	if cleanPath == "" {
		cleanPath = "index.html"
	}

	if isFile(fsys, cleanPath) || isFile(fsys, cleanPath+".br") {
		return cleanPath, true
	}

	if strings.HasPrefix(cleanPath, assetsPrefix) {
		return "", false
	}

	return "index.html", true
}

// isFile reports whether path names a regular file. Directories are excluded
// because ServeFileWithBrotli can only serve something seekable, and an
// embedded directory is not: resolving to one turns a request into a 500.
func isFile(fsys fs.FS, path string) bool {
	info, err := fs.Stat(fsys, path)
	return err == nil && info.Mode().IsRegular()
}

// ServeFileWithBrotli serves a file, preferring its pre-compressed .br variant
// when the client accepts brotli, and declares how long the response may be
// reused: hashed assets forever, everything else only after revalidating.
func ServeFileWithBrotli(w http.ResponseWriter, r *http.Request, fsys fs.FS, filePath string) {
	w.Header().Set("Vary", "Accept-Encoding")

	servePath := filePath
	brotli := acceptsBrotli(r.Header.Get("Accept-Encoding")) && isFile(fsys, filePath+".br")
	if brotli {
		servePath = filePath + ".br"
	}

	file, err := fsys.Open(servePath)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer file.Close()

	content, ok := file.(io.ReadSeeker)
	if !ok {
		http.Error(w, "static file is not seekable", http.StatusInternalServerError)
		return
	}

	if strings.HasPrefix(filePath, assetsPrefix) {
		// A hashed name belongs to exactly one build, so its bytes never change.
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		// index.html is what names the current build's hashed assets, so a
		// stale copy of it points at files this binary no longer has. no-cache
		// still lets caches store it and only forbids reusing it without
		// revalidating, which the ETag makes cheap. Hashing stays in this
		// branch: the files reaching it are the entry document and the favicon,
		// while assets are large and, being immutable, never revalidated.
		w.Header().Set("Cache-Control", "no-cache")
		if etag, err := etagOf(content); err == nil {
			w.Header().Set("ETag", etag)
		}
	}

	w.Header().Set("Content-Type", GetContentType(filePath))
	if brotli {
		w.Header().Set("Content-Encoding", "br")
	}
	http.ServeContent(w, r, filePath, time.Time{}, content)
}

// acceptsBrotli reports whether the client will take a brotli-encoded body.
// Looking for "br" anywhere in the header is not enough: an entry names a
// coding in order to refuse it too, and "br;q=0" answered with brotli hands the
// client the one thing it just said it cannot decode.
//
// A header that never names br means no brotli, including an absent one. RFC
// 9110 reads an absent Accept-Encoding as accepting any coding, but the clients
// that omit it are the ones least likely to own a decoder, so serving them
// identity is what pre-compressed static servers do.
func acceptsBrotli(header string) bool {
	for _, entry := range strings.Split(header, ",") {
		coding, params, _ := strings.Cut(entry, ";")
		if strings.EqualFold(strings.TrimSpace(coding), "br") {
			return !refusedByQuality(params)
		}
	}
	return false
}

// refusedByQuality reports whether an Accept-Encoding entry's parameters carry
// "q=0", the only way naming a coding means refusing it rather than ranking it.
// An absent or unparsable q is the default of 1.
func refusedByQuality(params string) bool {
	for _, param := range strings.Split(params, ";") {
		name, value, found := strings.Cut(param, "=")
		if !found || !strings.EqualFold(strings.TrimSpace(name), "q") {
			continue
		}
		q, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
		return err == nil && q <= 0
	}
	return false
}

// etagOf hashes the bytes about to be served and rewinds the reader. Content is
// the only validator available here: embedded files carry no modtime, and the
// same URL answers with different bytes with and without brotli.
//
// A failure costs only the validator, never the response: ServeContent seeks
// the reader itself before writing, so the body is correct either way.
func etagOf(content io.ReadSeeker) (string, error) {
	h := sha256.New()
	if _, err := io.Copy(h, content); err != nil {
		return "", err
	}
	if _, err := content.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	return `"` + hex.EncodeToString(h.Sum(nil)[:16]) + `"`, nil
}

// GetContentType returns the MIME type for a file path based on its extension.
func GetContentType(filePath string) string {
	ext := filepath.Ext(filePath)
	if mimeType := mime.TypeByExtension(ext); mimeType != "" {
		return mimeType
	}
	return "application/octet-stream"
}
