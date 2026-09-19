package spa_test

import (
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/pockode/server/spa"
)

const (
	indexHTML   = "<!doctype html><title>pockode</title>"
	indexBrotli = "brotli-index"
	onlyBrotli  = "brotli-only-bytes"

	immutable = "public, max-age=31536000, immutable"
	noCache   = "no-cache"
)

func testFS() fs.FS {
	return fstest.MapFS{
		"index.html":              &fstest.MapFile{Data: []byte(indexHTML)},
		"index.html.br":           &fstest.MapFile{Data: []byte(indexBrotli)},
		"assets/app-abc123.js":    &fstest.MapFile{Data: []byte("export const a = 1")},
		"assets/app-abc123.js.br": &fstest.MapFile{Data: []byte("brotli-bytes")},
		"assets/style-abc123.css": &fstest.MapFile{Data: []byte("body{}")},
		// The shape every asset over the compression plugin's threshold has in
		// the real bundle: deleteOriginFile leaves only the .br variant.
		"assets/only-abc123.js.br": &fstest.MapFile{Data: []byte(onlyBrotli)},
		"favicon.svg":              &fstest.MapFile{Data: []byte("<svg/>")},
	}
}

// serve mirrors what the SPA handlers in main and cluster do, so these tests
// cover the resolve + serve contract the handlers rely on.
func serve(t *testing.T, urlPath, acceptEncoding string, headers ...http.Header) *http.Response {
	t.Helper()

	fsys := testFS()
	req := httptest.NewRequest(http.MethodGet, urlPath, nil)
	if acceptEncoding != "" {
		req.Header.Set("Accept-Encoding", acceptEncoding)
	}
	for _, h := range headers {
		for k, vs := range h {
			for _, v := range vs {
				req.Header.Add(k, v)
			}
		}
	}
	rec := httptest.NewRecorder()

	filePath, ok := spa.ResolvePath(fsys, req.URL.Path)
	if !ok {
		http.NotFound(rec, req)
	} else {
		spa.ServeFileWithBrotli(rec, req, fsys, filePath)
	}
	return rec.Result()
}

func TestServeStatus(t *testing.T) {
	tests := []struct {
		name           string
		path           string
		acceptEncoding string
		wantStatus     int
		wantBody       string
		wantEncoding   string
		wantCache      string
	}{
		{
			name:       "missing asset is not found",
			path:       "/assets/does-not-exist-abc123.js",
			wantStatus: http.StatusNotFound,
		},
		{
			name:       "missing asset is not found even with a brotli-looking name",
			path:       "/assets/does-not-exist-abc123.js.br",
			wantStatus: http.StatusNotFound,
		},
		{
			name:       "unknown non-asset path falls back to index.html",
			path:       "/sessions/123",
			wantStatus: http.StatusOK,
			wantBody:   indexHTML,
			wantCache:  noCache,
		},
		{
			name:       "root serves index.html",
			path:       "/",
			wantStatus: http.StatusOK,
			wantBody:   indexHTML,
			wantCache:  noCache,
		},
		{
			// "/assets" is not under the "assets/" prefix, so it keeps the SPA
			// fallback. What matters is that it never resolves to the directory
			// itself, which is not seekable and could only be answered with 500.
			name:       "the bare assets path falls back to index.html",
			path:       "/assets",
			wantStatus: http.StatusOK,
			wantBody:   indexHTML,
			wantCache:  noCache,
		},
		{
			name:       "the assets directory with a trailing slash is not found",
			path:       "/assets/",
			wantStatus: http.StatusNotFound,
		},
		{
			name:       "traversal out of the assets directory is not found",
			path:       "/assets/../index.html",
			wantStatus: http.StatusNotFound,
		},
		{
			name:       "existing asset is served",
			path:       "/assets/style-abc123.css",
			wantStatus: http.StatusOK,
			wantBody:   "body{}",
			wantCache:  immutable,
		},
		{
			name:           "existing asset prefers the brotli variant",
			path:           "/assets/app-abc123.js",
			acceptEncoding: "gzip, deflate, br",
			wantStatus:     http.StatusOK,
			wantBody:       "brotli-bytes",
			wantEncoding:   "br",
			wantCache:      immutable,
		},
		{
			name:       "existing asset is served uncompressed without brotli support",
			path:       "/assets/app-abc123.js",
			wantStatus: http.StatusOK,
			wantBody:   "export const a = 1",
			wantCache:  immutable,
		},
		{
			name:           "index.html is revalidated even when served brotli",
			path:           "/",
			acceptEncoding: "br",
			wantStatus:     http.StatusOK,
			wantBody:       indexBrotli,
			wantEncoding:   "br",
			wantCache:      noCache,
		},
		{
			name:           "asset that exists only pre-compressed is served brotli",
			path:           "/assets/only-abc123.js",
			acceptEncoding: "gzip, deflate, br",
			wantStatus:     http.StatusOK,
			wantBody:       onlyBrotli,
			wantEncoding:   "br",
			wantCache:      immutable,
		},
		{
			// Not a contract worth having, but the one the bundle currently
			// produces: with no uncompressed copy on disk and no decoder here,
			// a client that does not advertise brotli cannot be answered at
			// all. Pinned so that changing the compression config, or teaching
			// this package to decompress, shows up here as a failure.
			name:       "asset that exists only pre-compressed is not found without brotli support",
			path:       "/assets/only-abc123.js",
			wantStatus: http.StatusNotFound,
		},
		{
			// Naming a coding is how a client refuses it as well as how it asks
			// for it, so this header means the opposite of what a substring
			// match would read out of it.
			name:           "brotli refused with q=0 is served uncompressed",
			path:           "/assets/app-abc123.js",
			acceptEncoding: "gzip, deflate, br;q=0",
			wantStatus:     http.StatusOK,
			wantBody:       "export const a = 1",
			wantCache:      immutable,
		},
		{
			name:           "brotli refused with q=0 cannot be answered when only the variant exists",
			path:           "/assets/only-abc123.js",
			acceptEncoding: "br;q=0",
			wantStatus:     http.StatusNotFound,
		},
		{
			// The cache branch keys on the path, not on whether the resolve
			// fell back: a real file outside assets/ is no more immutable than
			// index.html is.
			name:       "a real file outside assets is revalidated too",
			path:       "/favicon.svg",
			wantStatus: http.StatusOK,
			wantBody:   "<svg/>",
			wantCache:  noCache,
		},
		{
			name:           "brotli ranked below another coding is still accepted",
			path:           "/assets/app-abc123.js",
			acceptEncoding: "gzip;q=1.0, br;q=0.5",
			wantStatus:     http.StatusOK,
			wantBody:       "brotli-bytes",
			wantEncoding:   "br",
			wantCache:      immutable,
		},
		{
			name:           "missing asset is not found even with brotli support",
			path:           "/assets/gone-abc123.js",
			acceptEncoding: "br",
			wantStatus:     http.StatusNotFound,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			resp := serve(t, tt.path, tt.acceptEncoding)
			defer resp.Body.Close()

			if resp.StatusCode != tt.wantStatus {
				t.Fatalf("status = %d, want %d", resp.StatusCode, tt.wantStatus)
			}
			if got := resp.Header.Get("Content-Encoding"); got != tt.wantEncoding {
				t.Errorf("Content-Encoding = %q, want %q", got, tt.wantEncoding)
			}
			// Whether a body is brotli depends on the request, so without this
			// a shared cache may hand the compressed one to a client that
			// asked for identity.
			if tt.wantStatus == http.StatusOK {
				if got := resp.Header.Get("Vary"); got != "Accept-Encoding" {
					t.Errorf("Vary = %q, want %q", got, "Accept-Encoding")
				}
			}
			if got := resp.Header.Get("Cache-Control"); got != tt.wantCache {
				t.Errorf("Cache-Control = %q, want %q", got, tt.wantCache)
			}
			if tt.wantBody == "" {
				return
			}
			body, err := io.ReadAll(resp.Body)
			if err != nil {
				t.Fatalf("read body: %v", err)
			}
			if string(body) != tt.wantBody {
				t.Errorf("body = %q, want %q", body, tt.wantBody)
			}
		})
	}
}

// The entry document declares no-cache, so every use of it costs a request
// unless the response also carries a validator that can answer 304.
func TestEntryDocumentETag(t *testing.T) {
	plain := serve(t, "/", "")
	defer plain.Body.Close()
	brotli := serve(t, "/", "br")
	defer brotli.Body.Close()

	plainTag := plain.Header.Get("ETag")
	brotliTag := brotli.Header.Get("ETag")
	if plainTag == "" || brotliTag == "" {
		t.Fatalf("ETag = %q (plain), %q (brotli), want both set", plainTag, brotliTag)
	}
	// Same URL, different bytes on the wire: sharing one tag would let a cache
	// hand a brotli body to a client that cannot decode it.
	if plainTag == brotliTag {
		t.Errorf("ETag = %q for both encodings, want them to differ", plainTag)
	}

	revalidated := serve(t, "/", "", http.Header{"If-None-Match": {plainTag}})
	defer revalidated.Body.Close()
	if revalidated.StatusCode != http.StatusNotModified {
		t.Errorf("status = %d, want %d", revalidated.StatusCode, http.StatusNotModified)
	}
}

// Assets are immutable, so a validator on them is dead weight: nothing will
// ever revalidate them, and hashing every chunk on every request is not free.
func TestAssetsHaveNoETag(t *testing.T) {
	resp := serve(t, "/assets/style-abc123.css", "")
	defer resp.Body.Close()

	if got := resp.Header.Get("ETag"); got != "" {
		t.Errorf("ETag = %q, want none", got)
	}
}

// readOnlyFS hands back files that cannot seek, which is what an embedded
// directory does. Serving one used to panic the handler; it has to be an error
// instead, because net/http recovering the panic kills the connection.
type readOnlyFS struct{ data string }

type readOnlyFile struct{ io.Reader }

func (readOnlyFile) Close() error               { return nil }
func (readOnlyFile) Stat() (fs.FileInfo, error) { return nil, fs.ErrInvalid }

func (f readOnlyFS) Open(string) (fs.File, error) {
	return readOnlyFile{strings.NewReader(f.data)}, nil
}

func TestServeUnseekableFileDoesNotPanic(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/index.html", nil)
	rec := httptest.NewRecorder()

	spa.ServeFileWithBrotli(rec, req, readOnlyFS{indexHTML}, "index.html")

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusInternalServerError)
	}
}
