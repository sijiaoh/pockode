package filetransfer

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// resolver maps worktree names to directories the way worktree.Registry does,
// without a git repository behind it.
type resolver struct {
	dirs map[string]string
}

func (r resolver) Resolve(name string) (string, error) {
	dir, ok := r.dirs[name]
	if !ok {
		return "", errors.New("worktree not found")
	}
	return dir, nil
}

func newTestHandler(t *testing.T) (*Handler, string) {
	t.Helper()
	workDir := t.TempDir()
	h := NewHandler(resolver{dirs: map[string]string{"": workDir}}, slog.New(slog.DiscardHandler))
	return h, workDir
}

func writeFile(t *testing.T, dir, name string, data []byte) {
	t.Helper()
	full := filepath.Join(dir, name)
	if err := os.MkdirAll(filepath.Dir(full), 0755); err != nil {
		t.Fatalf("failed to create parent of %s: %v", name, err)
	}
	if err := os.WriteFile(full, data, 0644); err != nil {
		t.Fatalf("failed to create %s: %v", name, err)
	}
}

func download(t *testing.T, h *Handler, query string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/files/download?"+query, nil)
	rec := httptest.NewRecorder()
	h.Download(rec, req)
	return rec
}

// uploadFile is one file part of a multipart upload request.
type uploadFile struct {
	name    string
	content []byte
}

// newUploadRequest builds the request separately from serving it, so a test
// that has to serve on another goroutine (to catch a handler that blocks) never
// calls t.Fatalf from one.
func newUploadRequest(t *testing.T, query string, files ...uploadFile) *http.Request {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for _, f := range files {
		part, err := writer.CreateFormFile("files", f.name)
		if err != nil {
			t.Fatalf("failed to create part %s: %v", f.name, err)
		}
		if _, err := part.Write(f.content); err != nil {
			t.Fatalf("failed to write part %s: %v", f.name, err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("failed to close multipart writer: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/files/upload?"+query, &body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	return req
}

func upload(t *testing.T, h *Handler, query string, files ...uploadFile) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	h.Upload(rec, newUploadRequest(t, query, files...))
	return rec
}

func decodeError(t *testing.T, rec *httptest.ResponseRecorder) errorResponse {
	t.Helper()
	var body errorResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("failed to decode error body %q: %v", rec.Body.String(), err)
	}
	return body
}

// assertError checks the status and code of a refused request, and that the
// message says something a user could act on.
func assertError(t *testing.T, rec *httptest.ResponseRecorder, status int, code string) errorResponse {
	t.Helper()
	if rec.Code != status {
		t.Errorf("got status %d, want %d (body %q)", rec.Code, status, rec.Body.String())
	}
	body := decodeError(t, rec)
	if body.Code != code {
		t.Errorf("got code %q, want %q", body.Code, code)
	}
	if body.Error == "" {
		t.Error("error message is empty")
	}
	return body
}

func TestDownload(t *testing.T) {
	t.Run("streams the file as an attachment", func(t *testing.T) {
		h, workDir := newTestHandler(t)
		writeFile(t, workDir, "docs/notes.txt", []byte("hello"))

		rec := download(t, h, "path=docs/notes.txt")

		if rec.Code != http.StatusOK {
			t.Fatalf("got status %d, want 200 (body %q)", rec.Code, rec.Body.String())
		}
		if rec.Body.String() != "hello" {
			t.Errorf("got body %q, want %q", rec.Body.String(), "hello")
		}
		if got := rec.Header().Get("Content-Disposition"); got != `attachment; filename=notes.txt` {
			t.Errorf("got Content-Disposition %q", got)
		}
		// Saved, never rendered: a workspace file must not run in the app's origin.
		if got := rec.Header().Get("Content-Type"); got != "application/octet-stream" {
			t.Errorf("got Content-Type %q, want application/octet-stream", got)
		}
		if got := rec.Header().Get("X-Content-Type-Options"); got != "nosniff" {
			t.Errorf("got X-Content-Type-Options %q, want nosniff", got)
		}
		// Or a browser invents a freshness lifetime from Last-Modified and
		// answers the next download from its own cache, with the bytes from
		// before the file was rewritten.
		if got := rec.Header().Get("Cache-Control"); got != "no-store" {
			t.Errorf("got Cache-Control %q, want no-store", got)
		}
		if got := rec.Header().Get("Accept-Ranges"); got != "bytes" {
			t.Errorf("got Accept-Ranges %q, want bytes", got)
		}
	})

	// Range is what lets a client on a relay tunnel pull a large file in pieces
	// instead of one response that holds the shared connection.
	t.Run("serves a byte range", func(t *testing.T) {
		h, workDir := newTestHandler(t)
		writeFile(t, workDir, "data.bin", []byte("0123456789"))

		req := httptest.NewRequest(http.MethodGet, "/api/files/download?path=data.bin", nil)
		req.Header.Set("Range", "bytes=2-5")
		rec := httptest.NewRecorder()
		h.Download(rec, req)

		if rec.Code != http.StatusPartialContent {
			t.Fatalf("got status %d, want 206", rec.Code)
		}
		if rec.Body.String() != "2345" {
			t.Errorf("got body %q, want %q", rec.Body.String(), "2345")
		}
		if got := rec.Header().Get("Content-Range"); got != "bytes 2-5/10" {
			t.Errorf("got Content-Range %q, want bytes 2-5/10", got)
		}
	})

	t.Run("encodes a non-ASCII name in the header", func(t *testing.T) {
		h, workDir := newTestHandler(t)
		writeFile(t, workDir, "设计稿.png", []byte("x"))

		rec := download(t, h, "path=%E8%AE%BE%E8%AE%A1%E7%A8%BF.png")

		if rec.Code != http.StatusOK {
			t.Fatalf("got status %d, want 200 (body %q)", rec.Code, rec.Body.String())
		}
		if got := rec.Header().Get("Content-Disposition"); !strings.Contains(got, "filename*=utf-8''") {
			t.Errorf("got Content-Disposition %q, want an RFC 2231 encoded name", got)
		}
	})

	t.Run("refuses paths outside the work directory", func(t *testing.T) {
		h, _ := newTestHandler(t)

		for _, path := range []string{"../secret.txt", "docs/../../secret.txt", "/etc/passwd"} {
			rec := download(t, h, "path="+path)
			assertError(t, rec, http.StatusBadRequest, CodeInvalidPath)
		}
	})

	t.Run("refuses a missing path parameter", func(t *testing.T) {
		h, _ := newTestHandler(t)

		rec := download(t, h, "")

		assertError(t, rec, http.StatusBadRequest, CodeInvalidPath)
	})

	t.Run("reports a missing file", func(t *testing.T) {
		h, _ := newTestHandler(t)

		rec := download(t, h, "path=nope.txt")

		assertError(t, rec, http.StatusNotFound, CodeNotFound)
	})

	t.Run("refuses a directory", func(t *testing.T) {
		h, workDir := newTestHandler(t)
		if err := os.Mkdir(filepath.Join(workDir, "docs"), 0755); err != nil {
			t.Fatalf("failed to create directory: %v", err)
		}

		rec := download(t, h, "path=docs")

		assertError(t, rec, http.StatusBadRequest, CodeNotAFile)
	})

	// Opening a fifo blocks until something writes to it, so it has to be
	// refused from the stat rather than discovered while serving.
	t.Run("refuses a named pipe instead of blocking on it", func(t *testing.T) {
		h, workDir := newTestHandler(t)
		if err := syscall.Mkfifo(filepath.Join(workDir, "pipe"), 0644); err != nil {
			t.Skipf("cannot create a fifo here: %v", err)
		}

		done := make(chan *httptest.ResponseRecorder, 1)
		go func() {
			done <- download(t, h, "path=pipe")
		}()

		select {
		case rec := <-done:
			assertError(t, rec, http.StatusBadRequest, CodeNotAFile)
		case <-time.After(5 * time.Second):
			t.Fatal("download blocked on a named pipe")
		}
	})

	t.Run("reports an unknown worktree", func(t *testing.T) {
		h, workDir := newTestHandler(t)
		writeFile(t, workDir, "a.txt", []byte("a"))

		rec := download(t, h, "path=a.txt&worktree=ghost")

		assertError(t, rec, http.StatusNotFound, CodeWorktreeUnknown)
	})
}

func TestUpload(t *testing.T) {
	t.Run("stores several files in the destination directory", func(t *testing.T) {
		h, workDir := newTestHandler(t)
		if err := os.Mkdir(filepath.Join(workDir, "assets"), 0755); err != nil {
			t.Fatalf("failed to create directory: %v", err)
		}

		rec := upload(t, h, "path=assets",
			uploadFile{name: "a.txt", content: []byte("first")},
			uploadFile{name: "b.txt", content: []byte("second")})

		if rec.Code != http.StatusOK {
			t.Fatalf("got status %d, want 200 (body %q)", rec.Code, rec.Body.String())
		}
		var body uploadResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("failed to decode response %q: %v", rec.Body.String(), err)
		}
		want := []UploadedFile{
			{Path: "assets/a.txt", Name: "a.txt", Size: 5},
			{Path: "assets/b.txt", Name: "b.txt", Size: 6},
		}
		if len(body.Files) != len(want) {
			t.Fatalf("got %d files, want %d", len(body.Files), len(want))
		}
		for i, w := range want {
			if body.Files[i] != w {
				t.Errorf("got file %+v, want %+v", body.Files[i], w)
			}
		}
		for name, content := range map[string]string{"assets/a.txt": "first", "assets/b.txt": "second"} {
			data, err := os.ReadFile(filepath.Join(workDir, name))
			if err != nil {
				t.Fatalf("failed to read %s: %v", name, err)
			}
			if string(data) != content {
				t.Errorf("got %s = %q, want %q", name, data, content)
			}
		}
	})

	// RFC 7578 §4.2: a file name never carries directory information, so an
	// upload lands in the destination whatever path the client attached to it.
	t.Run("keeps a path-bearing file name in the destination", func(t *testing.T) {
		h, workDir := newTestHandler(t)

		rec := upload(t, h, "", uploadFile{name: "../../escape.txt", content: []byte("x")})

		if rec.Code != http.StatusOK {
			t.Fatalf("got status %d, want 200 (body %q)", rec.Code, rec.Body.String())
		}
		var body uploadResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("failed to decode response %q: %v", rec.Body.String(), err)
		}
		if len(body.Files) != 1 || body.Files[0].Path != "escape.txt" {
			t.Fatalf("got files %+v, want escape.txt", body.Files)
		}
		if _, err := os.Stat(filepath.Join(workDir, "escape.txt")); err != nil {
			t.Errorf("file not stored in the work directory: %v", err)
		}
		if _, err := os.Stat(filepath.Join(filepath.Dir(workDir), "escape.txt")); !os.IsNotExist(err) {
			t.Errorf("a file was written outside the work directory: %v", err)
		}
	})

	t.Run("refuses to replace an existing file by default", func(t *testing.T) {
		h, workDir := newTestHandler(t)
		writeFile(t, workDir, "a.txt", []byte("original"))

		rec := upload(t, h, "", uploadFile{name: "a.txt", content: []byte("replacement")})

		body := assertError(t, rec, http.StatusConflict, CodeConflict)
		// The error has to say how to get the replacement through.
		if !strings.Contains(body.Error, "overwrite=true") {
			t.Errorf("error %q does not mention overwrite=true", body.Error)
		}
		data, err := os.ReadFile(filepath.Join(workDir, "a.txt"))
		if err != nil {
			t.Fatalf("failed to read file: %v", err)
		}
		if string(data) != "original" {
			t.Errorf("got %q, want the untouched %q", data, "original")
		}
	})

	t.Run("replaces an existing file with overwrite=true", func(t *testing.T) {
		h, workDir := newTestHandler(t)
		writeFile(t, workDir, "a.txt", []byte("original"))

		rec := upload(t, h, "overwrite=true", uploadFile{name: "a.txt", content: []byte("new")})

		if rec.Code != http.StatusOK {
			t.Fatalf("got status %d, want 200 (body %q)", rec.Code, rec.Body.String())
		}
		data, err := os.ReadFile(filepath.Join(workDir, "a.txt"))
		if err != nil {
			t.Fatalf("failed to read file: %v", err)
		}
		if string(data) != "new" {
			t.Errorf("got %q, want %q", data, "new")
		}
	})

	t.Run("reports what was already stored when a later file fails", func(t *testing.T) {
		h, workDir := newTestHandler(t)
		writeFile(t, workDir, "b.txt", []byte("original"))

		rec := upload(t, h, "",
			uploadFile{name: "a.txt", content: []byte("first")},
			uploadFile{name: "b.txt", content: []byte("clash")})

		body := assertError(t, rec, http.StatusConflict, CodeConflict)
		if len(body.Written) != 1 || body.Written[0].Path != "a.txt" {
			t.Errorf("got written %+v, want just a.txt", body.Written)
		}
		if _, err := os.Stat(filepath.Join(workDir, "a.txt")); err != nil {
			t.Errorf("the file stored before the failure is gone: %v", err)
		}
	})

	t.Run("refuses an upload over the size limit and leaves nothing behind", func(t *testing.T) {
		h, workDir := newTestHandler(t)
		h.maxUpload = 16

		rec := upload(t, h, "", uploadFile{name: "big.bin", content: bytes.Repeat([]byte("x"), 17)})

		body := assertError(t, rec, http.StatusRequestEntityTooLarge, CodeTooLarge)
		if !strings.Contains(body.Error, "limit") {
			t.Errorf("error %q does not name the limit", body.Error)
		}
		// The ceiling travels with the response so the UI needn't keep a copy.
		if body.Limit != h.maxUpload {
			t.Errorf("got limit %d, want %d", body.Limit, h.maxUpload)
		}
		if _, err := os.Stat(filepath.Join(workDir, "big.bin")); !os.IsNotExist(err) {
			t.Errorf("the partial file was kept: %v", err)
		}
	})

	// The budget covers the request, not each file, so a second file can be the
	// one that goes over.
	t.Run("counts every file against one budget", func(t *testing.T) {
		h, workDir := newTestHandler(t)
		h.maxUpload = 10

		rec := upload(t, h, "",
			uploadFile{name: "a.bin", content: bytes.Repeat([]byte("x"), 8)},
			uploadFile{name: "b.bin", content: bytes.Repeat([]byte("y"), 8)})

		assertError(t, rec, http.StatusRequestEntityTooLarge, CodeTooLarge)
		if _, err := os.Stat(filepath.Join(workDir, "b.bin")); !os.IsNotExist(err) {
			t.Errorf("the partial file was kept: %v", err)
		}
	})

	// An overwrite has already truncated the user's file when the limit hits,
	// so removing it would turn a damaged file into a missing one.
	t.Run("keeps an overwritten file when the upload is cut short", func(t *testing.T) {
		h, workDir := newTestHandler(t)
		h.maxUpload = 4
		writeFile(t, workDir, "a.txt", []byte("original"))

		rec := upload(t, h, "overwrite=true", uploadFile{name: "a.txt", content: []byte("way too long")})

		assertError(t, rec, http.StatusRequestEntityTooLarge, CodeTooLarge)
		if _, err := os.Stat(filepath.Join(workDir, "a.txt")); err != nil {
			t.Errorf("the overwritten file was removed: %v", err)
		}
	})

	// What survives Part.FileName's stripping can still be a name that resolves
	// to something other than a file in the destination.
	t.Run("refuses a file name that is not a file name", func(t *testing.T) {
		h, _ := newTestHandler(t)

		for _, name := range []string{"..", ".", "/"} {
			rec := upload(t, h, "", uploadFile{name: name, content: []byte("x")})
			assertError(t, rec, http.StatusBadRequest, CodeInvalidPath)
		}
	})

	t.Run("refuses a destination outside the work directory", func(t *testing.T) {
		h, _ := newTestHandler(t)

		rec := upload(t, h, "path=..", uploadFile{name: "a.txt", content: []byte("x")})

		assertError(t, rec, http.StatusBadRequest, CodeInvalidPath)
	})

	t.Run("reports a missing destination directory", func(t *testing.T) {
		h, _ := newTestHandler(t)

		rec := upload(t, h, "path=nope", uploadFile{name: "a.txt", content: []byte("x")})

		assertError(t, rec, http.StatusNotFound, CodeNotFound)
	})

	t.Run("reports a destination that is a file", func(t *testing.T) {
		h, workDir := newTestHandler(t)
		writeFile(t, workDir, "a.txt", []byte("x"))

		rec := upload(t, h, "path=a.txt", uploadFile{name: "b.txt", content: []byte("x")})

		assertError(t, rec, http.StatusBadRequest, CodeNotADirectory)
	})

	t.Run("reports a directory in the way of an uploaded file", func(t *testing.T) {
		h, workDir := newTestHandler(t)
		if err := os.Mkdir(filepath.Join(workDir, "a.txt"), 0755); err != nil {
			t.Fatalf("failed to create directory: %v", err)
		}

		rec := upload(t, h, "", uploadFile{name: "a.txt", content: []byte("x")})

		assertError(t, rec, http.StatusConflict, CodeConflict)
	})

	// Writing through a link would land outside the workspace, and an O_WRONLY
	// open of a fifo would block until someone read from it.
	t.Run("refuses to overwrite anything but a regular file", func(t *testing.T) {
		h, workDir := newTestHandler(t)
		if err := os.Symlink("/tmp/target", filepath.Join(workDir, "link.txt")); err != nil {
			t.Fatalf("failed to create symlink: %v", err)
		}
		if err := syscall.Mkfifo(filepath.Join(workDir, "pipe"), 0644); err != nil {
			t.Skipf("cannot create a fifo here: %v", err)
		}

		for _, name := range []string{"link.txt", "pipe"} {
			req := newUploadRequest(t, "overwrite=true", uploadFile{name: name, content: []byte("x")})
			done := make(chan *httptest.ResponseRecorder, 1)
			go func() {
				rec := httptest.NewRecorder()
				h.Upload(rec, req)
				done <- rec
			}()

			select {
			case rec := <-done:
				assertError(t, rec, http.StatusConflict, CodeConflict)
			case <-time.After(5 * time.Second):
				t.Fatalf("upload blocked on %s", name)
			}
		}
	})

	t.Run("refuses an overwrite flag it cannot read", func(t *testing.T) {
		h, workDir := newTestHandler(t)
		writeFile(t, workDir, "a.txt", []byte("original"))

		rec := upload(t, h, "overwrite=yes", uploadFile{name: "a.txt", content: []byte("new")})

		assertError(t, rec, http.StatusBadRequest, CodeInvalidRequest)
		data, err := os.ReadFile(filepath.Join(workDir, "a.txt"))
		if err != nil {
			t.Fatalf("failed to read file: %v", err)
		}
		if string(data) != "original" {
			t.Errorf("got %q, want the untouched %q", data, "original")
		}
	})

	t.Run("refuses a request that is not multipart", func(t *testing.T) {
		h, _ := newTestHandler(t)

		req := httptest.NewRequest(http.MethodPost, "/api/files/upload", strings.NewReader("raw"))
		req.Header.Set("Content-Type", "text/plain")
		rec := httptest.NewRecorder()
		h.Upload(rec, req)

		assertError(t, rec, http.StatusBadRequest, CodeInvalidRequest)
	})

	t.Run("refuses a multipart request with no file parts", func(t *testing.T) {
		h, _ := newTestHandler(t)

		rec := upload(t, h, "")

		assertError(t, rec, http.StatusBadRequest, CodeInvalidRequest)
	})

	t.Run("reports an unknown worktree", func(t *testing.T) {
		h, _ := newTestHandler(t)

		rec := upload(t, h, "worktree=ghost", uploadFile{name: "a.txt", content: []byte("x")})

		assertError(t, rec, http.StatusNotFound, CodeWorktreeUnknown)
	})

	// A connection that dies mid-file is the client's problem, not a server
	// fault, and must not leave a half-written file behind.
	t.Run("reports a body that ends mid-file", func(t *testing.T) {
		h, workDir := newTestHandler(t)

		req := newUploadRequest(t, "", uploadFile{name: "a.bin", content: bytes.Repeat([]byte("x"), 64)})
		whole, err := io.ReadAll(req.Body)
		if err != nil {
			t.Fatalf("failed to read request body: %v", err)
		}
		req.Body = io.NopCloser(bytes.NewReader(whole[:len(whole)-20]))

		rec := httptest.NewRecorder()
		h.Upload(rec, req)

		body := assertError(t, rec, http.StatusBadRequest, CodeInvalidRequest)
		// Names the file whose write was interrupted, so this is the cut-short
		// branch and not a multipart parse error that never opened anything.
		if !strings.Contains(body.Error, "a.bin") || !strings.Contains(body.Error, "cut short") {
			t.Errorf("got error %q, want it to name a.bin as cut short", body.Error)
		}
		if _, err := os.Stat(filepath.Join(workDir, "a.bin")); !os.IsNotExist(err) {
			t.Errorf("the partial file was kept: %v", err)
		}
	})
}
