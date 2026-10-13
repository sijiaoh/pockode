package filetransfer

import (
	"errors"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pockode/server/attachments"
	"github.com/pockode/server/authsession"
	"github.com/pockode/server/git"
	"github.com/pockode/server/internal/symlinktest"
)

type rawFixture struct {
	h       *RawHandler
	workDir string
	dataDir string
	session string
}

func newRawFixture(t *testing.T) rawFixture {
	t.Helper()
	files, workDir := newTestHandler(t)
	attachmentHandler, dataDir := newAttachmentHandler(t)
	sessions, err := authsession.NewStore(t.TempDir(), "hunter2")
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	session, err := sessions.Issue()
	if err != nil {
		t.Fatalf("Issue session: %v", err)
	}
	return rawFixture{
		h:       NewRawHandler(sessions, files, attachmentHandler),
		workDir: workDir,
		dataDir: dataDir,
		session: session,
	}
}

func (f rawFixture) issue(t *testing.T, grant RawGrant) string {
	t.Helper()
	capability, _, err := f.h.Issue(f.session, grant)
	if err != nil {
		t.Fatalf("Issue(%+v): %v", grant, err)
	}
	return capability
}

// get requests target, which is a raw URL path as a browser would send it, and
// checks the headers every raw response carries whatever its status.
func (f rawFixture) get(t *testing.T, target string, header http.Header) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, target, nil)
	for k, v := range header {
		req.Header[k] = v
	}
	rec := httptest.NewRecorder()
	f.h.ServeHTTP(rec, req)
	assertRawHeaders(t, rec)
	return rec
}

func assertRawHeaders(t *testing.T, rec *httptest.ResponseRecorder) {
	t.Helper()
	for header, want := range map[string]string{
		"Content-Security-Policy": "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox",
		"X-Content-Type-Options":  "nosniff",
		"Referrer-Policy":         "no-referrer",
		"Cache-Control":           "private, no-cache",
		// An error too, or a page's fetch() sees only a network failure.
		"Access-Control-Allow-Origin":   "*",
		"Access-Control-Expose-Headers": "Accept-Ranges, Content-Range, ETag",
	} {
		if got := rec.Header().Get(header); got != want {
			t.Errorf("%s = %q, want %q (status %d)", header, got, want, rec.Code)
		}
	}
}

func assertBody(t *testing.T, rec *httptest.ResponseRecorder, status int, body string) {
	t.Helper()
	if rec.Code != status {
		t.Fatalf("status %d, want %d: %s", rec.Code, status, rec.Body.String())
	}
	if got := rec.Body.String(); got != body {
		t.Errorf("body = %q, want %q", got, body)
	}
}

func TestRawIssue(t *testing.T) {
	f := newRawFixture(t)

	for name, grant := range map[string]RawGrant{
		"unknown origin":             {Origin: "elsewhere", Scope: RawScopeFile, Path: "a.txt"},
		"unknown scope":              {Origin: RawOriginFile, Scope: "everything", Path: "a.txt"},
		"file path escaping":         {Origin: RawOriginFile, Scope: RawScopeFile, Path: "../a.txt"},
		"absolute directory":         {Origin: RawOriginFile, Scope: RawScopeDirectory, Path: "/etc"},
		"file scope without a file":  {Origin: RawOriginFile, Scope: RawScopeFile, Path: ""},
		"commit without a hash":      {Origin: RawOriginCommit, Scope: RawScopeFile, Path: "a.txt"},
		"attachment directory":       {Origin: RawOriginAttachment, Scope: RawScopeDirectory, SessionID: "sess", Path: "id"},
		"attachment without session": {Origin: RawOriginAttachment, Scope: RawScopeFile, Path: "id"},
		// A page at the root of the project gets no directory scope: the root
		// holds .git, secrets and Pockode's own data directory.
		"the work directory itself":   {Origin: RawOriginFile, Scope: RawScopeDirectory, Path: ""},
		"the work directory as .":     {Origin: RawOriginFile, Scope: RawScopeDirectory, Path: "."},
		"the work directory, cleaned": {Origin: RawOriginFile, Scope: RawScopeDirectory, Path: "site/.."},
		// A "\" on Windows, where it separates as well as "/" does.
		"the work directory, natively":   {Origin: RawOriginFile, Scope: RawScopeDirectory, Path: "site" + string(filepath.Separator) + ".."},
		"the work directory as native .": {Origin: RawOriginFile, Scope: RawScopeDirectory, Path: "." + string(filepath.Separator)},
		"the commit's root":              {Origin: RawOriginCommit, Scope: RawScopeDirectory, Hash: "abcdef0", Path: ""},
		// A directory scope never reaches a dotfile, so it cannot be one.
		"a dot directory":           {Origin: RawOriginFile, Scope: RawScopeDirectory, Path: ".pockode"},
		"within a dot directory":    {Origin: RawOriginFile, Scope: RawScopeDirectory, Path: ".git/hooks"},
		"a dot directory, cleaned":  {Origin: RawOriginFile, Scope: RawScopeDirectory, Path: "site/../.pockode"},
		"a dot directory, natively": {Origin: RawOriginFile, Scope: RawScopeDirectory, Path: "site" + string(filepath.Separator) + ".git"},
		"a commit's dot directory":  {Origin: RawOriginCommit, Scope: RawScopeDirectory, Hash: "abcdef0", Path: "docs/.vitepress"},
	} {
		t.Run(name, func(t *testing.T) {
			if _, _, err := f.h.Issue(f.session, grant); !errors.Is(err, ErrInvalidGrant) {
				t.Errorf("err = %v, want ErrInvalidGrant", err)
			}
		})
	}

	t.Run("a dotfile in a file scope", func(t *testing.T) {
		f.issue(t, RawGrant{Origin: RawOriginFile, Scope: RawScopeFile, Path: ".github/page.html"})
	})

	t.Run("for a session that is not live", func(t *testing.T) {
		grant := RawGrant{Origin: RawOriginFile, Scope: RawScopeFile, Path: "a.txt"}
		if _, _, err := f.h.Issue("not-a-session", grant); !errors.Is(err, authsession.ErrSessionNotLive) {
			t.Errorf("err = %v, want ErrSessionNotLive", err)
		}
	})
}

func TestRawWorkDirFile(t *testing.T) {
	t.Run("serves the file as its own type", func(t *testing.T) {
		f := newRawFixture(t)
		writeFile(t, f.workDir, "site/index.html", []byte("<!doctype html><p>hi"))
		writeFile(t, f.workDir, "site/style.css", []byte("p { color: red }"))
		writeFile(t, f.workDir, "site/app.js", []byte("console.log(1)"))
		writeFile(t, f.workDir, "site/clip.mov", []byte("\x00\x00\x00\x14moov-not-sniffable"))
		writeFile(t, f.workDir, "site/image.png", []byte("\x89PNG\r\n\x1a\nrest"))
		capability := f.issue(t, RawGrant{Origin: RawOriginFile, Scope: RawScopeDirectory, Path: "site"})

		for name, want := range map[string]string{
			"index.html": "text/html; charset=utf-8",
			// A sniffer calls these text/plain, which a browser refuses to
			// apply or run under nosniff.
			"style.css": "text/css; charset=utf-8",
			"app.js":    "text/javascript; charset=utf-8",
			"clip.mov":  "video/quicktime",
			"image.png": "image/png",
		} {
			rec := f.get(t, RawPath(capability, name), nil)
			if rec.Code != http.StatusOK {
				t.Fatalf("%s: status %d: %s", name, rec.Code, rec.Body.String())
			}
			if got := rec.Header().Get("Content-Type"); got != want {
				t.Errorf("%s: Content-Type = %q, want %q", name, got, want)
			}
			if got := rec.Header().Get("Content-Disposition"); got != "" {
				t.Errorf("%s: Content-Disposition = %q, want none: the element has to render it", name, got)
			}
		}
	})

	t.Run("serves a download as an attachment the link names", func(t *testing.T) {
		f := newRawFixture(t)
		writeFile(t, f.workDir, "site/index.html", []byte("<!doctype html><p>hi"))
		capability := f.issue(t, RawGrant{Origin: RawOriginFile, Scope: RawScopeFile, Path: "site/index.html"})

		rec := f.get(t, RawPath(capability, "index.html")+"?"+RawDownloadParam+"=1", nil)

		assertBody(t, rec, http.StatusOK, "<!doctype html><p>hi")
		if got := rec.Header().Get("Content-Disposition"); got != "attachment" {
			t.Errorf("Content-Disposition = %q, want attachment", got)
		}
	})

	// The client asks for the first byte before a download (saveRawFile); a
	// 416 here would make every empty file undownloadable.
	t.Run("serves an empty file asked for its first byte", func(t *testing.T) {
		f := newRawFixture(t)
		writeFile(t, f.workDir, "empty.txt", nil)
		capability := f.issue(t, RawGrant{Origin: RawOriginFile, Scope: RawScopeFile, Path: "empty.txt"})

		rec := f.get(t, RawPath(capability, "empty.txt"), http.Header{"Range": {"bytes=0-0"}})

		assertBody(t, rec, http.StatusOK, "")
	})

	t.Run("answers a range", func(t *testing.T) {
		f := newRawFixture(t)
		writeFile(t, f.workDir, "media/clip.mp4", []byte("0123456789"))
		capability := f.issue(t, RawGrant{Origin: RawOriginFile, Scope: RawScopeFile, Path: "media/clip.mp4"})

		rec := f.get(t, RawPath(capability, "clip.mp4"), http.Header{"Range": {"bytes=2-5"}})

		assertBody(t, rec, http.StatusPartialContent, "2345")
		if got := rec.Header().Get("Content-Range"); got != "bytes 2-5/10" {
			t.Errorf("Content-Range = %q, want bytes 2-5/10", got)
		}
	})

	t.Run("answers HEAD with the type and length alone", func(t *testing.T) {
		f := newRawFixture(t)
		writeFile(t, f.workDir, "site/index.html", []byte("<!doctype html>"))
		capability := f.issue(t, RawGrant{Origin: RawOriginFile, Scope: RawScopeFile, Path: "site/index.html"})

		rec := httptest.NewRecorder()
		f.h.ServeHTTP(rec, httptest.NewRequest(http.MethodHead, RawPath(capability, "index.html"), nil))
		assertRawHeaders(t, rec)
		assertBody(t, rec, http.StatusOK, "")
		if got := rec.Header().Get("Content-Type"); got != "text/html; charset=utf-8" {
			t.Errorf("Content-Type = %q, want text/html", got)
		}
		if got := rec.Header().Get("Content-Length"); got != "15" {
			t.Errorf("Content-Length = %q, want 15", got)
		}
	})

	// ServeContent clears Cache-Control before refusing a range; the headers
	// still have to reach the response.
	t.Run("refuses a range past the end with the same headers", func(t *testing.T) {
		f := newRawFixture(t)
		writeFile(t, f.workDir, "media/clip.mp4", []byte("01234"))
		capability := f.issue(t, RawGrant{Origin: RawOriginFile, Scope: RawScopeFile, Path: "media/clip.mp4"})

		rec := f.get(t, RawPath(capability, "clip.mp4"), http.Header{"Range": {"bytes=100-200"}})
		if rec.Code != http.StatusRequestedRangeNotSatisfiable {
			t.Errorf("status %d, want 416", rec.Code)
		}
	})

	t.Run("revalidates against the file's modification time", func(t *testing.T) {
		f := newRawFixture(t)
		writeFile(t, f.workDir, "a.txt", []byte("a"))
		capability := f.issue(t, RawGrant{Origin: RawOriginFile, Scope: RawScopeFile, Path: "a.txt"})

		first := f.get(t, RawPath(capability, "a.txt"), nil)
		lastModified := first.Header().Get("Last-Modified")
		if lastModified == "" {
			t.Fatal("no Last-Modified to revalidate against")
		}
		rec := f.get(t, RawPath(capability, "a.txt"), http.Header{"If-Modified-Since": {lastModified}})
		if rec.Code != http.StatusNotModified {
			t.Errorf("status %d, want 304", rec.Code)
		}
	})
}

func TestRawScope(t *testing.T) {
	f := newRawFixture(t)
	writeFile(t, f.workDir, ".env", []byte("SECRET=1"))
	writeFile(t, f.workDir, "site/index.html", []byte("index"))
	writeFile(t, f.workDir, "site/sub/page.html", []byte("page"))
	directory := f.issue(t, RawGrant{Origin: RawOriginFile, Scope: RawScopeDirectory, Path: "site"})
	file := f.issue(t, RawGrant{Origin: RawOriginFile, Scope: RawScopeFile, Path: "site/sub/page.html"})

	t.Run("a directory scope reaches its descendants", func(t *testing.T) {
		assertBody(t, f.get(t, RawPath(directory, "index.html"), nil), http.StatusOK, "index")
		assertBody(t, f.get(t, RawPath(directory, "sub/page.html"), nil), http.StatusOK, "page")
	})

	t.Run("a file scope reaches its file alone", func(t *testing.T) {
		assertBody(t, f.get(t, RawPath(file, "page.html"), nil), http.StatusOK, "page")
		assertError(t, f.get(t, RawPath(file, "index.html"), nil), http.StatusForbidden, CodeOutsideScope)
		assertError(t, f.get(t, RawPath(file, "sub/page.html"), nil), http.StatusForbidden, CodeOutsideScope)
	})

	t.Run("refuses .. however it is spelled", func(t *testing.T) {
		for _, target := range []string{
			RawPathPrefix + directory + "/../.env",
			RawPathPrefix + directory + "/sub/../../.env",
			RawPathPrefix + directory + "/%2e%2e/.env",
			RawPathPrefix + directory + "/..%2f.env",
			RawPathPrefix + file + "/../index.html",
		} {
			assertError(t, f.get(t, target, nil), http.StatusBadRequest, CodeInvalidPath)
		}
	})

	t.Run("a directory scope refuses dotfiles beneath it", func(t *testing.T) {
		writeFile(t, f.workDir, "site/.env", []byte("SECRET=2"))
		writeFile(t, f.workDir, "site/.git/config", []byte("config"))
		for _, rel := range []string{".env", ".git/config", "sub/.hidden.css", "sub/../.env", "sub/./page.html"} {
			assertError(t, f.get(t, RawPath(directory, rel), nil), http.StatusForbidden, CodeOutsideScope)
		}
		assertError(t, f.get(t, RawPathPrefix+directory+"/%2eenv", nil), http.StatusForbidden, CodeOutsideScope)
	})

	t.Run("a file scope serves the dotfile it names", func(t *testing.T) {
		env := f.issue(t, RawGrant{Origin: RawOriginFile, Scope: RawScopeFile, Path: ".env"})
		assertBody(t, f.get(t, RawPath(env, ".env"), nil), http.StatusOK, "SECRET=1")
	})

	t.Run("refuses a directory or the scope itself", func(t *testing.T) {
		assertError(t, f.get(t, RawPath(directory, "sub"), nil), http.StatusBadRequest, CodeNotAFile)
		assertError(t, f.get(t, RawPathPrefix+directory+"/", nil), http.StatusBadRequest, CodeInvalidPath)
		assertError(t, f.get(t, RawPathPrefix+directory, nil), http.StatusBadRequest, CodeInvalidPath)
	})

	t.Run("refuses a symlink out of the scope", func(t *testing.T) {
		outside := filepath.Join(t.TempDir(), "outside.txt")
		writeFile(t, filepath.Dir(outside), "outside.txt", []byte("outside"))
		symlinktest.Make(t, filepath.Join("..", ".env"), filepath.Join(f.workDir, "site", "env"))
		symlinktest.Make(t, outside, filepath.Join(f.workDir, "site", "abs"))
		symlinktest.Make(t, "index.html", filepath.Join(f.workDir, "site", "alias.html"))
		symlinktest.Make(t, filepath.Dir(outside), filepath.Join(f.workDir, "elsewhere"))
		symlinktest.Make(t, outside, filepath.Join(f.workDir, "linked.txt"))

		// Out of the directory, though still in the project.
		assertError(t, f.get(t, RawPath(directory, "env"), nil), http.StatusForbidden, CodeOutsideScope)
		assertError(t, f.get(t, RawPath(directory, "abs"), nil), http.StatusForbidden, CodeOutsideScope)
		// A link that stays inside is just another name for a file there.
		assertBody(t, f.get(t, RawPath(directory, "alias.html"), nil), http.StatusOK, "index")

		// The scope directory itself a link out of the project.
		linkedDir := f.issue(t, RawGrant{Origin: RawOriginFile, Scope: RawScopeDirectory, Path: "elsewhere"})
		assertError(t, f.get(t, RawPath(linkedDir, "outside.txt"), nil), http.StatusForbidden, CodeOutsideScope)
		// A file scope is held to the project.
		linkedFile := f.issue(t, RawGrant{Origin: RawOriginFile, Scope: RawScopeFile, Path: "linked.txt"})
		assertError(t, f.get(t, RawPath(linkedFile, "linked.txt"), nil), http.StatusForbidden, CodeOutsideScope)
		// A link that stays in the project but leads to its root would give the
		// directory scope the root it must never have, however deep it sits.
		// The file asked for is no dotfile, which is refused before the scope
		// is opened at all.
		writeFile(t, f.workDir, "root.txt", []byte("root"))
		symlinktest.Make(t, ".", filepath.Join(f.workDir, "root"))
		symlinktest.Make(t, "..", filepath.Join(f.workDir, "site", "up"))
		for _, dir := range []string{"root", "site/up", "site/up/site"} {
			linked := f.issue(t, RawGrant{Origin: RawOriginFile, Scope: RawScopeDirectory, Path: dir})
			assertError(t, f.get(t, RawPath(linked, "root.txt"), nil), http.StatusForbidden, CodeOutsideScope)
		}
	})
}

// A path the client did not clean still names its file, under the name the
// entry path gives it.
func TestRawEntryPathOfAnUncleanFile(t *testing.T) {
	f := newRawFixture(t)
	writeFile(t, f.workDir, "dir/a.mp4", []byte("a"))

	for _, p := range []string{"dir/x/../a.mp4", "dir/a.mp4/.", "./dir//a.mp4"} {
		grant := RawGrant{Origin: RawOriginFile, Scope: RawScopeFile, Path: p}
		assertBody(t, f.get(t, RawEntryPath(f.issue(t, grant), grant), nil), http.StatusOK, "a")
	}
}

func TestRawRefusesWithoutAValidCapability(t *testing.T) {
	f := newRawFixture(t)
	writeFile(t, f.workDir, "a.txt", []byte("a"))
	capability := f.issue(t, RawGrant{Origin: RawOriginFile, Scope: RawScopeFile, Path: "a.txt"})

	for _, forged := range []string{"", "x", capability + "x", capability[1:], f.session} {
		assertError(t, f.get(t, RawPath(forged, "a.txt"), nil), http.StatusNotFound, CodeCapabilityUnknown)
	}
}

func TestRawRefusesOtherMethods(t *testing.T) {
	f := newRawFixture(t)
	writeFile(t, f.workDir, "a.txt", []byte("a"))
	capability := f.issue(t, RawGrant{Origin: RawOriginFile, Scope: RawScopeFile, Path: "a.txt"})

	rec := httptest.NewRecorder()
	f.h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, RawPath(capability, "a.txt"), nil))
	assertRawHeaders(t, rec)
	assertError(t, rec, http.StatusMethodNotAllowed, CodeInvalidRequest)
	if got := rec.Header().Get("Allow"); got != "GET, HEAD, OPTIONS" {
		t.Errorf("Allow = %q", got)
	}
}

// A page's fetch() with a header that is not CORS-safelisted, such as a
// multi-range Range, is preceded by a preflight, which carries no credential.
func TestRawAnswersAPreflight(t *testing.T) {
	f := newRawFixture(t)

	req := httptest.NewRequest(http.MethodOptions, RawPath("any-capability", "a.txt"), nil)
	req.Header.Set("Origin", "null")
	req.Header.Set("Access-Control-Request-Method", "GET")
	req.Header.Set("Access-Control-Request-Headers", "range,x-requested-with")
	rec := httptest.NewRecorder()
	f.h.ServeHTTP(rec, req)
	assertRawHeaders(t, rec)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status %d, want 204: %s", rec.Code, rec.Body.String())
	}
	for header, want := range map[string]string{
		"Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
		"Access-Control-Allow-Headers": "range,x-requested-with",
	} {
		if got := rec.Header().Get(header); got != want {
			t.Errorf("%s = %q, want %q", header, got, want)
		}
	}
	if got := rec.Header().Get("Access-Control-Allow-Credentials"); got != "" {
		t.Errorf("Access-Control-Allow-Credentials = %q, want none", got)
	}
}

func TestRawCommitFile(t *testing.T) {
	f := newRawFixture(t)
	// Longer than the head kept from sniffing, so that reading behind the
	// stream has to run git again rather than answer from that copy.
	committed := strings.Repeat("0123456789", 100)
	hash := commitFile(t, f.workDir, "site/clip.mp4", []byte(committed))
	// The working copy has moved on; the responses are the commit's version.
	writeFile(t, f.workDir, "site/clip.mp4", []byte("edited"))
	capability := f.issue(t, RawGrant{Origin: RawOriginCommit, Scope: RawScopeDirectory, Hash: hash, Path: "site"})

	t.Run("serves the committed bytes", func(t *testing.T) {
		assertBody(t, f.get(t, RawPath(capability, "clip.mp4"), nil), http.StatusOK, committed)
	})

	t.Run("answers a range", func(t *testing.T) {
		rec := f.get(t, RawPath(capability, "clip.mp4"), http.Header{"Range": {"bytes=996-"}})
		assertBody(t, rec, http.StatusPartialContent, "6789")
	})

	// A multi-range answer reads the blob out of order, which is the case that
	// has to run git again.
	t.Run("answers several ranges", func(t *testing.T) {
		rec := f.get(t, RawPath(capability, "clip.mp4"), http.Header{"Range": {"bytes=907-908,601-602"}})
		if rec.Code != http.StatusPartialContent {
			t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
		}
		_, params, err := mime.ParseMediaType(rec.Header().Get("Content-Type"))
		if err != nil {
			t.Fatal(err)
		}
		reader := multipart.NewReader(rec.Body, params["boundary"])
		var parts []string
		for {
			part, err := reader.NextPart()
			if errors.Is(err, io.EOF) {
				break
			}
			if err != nil {
				t.Fatal(err)
			}
			data, err := io.ReadAll(part)
			if err != nil {
				t.Fatal(err)
			}
			parts = append(parts, string(data))
		}
		if got := strings.Join(parts, ","); got != "78,12" {
			t.Errorf("parts = %q, want 78,12", got)
		}
	})

	t.Run("revalidates by ETag", func(t *testing.T) {
		etag := f.get(t, RawPath(capability, "clip.mp4"), nil).Header().Get("ETag")
		if etag == "" {
			t.Fatal("no ETag")
		}
		rec := f.get(t, RawPath(capability, "clip.mp4"), http.Header{"If-None-Match": {etag}})
		if rec.Code != http.StatusNotModified {
			t.Errorf("status %d, want 304", rec.Code)
		}
	})

	t.Run("refuses what is not in the commit or the scope", func(t *testing.T) {
		assertError(t, f.get(t, RawPath(capability, "missing.mp4"), nil), http.StatusNotFound, CodeNotFound)
		assertError(t, f.get(t, RawPathPrefix+capability+"/../site/clip.mp4", nil), http.StatusBadRequest, CodeInvalidPath)
		assertError(t, f.get(t, RawPath(capability, ".env"), nil), http.StatusForbidden, CodeOutsideScope)
	})
}

func TestRawAttachment(t *testing.T) {
	f := newRawFixture(t)
	id, err := attachments.NewStore(f.dataDir, "sess").Put([]byte("\x89PNG\r\n\x1a\nrest"), "")
	if err != nil {
		t.Fatal(err)
	}

	capability := f.issue(t, RawGrant{Origin: RawOriginAttachment, Scope: RawScopeFile, SessionID: "sess", Path: id})
	rec := f.get(t, RawPath(capability, id), nil)
	assertBody(t, rec, http.StatusOK, "\x89PNG\r\n\x1a\nrest")
	if got := rec.Header().Get("Content-Type"); got != "image/png" {
		t.Errorf("Content-Type = %q, want image/png", got)
	}

	missing := f.issue(t, RawGrant{Origin: RawOriginAttachment, Scope: RawScopeFile, SessionID: "sess", Path: "0000"})
	assertError(t, f.get(t, RawPath(missing, "0000"), nil), http.StatusNotFound, CodeNotFound)
	unknownSession := f.issue(t, RawGrant{Origin: RawOriginAttachment, Scope: RawScopeFile, SessionID: "other", Path: id})
	assertError(t, f.get(t, RawPath(unknownSession, id), nil), http.StatusNotFound, CodeSessionUnknown)
}

// ServeContent copies a multi-range answer out in a goroutine of its own, which
// can still be reading after the handler has closed the reader; it must find
// the reader closed rather than start git again or read a stream torn down
// beneath it.
func TestCommitReaderRefusesReadsAfterClose(t *testing.T) {
	opened := 0
	c := &commitReader{
		open: func() (*git.Blob, error) {
			opened++
			return nil, errors.New("git must not run")
		},
		size: 10,
	}
	if err := c.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Read(make([]byte, 4)); !errors.Is(err, os.ErrClosed) {
		t.Errorf("Read after Close: err = %v, want os.ErrClosed", err)
	}
	if opened != 0 {
		t.Errorf("git started %d times after Close, want 0", opened)
	}
}
