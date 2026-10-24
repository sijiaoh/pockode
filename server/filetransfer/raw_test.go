package filetransfer

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strconv"
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
	files.dataDir = dataDir
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
	// The floor every response stands on, which the page's policy is added to.
	if got := rec.Header().Get("Content-Security-Policy"); !strings.HasPrefix(got, "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; default-src ") {
		t.Errorf("Content-Security-Policy = %q, want the sandbox and a default-src (status %d)", got, rec.Code)
	}
	for header, want := range map[string]string{
		"X-DNS-Prefetch-Control": "off",
		"X-Content-Type-Options": "nosniff",
		"Referrer-Policy":        "no-referrer",
		"Cache-Control":          "private, no-cache",
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
		"file scope without a file":  {Origin: RawOriginFile, Scope: RawScopeFile, Path: ""},
		"file scope at the root":     {Origin: RawOriginFile, Scope: RawScopeFile, Path: "site/.."},
		"commit without a hash":      {Origin: RawOriginCommit, Scope: RawScopeFile, Path: "a.txt"},
		"attachment root":            {Origin: RawOriginAttachment, Scope: RawScopeRoot, SessionID: "sess"},
		"attachment without session": {Origin: RawOriginAttachment, Scope: RawScopeFile, Path: "id"},
		// A root scope has one spelling, so that no path in it is mistaken for
		// one the scope is held to.
		"root scope with a path": {Origin: RawOriginFile, Scope: RawScopeRoot, Path: "site"},
		"root scope as .":        {Origin: RawOriginFile, Scope: RawScopeRoot, Path: "."},
		"folder path escaping":   {Origin: RawOriginFile, Scope: RawScopeFolder, Path: "../site"},
		"folder of a commit":     {Origin: RawOriginCommit, Scope: RawScopeFolder, Hash: "abc", Path: "site"},
		"folder of attachments":  {Origin: RawOriginAttachment, Scope: RawScopeFolder, SessionID: "sess"},
		// A host goes into a header as written, so nothing in it may end a
		// source or a directive.
		"a host ending the directive":   {Origin: RawOriginFile, Scope: RawScopeFile, Path: "a.html", Hosts: []string{"cdn.example; script-src *"}},
		"a host with a scheme":          {Origin: RawOriginFile, Scope: RawScopeFile, Path: "a.html", Hosts: []string{"https://cdn.example"}},
		"a wildcard host":               {Origin: RawOriginFile, Scope: RawScopeFile, Path: "a.html", Hosts: []string{"*"}},
		"an IPv6 host":                  {Origin: RawOriginFile, Scope: RawScopeFile, Path: "a.html", Hosts: []string{"[::1]:80"}},
		"this server's own host":        {Origin: RawOriginFile, Scope: RawScopeFile, Path: "a.html", Hosts: []string{"app.example:8443"}, BaseURL: "https://app.example"},
		"this server's, with a dot":     {Origin: RawOriginFile, Scope: RawScopeFile, Path: "a.html", Hosts: []string{"app.example."}, BaseURL: "https://app.example"},
		"a host longer than DNS allows": {Origin: RawOriginFile, Scope: RawScopeFile, Path: "a.html", Hosts: []string{strings.Repeat("a", 254) + ".example"}},
		"too many hosts":                {Origin: RawOriginFile, Scope: RawScopeFile, Path: "a.html", Hosts: manyHosts(MaxRawGrantHosts + 1)},
		"a base URL of another scheme":  {Origin: RawOriginFile, Scope: RawScopeFile, Path: "a.html", BaseURL: "javascript:alert(1)"},
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

	t.Run("the root of the work directory or a commit", func(t *testing.T) {
		f.issue(t, RawGrant{Origin: RawOriginFile, Scope: RawScopeRoot})
		f.issue(t, RawGrant{Origin: RawOriginCommit, Scope: RawScopeRoot, Hash: "abcdef0"})
	})

	t.Run("for a session that is not live", func(t *testing.T) {
		grant := RawGrant{Origin: RawOriginFile, Scope: RawScopeFile, Path: "a.txt"}
		if _, _, err := f.h.Issue("not-a-session", grant); !errors.Is(err, authsession.ErrSessionNotLive) {
			t.Errorf("err = %v, want ErrSessionNotLive", err)
		}
	})
}

func manyHosts(n int) []string {
	hosts := make([]string, n)
	for i := range hosts {
		hosts[i] = "h" + strconv.Itoa(i) + ".example"
	}
	return hosts
}

func TestRawPagePolicy(t *testing.T) {
	newPage := func(t *testing.T, grant RawGrant) (rawFixture, string) {
		f := newRawFixture(t)
		writeFile(t, f.workDir, "index.html", []byte("<!doctype html><p>hi"))
		grant.Origin, grant.Scope = RawOriginFile, RawScopeRoot
		return f, f.issue(t, grant)
	}
	policy := func(rec *httptest.ResponseRecorder) string {
		return strings.TrimPrefix(rec.Header().Get("Content-Security-Policy"), "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; ")
	}

	t.Run("reaches its own capability and the hosts allowed for it, nothing else", func(t *testing.T) {
		f, capability := newPage(t, RawGrant{Hosts: []string{"cdn.example", "fonts.example:8443"}, BaseURL: "https://app.example/base/"})

		rec := f.get(t, RawPath(capability, "index.html"), nil)

		own := "https://app.example/base" + RawPathPrefix + capability + "/"
		hosts := "http://cdn.example https://cdn.example ws://cdn.example wss://cdn.example http://fonts.example:8443 https://fonts.example:8443 ws://fonts.example:8443 wss://fonts.example:8443"
		reach := own + " data: blob: " + hosts
		// Never an allowed host's documents: they would run under no policy.
		local := own + " data: blob:"
		want := "default-src " + reach + "; script-src 'unsafe-inline' 'unsafe-eval' " + reach + "; style-src 'unsafe-inline' " + reach + "; frame-src " + local + "; object-src 'none'; form-action " + own
		if got := policy(rec); got != want {
			t.Errorf("policy =\n%s\nwant\n%s", got, want)
		}
	})

	t.Run("without a base URL, its own capability on the Host asked", func(t *testing.T) {
		f, capability := newPage(t, RawGrant{})
		req := httptest.NewRequest(http.MethodGet, RawPath(capability, "index.html"), nil)
		req.Host = "192.168.1.5:9870"
		rec := httptest.NewRecorder()
		f.h.ServeHTTP(rec, req)

		own := "http://192.168.1.5:9870" + RawPathPrefix + capability + "/ https://192.168.1.5:9870" + RawPathPrefix + capability + "/"
		if got, want := policy(rec), "default-src "+own+" data: blob:;"; !strings.HasPrefix(got, want) {
			t.Errorf("policy = %q, want it to start %q", got, want)
		}
	})

	// Into a header as written, so nothing in it may end a source or a
	// directive.
	t.Run("a base URL a source cannot name names nothing", func(t *testing.T) {
		for _, base := range []string{"http://[::1]:9870", "https://app.example/a b;script-src *"} {
			f, capability := newPage(t, RawGrant{BaseURL: base})
			rec := f.get(t, RawPath(capability, "index.html"), nil)
			if got, want := policy(rec), "default-src data: blob:; script-src 'unsafe-inline' 'unsafe-eval' data: blob:; style-src 'unsafe-inline' data: blob:; frame-src data: blob:; object-src 'none'; form-action 'none'"; got != want {
				t.Errorf("base %q: policy = %q, want %q", base, got, want)
			}
		}
	})

	// Without a base URL the issuer could not tell; the Host can.
	t.Run("never allows the Host asked, under any spelling", func(t *testing.T) {
		f, capability := newPage(t, RawGrant{Hosts: []string{"app.example:8443", "app.example.", "cdn.example"}})
		req := httptest.NewRequest(http.MethodGet, RawPath(capability, "index.html"), nil)
		req.Host = "app.example"
		rec := httptest.NewRecorder()
		f.h.ServeHTTP(rec, req)

		got := policy(rec)
		if strings.Contains(got, "//app.example:") || strings.Contains(got, "//app.example. ") || !strings.Contains(got, "https://cdn.example") {
			t.Errorf("policy = %q, want cdn.example and no other name of app.example", got)
		}
	})

	t.Run("a Host a source cannot name names nothing", func(t *testing.T) {
		f, capability := newPage(t, RawGrant{})
		req := httptest.NewRequest(http.MethodGet, RawPath(capability, "index.html"), nil)
		req.Host = "[::1]:9870"
		rec := httptest.NewRecorder()
		f.h.ServeHTTP(rec, req)

		if got, want := policy(rec), "default-src data: blob:; script-src 'unsafe-inline' 'unsafe-eval' data: blob:; style-src 'unsafe-inline' data: blob:; frame-src data: blob:; object-src 'none'; form-action 'none'"; got != want {
			t.Errorf("policy = %q, want %q", got, want)
		}
	})

	// The allowance is the capability's, never the URL's: the page can
	// navigate itself anywhere, so whatever a URL says it could say too.
	t.Run("nothing in the URL widens it", func(t *testing.T) {
		f, capability := newPage(t, RawGrant{BaseURL: "https://app.example"})
		plain := policy(f.get(t, RawPath(capability, "index.html"), nil))

		for _, target := range []string{
			RawPath(capability, "index.html") + "?hosts=evil.example&host=evil.example&h=evil.example",
			RawPath(capability, "index.html") + "?" + RawDownloadParam + "=1&hosts=evil.example",
			RawPath(capability, "evil.example/index.html"),
		} {
			if got := policy(f.get(t, target, nil)); got != plain {
				t.Errorf("GET %s: policy = %q, want %q", target, got, plain)
			}
		}
	})

	t.Run("names its own capability on the base URL's host in lower case", func(t *testing.T) {
		f, capability := newPage(t, RawGrant{BaseURL: "HTTPS://App.Example/Base"})
		rec := f.get(t, RawPath(capability, "index.html"), nil)
		if got, want := policy(rec), "default-src https://app.example/Base"+RawPathPrefix+capability+"/ "; !strings.HasPrefix(got, want) {
			t.Errorf("policy = %q, want it to start %q", got, want)
		}
	})

	t.Run("an unknown capability reaches nothing", func(t *testing.T) {
		f := newRawFixture(t)
		rec := f.get(t, RawPathPrefix+"nope/index.html", nil)
		if got := policy(rec); got != "default-src 'none'" {
			t.Errorf("policy = %q, want default-src 'none'", got)
		}
	})
}

func TestRawPageReporter(t *testing.T) {
	framed := http.Header{"Sec-Fetch-Dest": {"iframe"}}
	serve := func(t *testing.T, name, body string, header http.Header, query string) (*httptest.ResponseRecorder, string) {
		t.Helper()
		f := newRawFixture(t)
		writeFile(t, f.workDir, name, []byte(body))
		capability := f.issue(t, RawGrant{Origin: RawOriginFile, Scope: RawScopeRoot})
		return f.get(t, RawPath(capability, name)+query, header), pageReporter(capability)
	}

	for _, tt := range []struct {
		name, body, before string
	}{
		// Ahead of a doctype the page would be in quirks mode.
		{"after the doctype", "<!DOCTYPE html>\n<html><head><script src=x></script>", "<!DOCTYPE html>"},
		{"after a doctype behind a comment", "\n<!-- built --> <!doctype html><p>", "\n<!-- built --> <!doctype html>"},
		{"after a doctype behind comments an HTML parser closes at once", "<!--><!---><!doctype html><p>", "<!--><!---><!doctype html>"},
		{"after the byte order mark", "\xEF\xBB\xBF<p>no doctype", "\xEF\xBB\xBF"},
		{"after a doctype behind an XML prolog", "<?xml version=\"1.0\"?>\n<!DOCTYPE html PUBLIC \"-//W3C//DTD XHTML 1.0 Strict//EN\" \"x.dtd\"><html>", "<?xml version=\"1.0\"?>\n<!DOCTYPE html PUBLIC \"-//W3C//DTD XHTML 1.0 Strict//EN\" \"x.dtd\">"},
		{"after a doctype behind a banner longer than the sniffed head", "<!-- " + strings.Repeat("licence ", 200) + "-->\n<!doctype html><p>", "<!-- " + strings.Repeat("licence ", 200) + "-->\n<!doctype html>"},
		{"at the start without a doctype", "<html><p>hi", ""},
		{"at the start when the doctype never ends", "<!doctype html", ""},
	} {
		t.Run("goes into a framed page "+tt.name, func(t *testing.T) {
			rec, reporter := serve(t, "index.html", tt.body, framed, "")

			want := tt.before + reporter + strings.TrimPrefix(tt.body, tt.before)
			assertBody(t, rec, http.StatusOK, want)
			if got := rec.Header().Get("Vary"); got != "Sec-Fetch-Dest" {
				t.Errorf("Vary = %q, want Sec-Fetch-Dest", got)
			}
			if got := rec.Header().Get("ETag") + rec.Header().Get("Last-Modified"); got != "" {
				t.Errorf("validators %q on bytes that are not the file's", got)
			}
		})
	}

	t.Run("goes into a page larger than what is sniffed", func(t *testing.T) {
		body := "<!doctype html>" + strings.Repeat("x", 10000)
		rec, reporter := serve(t, "index.html", body, framed, "")
		assertBody(t, rec, http.StatusOK, "<!doctype html>"+reporter+strings.Repeat("x", 10000))
	})

	// What the page or Save reads is the file as it is.
	for name, tt := range map[string]struct {
		header http.Header
		query  string
	}{
		"read by fetch()":        {http.Header{"Sec-Fetch-Dest": {"empty"}}, ""},
		"without fetch metadata": {nil, ""},
		"saved":                  {framed, "?" + RawDownloadParam + "=1"},
		"asked for a range":      {http.Header{"Sec-Fetch-Dest": {"iframe"}, "Range": {"bytes=0-3"}}, ""},
	} {
		t.Run("stays out of a page "+name, func(t *testing.T) {
			rec, reporter := serve(t, "index.html", "<!doctype html><p>hi", tt.header, tt.query)
			if strings.Contains(rec.Body.String(), reporter) {
				t.Errorf("body = %q, want the file as it is", rec.Body.String())
			}
		})
	}

	// The reporter's bytes are UTF-8; ahead of a UTF-16 page's byte order
	// mark they would garble it.
	t.Run("stays out of a page in UTF-16", func(t *testing.T) {
		body := "\xFF\xFE<\x00!\x00d\x00o\x00c\x00t\x00y\x00p\x00e\x00 \x00h\x00t\x00m\x00l\x00>\x00"
		rec, _ := serve(t, "index.html", body, framed, "")
		assertBody(t, rec, http.StatusOK, body)
	})

	t.Run("stays out of what is not a page", func(t *testing.T) {
		rec, _ := serve(t, "app.js", "console.log(1)", framed, "")
		assertBody(t, rec, http.StatusOK, "console.log(1)")
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
		capability := f.issue(t, RawGrant{Origin: RawOriginFile, Scope: RawScopeRoot})

		for name, want := range map[string]string{
			"index.html": "text/html; charset=utf-8",
			// A sniffer calls these text/plain, which a browser refuses to
			// apply or run under nosniff.
			"style.css": "text/css; charset=utf-8",
			"app.js":    "text/javascript; charset=utf-8",
			"clip.mov":  "video/quicktime",
			"image.png": "image/png",
		} {
			rec := f.get(t, RawPath(capability, "site/"+name), nil)
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
	// Where the data directory is by default, under a name no rule withholds.
	f.h.files.dataDir = filepath.Join(f.workDir, ".pockode")
	writeFile(t, f.workDir, ".env", []byte("SECRET=1"))
	writeFile(t, f.workDir, "index.html", []byte("index"))
	writeFile(t, f.workDir, "assets/style.css", []byte("style"))
	writeFile(t, f.workDir, "site/sub/page.html", []byte("page"))
	root := f.issue(t, RawGrant{Origin: RawOriginFile, Scope: RawScopeRoot})
	file := f.issue(t, RawGrant{Origin: RawOriginFile, Scope: RawScopeFile, Path: "site/sub/page.html"})

	t.Run("a root scope is opened at the root and reaches the whole project", func(t *testing.T) {
		if got, want := RawEntryPath(root, RawGrant{Scope: RawScopeRoot}), RawPathPrefix+root+"/"; got != want {
			t.Errorf("entry path = %q, want %q", got, want)
		}
		assertBody(t, f.get(t, RawPath(root, "index.html"), nil), http.StatusOK, "index")
		assertBody(t, f.get(t, RawPath(root, "site/sub/page.html"), nil), http.StatusOK, "page")
	})

	// What a page's relative URL resolves to in the browser, which is what
	// reaches the server: a page opened at its full path climbs out of its
	// own directory and stays in the capability.
	t.Run("a page's ../ reference resolves beneath the root", func(t *testing.T) {
		page, err := url.Parse("http://pockode.test" + RawPath(root, "site/sub/page.html"))
		if err != nil {
			t.Fatal(err)
		}
		for ref, body := range map[string]string{
			"../../assets/style.css":    "style",
			"../../index.html":          "index",
			RawPath(root, "index.html"): "index",
		} {
			resolved, err := page.Parse(ref)
			if err != nil {
				t.Fatal(err)
			}
			assertBody(t, f.get(t, resolved.Path, nil), http.StatusOK, body)
		}
		// Past the root it leaves the capability, which is no longer in the path.
		resolved, err := page.Parse("../../../index.html")
		if err != nil {
			t.Fatal(err)
		}
		assertError(t, f.get(t, resolved.Path, nil), http.StatusNotFound, CodeCapabilityUnknown)
	})

	t.Run("a file scope reaches its file alone", func(t *testing.T) {
		assertBody(t, f.get(t, RawPath(file, "page.html"), nil), http.StatusOK, "page")
		assertError(t, f.get(t, RawPath(file, "index.html"), nil), http.StatusForbidden, CodeOutsideScope)
		assertError(t, f.get(t, RawPath(file, "sub/page.html"), nil), http.StatusForbidden, CodeOutsideScope)
	})

	t.Run("refuses .. however it is spelled", func(t *testing.T) {
		for _, target := range []string{
			RawPathPrefix + root + "/../.env",
			RawPathPrefix + root + "/site/../../.env",
			RawPathPrefix + root + "/%2e%2e/.env",
			RawPathPrefix + root + "/..%2f.env",
			RawPathPrefix + file + "/../index.html",
		} {
			assertError(t, f.get(t, target, nil), http.StatusBadRequest, CodeInvalidPath)
		}
	})

	t.Run("a root scope withholds the sensitive names, at any depth and in any case", func(t *testing.T) {
		writeFile(t, f.workDir, ".env.local", []byte("SECRET=2"))
		writeFile(t, f.workDir, "site/.env", []byte("SECRET=3"))
		writeFile(t, f.workDir, "site/.Env.Production", []byte("SECRET=4"))
		writeFile(t, f.workDir, ".git/config", []byte("config"))
		writeFile(t, f.workDir, "vendor/repo/.git/config", []byte("nested"))
		writeFile(t, f.workDir, "vendor/module/.git", []byte("gitdir: ../../.git/modules/module"))
		writeFile(t, f.workDir, ".GIT/HEAD", []byte("ref"))
		writeFile(t, f.workDir, ".envrc", []byte("export SECRET=5"))
		writeFile(t, f.workDir, "sub/.ENVRC", []byte("export SECRET=6"))
		writeFile(t, f.workDir, ".envrc.local", []byte("export SECRET=7"))
		for _, rel := range []string{".env", ".env.local", "site/.env", "site/.Env.Production", ".git/config", "vendor/repo/.git/config", "vendor/module/.git", ".GIT/HEAD", ".envrc", "sub/.ENVRC", ".envrc.local"} {
			assertError(t, f.get(t, RawPath(root, rel), nil), http.StatusForbidden, CodeOutsideScope)
		}
		assertError(t, f.get(t, RawPathPrefix+root+"/%2eenv", nil), http.StatusForbidden, CodeOutsideScope)
	})

	t.Run("a root scope withholds the data directory", func(t *testing.T) {
		writeFile(t, f.workDir, ".pockode/sessions.json", []byte("{}"))
		assertError(t, f.get(t, RawPath(root, ".pockode/sessions.json"), nil), http.StatusForbidden, CodeOutsideScope)
	})

	t.Run("a root scope serves every other dot path", func(t *testing.T) {
		for rel, body := range map[string]string{
			"docs/.vitepress/dist/index.html": "built",
			".output/public/app.js":           "app",
			".github/workflows/ci.yml":        "ci",
			".well-known/security.txt":        "contact",
			"site/.environment.json":          "env",
		} {
			writeFile(t, f.workDir, rel, []byte(body))
			assertBody(t, f.get(t, RawPath(root, rel), nil), http.StatusOK, body)
		}
	})

	t.Run("a file scope serves the dotfile it names", func(t *testing.T) {
		env := f.issue(t, RawGrant{Origin: RawOriginFile, Scope: RawScopeFile, Path: ".env"})
		assertBody(t, f.get(t, RawPath(env, ".env"), nil), http.StatusOK, "SECRET=1")
	})

	t.Run("refuses a directory or the root itself", func(t *testing.T) {
		assertError(t, f.get(t, RawPath(root, "site"), nil), http.StatusBadRequest, CodeNotAFile)
		assertError(t, f.get(t, RawPathPrefix+root+"/", nil), http.StatusBadRequest, CodeInvalidPath)
		assertError(t, f.get(t, RawPathPrefix+root, nil), http.StatusBadRequest, CodeInvalidPath)
	})

	t.Run("refuses a symlink out of the project or to what it withholds", func(t *testing.T) {
		outside := filepath.Join(t.TempDir(), "outside.txt")
		writeFile(t, filepath.Dir(outside), "outside.txt", []byte("outside"))
		symlinktest.Make(t, filepath.Join("..", ".env"), filepath.Join(f.workDir, "site", "env"))
		symlinktest.Make(t, ".pockode", filepath.Join(f.workDir, "data"))
		symlinktest.Make(t, ".git", filepath.Join(f.workDir, "repo"))
		symlinktest.Make(t, filepath.Join("..", ".env.local"), filepath.Join(f.workDir, "site", "local.css"))
		writeFile(t, f.workDir, ".envrc", []byte("export SECRET=5"))
		symlinktest.Make(t, filepath.Join("..", ".envrc"), filepath.Join(f.workDir, "site", "envrc.js"))
		symlinktest.Make(t, outside, filepath.Join(f.workDir, "abs"))
		symlinktest.Make(t, filepath.Dir(outside), filepath.Join(f.workDir, "elsewhere"))
		symlinktest.Make(t, filepath.Join("..", "index.html"), filepath.Join(f.workDir, "site", "alias.html"))

		// A link inside the project to what the scope does not serve.
		assertError(t, f.get(t, RawPath(root, "site/env"), nil), http.StatusForbidden, CodeOutsideScope)
		assertError(t, f.get(t, RawPath(root, "data/sessions.json"), nil), http.StatusForbidden, CodeOutsideScope)
		assertError(t, f.get(t, RawPath(root, "repo/config"), nil), http.StatusForbidden, CodeOutsideScope)
		assertError(t, f.get(t, RawPath(root, "site/local.css"), nil), http.StatusForbidden, CodeOutsideScope)
		assertError(t, f.get(t, RawPath(root, "site/envrc.js"), nil), http.StatusForbidden, CodeOutsideScope)
		// Out of the project, directly or through a linked directory.
		assertError(t, f.get(t, RawPath(root, "abs"), nil), http.StatusForbidden, CodeOutsideScope)
		assertError(t, f.get(t, RawPath(root, "elsewhere/outside.txt"), nil), http.StatusForbidden, CodeOutsideScope)
		// A file scope is held to the project too.
		linkedFile := f.issue(t, RawGrant{Origin: RawOriginFile, Scope: RawScopeFile, Path: "abs"})
		assertError(t, f.get(t, RawPath(linkedFile, "abs"), nil), http.StatusForbidden, CodeOutsideScope)
		// A link that stays inside is just another name for a file there.
		assertBody(t, f.get(t, RawPath(root, "site/alias.html"), nil), http.StatusOK, "index")
	})
}

// A worktree's capability reads its own files only, even where the worktrees'
// base directory or Pockode's data directory is configured inside the main one
// under a name of its own.
func TestRawRootScopeWithholdsDataAndNestedWorktrees(t *testing.T) {
	f := newRawFixture(t)
	mainDir := f.workDir
	nested := filepath.Join(mainDir, "worktrees", "other")
	// A worktree whose directory is gone, as a prunable one is, withholds
	// nothing and refuses nothing.
	gone := filepath.Join(mainDir, "worktrees", "gone")
	f.h.files.resolver = resolver{dirs: map[string]string{"": mainDir, "other": nested, "gone": gone}}
	f.h.files.dataDir = filepath.Join(mainDir, "pockode-data")
	writeFile(t, mainDir, "index.html", []byte("main"))
	writeFile(t, mainDir, "worktrees/notes.txt", []byte("beside"))
	writeFile(t, mainDir, "pockode-data/sessions.json", []byte("{}"))
	writeFile(t, nested, "index.html", []byte("other"))
	main := f.issue(t, RawGrant{Origin: RawOriginFile, Scope: RawScopeRoot})

	t.Run("the main worktree's root reaches all but those", func(t *testing.T) {
		assertBody(t, f.get(t, RawPath(main, "index.html"), nil), http.StatusOK, "main")
		assertBody(t, f.get(t, RawPath(main, "worktrees/notes.txt"), nil), http.StatusOK, "beside")
		assertError(t, f.get(t, RawPath(main, "worktrees/other/index.html"), nil), http.StatusForbidden, CodeOutsideScope)
		assertError(t, f.get(t, RawPath(main, "pockode-data/sessions.json"), nil), http.StatusForbidden, CodeOutsideScope)
	})

	t.Run("the nested worktree's root reaches its own files", func(t *testing.T) {
		other := f.issue(t, RawGrant{Origin: RawOriginFile, Scope: RawScopeRoot, Worktree: "other"})
		assertBody(t, f.get(t, RawPath(other, "index.html"), nil), http.StatusOK, "other")
	})

	// Whichever spelling leads there: through a link in the project, or with
	// the worktree registered under another name for its directory, as a
	// case-insensitive file system gives one.
	t.Run("however the nested worktree is reached or named", func(t *testing.T) {
		symlinktest.Make(t, filepath.Join("worktrees", "other"), filepath.Join(mainDir, "linked"))
		assertError(t, f.get(t, RawPath(main, "linked/index.html"), nil), http.StatusForbidden, CodeOutsideScope)

		alias := filepath.Join(t.TempDir(), "alias")
		symlinktest.Make(t, nested, alias)
		f.h.files.resolver = resolver{dirs: map[string]string{"": mainDir, "other": alias}}
		assertError(t, f.get(t, RawPath(main, "worktrees/other/index.html"), nil), http.StatusForbidden, CodeOutsideScope)
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
	capability := f.issue(t, RawGrant{Origin: RawOriginCommit, Scope: RawScopeRoot, Hash: hash})

	t.Run("serves the committed bytes", func(t *testing.T) {
		assertBody(t, f.get(t, RawPath(capability, "site/clip.mp4"), nil), http.StatusOK, committed)
	})

	t.Run("answers a range", func(t *testing.T) {
		rec := f.get(t, RawPath(capability, "site/clip.mp4"), http.Header{"Range": {"bytes=996-"}})
		assertBody(t, rec, http.StatusPartialContent, "6789")
	})

	// A multi-range answer reads the blob out of order, which is the case that
	// has to run git again.
	t.Run("answers several ranges", func(t *testing.T) {
		rec := f.get(t, RawPath(capability, "site/clip.mp4"), http.Header{"Range": {"bytes=907-908,601-602"}})
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
		etag := f.get(t, RawPath(capability, "site/clip.mp4"), nil).Header().Get("ETag")
		if etag == "" {
			t.Fatal("no ETag")
		}
		rec := f.get(t, RawPath(capability, "site/clip.mp4"), http.Header{"If-None-Match": {etag}})
		if rec.Code != http.StatusNotModified {
			t.Errorf("status %d, want 304", rec.Code)
		}
	})

	t.Run("refuses what is not in the commit or the scope", func(t *testing.T) {
		assertError(t, f.get(t, RawPath(capability, "site/missing.mp4"), nil), http.StatusNotFound, CodeNotFound)
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

// rawPageContract is where the web's real-browser tests read what this server
// tells a page, so that the pages they run in real engines are held by this
// policy and report through this reporter, not a copy of them.
const rawPageContract = "../../web/src/test/page-hosts/raw-contract.json"

// TestRawPageContract keeps that file in step. After changing the policy or
// the reporter, rewrite it with UPDATE_RAW_PAGE_CONTRACT=1.
func TestRawPageContract(t *testing.T) {
	const capability, base, host = "CAPABILITY", "http://base.invalid", "allowed.invalid:1"
	contract := map[string]string{
		"sandbox":        rawSandbox,
		"capability":     capability,
		"base":           base,
		"host":           host,
		"policy":         pagePolicy(RawGrant{BaseURL: base}, capability, ""),
		"policyWithHost": pagePolicy(RawGrant{BaseURL: base, Hosts: []string{host}}, capability, ""),
		"reporter":       pageReporter(capability),
	}
	var buf bytes.Buffer
	encoder := json.NewEncoder(&buf)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "\t")
	if err := encoder.Encode(contract); err != nil {
		t.Fatal(err)
	}
	want := buf.Bytes()

	if os.Getenv("UPDATE_RAW_PAGE_CONTRACT") != "" {
		if err := os.WriteFile(rawPageContract, want, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	got, err := os.ReadFile(rawPageContract)
	if err != nil {
		t.Fatalf("read %s: %v", rawPageContract, err)
	}
	if string(got) != string(want) {
		t.Errorf("%s is out of step with this server; rewrite it with UPDATE_RAW_PAGE_CONTRACT=1 and run the web's browser tests:\n%s", rawPageContract, want)
	}
}

// A folder scope serves the archive DownloadFolder does, at the capability's
// own path and nowhere beneath it, with the raw endpoint's headers on it.
func TestRawFolderScope(t *testing.T) {
	f := newRawFixture(t)
	writeFile(t, f.workDir, "site/index.html", []byte("<p>"))
	writeFile(t, f.workDir, "site/.env", []byte("SECRET=1"))

	for _, path := range []string{"site", "site/", "./site"} {
		capability := f.issue(t, RawGrant{Origin: RawOriginFile, Scope: RawScopeFolder, Path: path})
		entry := RawEntryPath(capability, RawGrant{Scope: RawScopeFolder})
		if want := RawPathPrefix + capability + "/"; entry != want {
			t.Fatalf("entry path = %q, want %q", entry, want)
		}

		rec := f.get(t, entry, http.Header{"Range": {"bytes=0-0"}})
		if rec.Code != http.StatusOK {
			t.Fatalf("%q: status %d, want 200: %s", path, rec.Code, rec.Body.String())
		}
		if got := rec.Header().Get("Content-Disposition"); got != "attachment; filename=site.zip" {
			t.Errorf("%q: Content-Disposition = %q", path, got)
		}
		body := rec.Body.Bytes()
		zr, err := zip.NewReader(bytes.NewReader(body), int64(len(body)))
		if err != nil {
			t.Fatalf("%q: not a zip archive: %v", path, err)
		}
		var got []string
		for _, file := range zr.File {
			got = append(got, file.Name)
		}
		// What a root scope withholds from pages, the archive holds.
		if want := []string{"site/", "site/.env", "site/index.html"}; !slices.Equal(got, want) {
			t.Errorf("%q: archive holds %q, want %q", path, got, want)
		}

		rec = f.get(t, RawPath(capability, "index.html"), nil)
		if rec.Code != http.StatusForbidden {
			t.Errorf("%q: a path beneath the capability answered %d, want 403", path, rec.Code)
		}
	}

	t.Run("the work directory, named after it", func(t *testing.T) {
		capability := f.issue(t, RawGrant{Origin: RawOriginFile, Scope: RawScopeFolder})
		rec := f.get(t, RawPath(capability, ""), nil)
		want := "attachment; filename=" + filepath.Base(f.workDir) + ".zip"
		if got := rec.Header().Get("Content-Disposition"); rec.Code != http.StatusOK || got != want {
			t.Errorf("status %d, Content-Disposition %q, want 200 and %q", rec.Code, got, want)
		}
	})

	// Over a real connection, where headers flushed before the archive are
	// on the wire and cannot be added to afterwards. HEAD too: it writes
	// nothing, and the client checks the archive with it, cross-origin in a
	// dev build.
	for _, method := range []string{http.MethodGet, http.MethodHead} {
		t.Run("the archive's headers carry the sandbox on "+method, func(t *testing.T) {
			capability := f.issue(t, RawGrant{Origin: RawOriginFile, Scope: RawScopeFolder, Path: "site"})
			srv := httptest.NewServer(f.h)
			defer srv.Close()
			req, err := http.NewRequest(method, srv.URL+RawPath(capability, ""), nil)
			if err != nil {
				t.Fatalf("new request: %v", err)
			}
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatalf("%s: %v", method, err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				t.Fatalf("status %d, want 200", resp.StatusCode)
			}
			if got := resp.Header.Get("Content-Security-Policy"); !strings.HasPrefix(got, rawSandbox) {
				t.Errorf("Content-Security-Policy = %q, want the sandbox", got)
			}
			if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "*" {
				t.Errorf("Access-Control-Allow-Origin = %q", got)
			}
			if got := resp.Header.Get("Cache-Control"); got != "private, no-cache" {
				t.Errorf("Cache-Control = %q", got)
			}
		})
	}

	t.Run("a missing folder is a JSON error", func(t *testing.T) {
		capability := f.issue(t, RawGrant{Origin: RawOriginFile, Scope: RawScopeFolder, Path: "gone"})
		rec := f.get(t, RawPath(capability, ""), nil)
		if rec.Code != http.StatusNotFound {
			t.Fatalf("status %d, want 404: %s", rec.Code, rec.Body.String())
		}
		if got := decodeError(t, rec).Code; got != CodeNotFound {
			t.Errorf("code %q, want %q", got, CodeNotFound)
		}
	})
}
