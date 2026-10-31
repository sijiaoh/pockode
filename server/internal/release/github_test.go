package release

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"slices"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const apiBody = `[
  {"tag_name": "v0.26.0-alpha.1", "html_url": "https://github.com/sijiaoh/pockode/releases/tag/v0.26.0-alpha.1",
   "draft": false, "prerelease": true,
   "assets": [
     {"name": "pockode-linux-amd64", "state": "uploaded", "browser_download_url": "https://dl.test/a/pockode-linux-amd64"},
     {"name": "checksums.txt", "state": "starting", "browser_download_url": "https://dl.test/a/checksums.txt"}
   ]},
  {"tag_name": "v0.27.0", "html_url": "https://github.com/sijiaoh/pockode/releases/tag/v0.27.0", "draft": true, "assets": []},
  {"tag_name": "nightly", "html_url": "https://github.com/sijiaoh/pockode/releases/tag/nightly", "assets": []},
  {"tag_name": "v0.25.0", "html_url": "https://github.com/sijiaoh/pockode/releases/tag/v0.25.0",
   "draft": false, "prerelease": false,
   "assets": [
     {"name": "pockode-linux-amd64", "state": "uploaded", "browser_download_url": "https://dl.test/b/pockode-linux-amd64"},
     {"name": "checksums.txt", "state": "uploaded", "browser_download_url": "https://dl.test/b/checksums.txt"}
   ]}
]`

// The shape of github.com/<repo>/releases.atom, trimmed to what is read.
const atomBody = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en-US">
  <id>tag:github.com,2008:https://github.com/sijiaoh/pockode/releases</id>
  <link type="text/html" rel="alternate" href="https://github.com/sijiaoh/pockode/releases"/>
  <entry>
    <id>tag:github.com,2008:Repository/1/v0.26.0-alpha.1</id>
    <link rel="alternate" type="text/html" href="https://github.com/sijiaoh/pockode/releases/tag/v0.26.0-alpha.1"/>
    <title>v0.26.0-alpha.1</title>
  </entry>
  <entry>
    <id>tag:github.com,2008:Repository/1/v0.25.0</id>
    <link rel="alternate" type="text/html" href="https://github.com/sijiaoh/pockode/releases/tag/v0.25.0"/>
    <title>v0.25.0</title>
  </entry>
</feed>`

type fakeGitHub struct {
	api, atom       http.HandlerFunc
	apiHits         atomic.Int32
	atomHits        atomic.Int32
	lastIfNoneMatch atomic.Value
	lastUserAgent   atomic.Value
}

func newFakeGitHub(t *testing.T, f *fakeGitHub) *GitHub {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/api", func(w http.ResponseWriter, r *http.Request) {
		f.apiHits.Add(1)
		f.lastIfNoneMatch.Store(r.Header.Get("If-None-Match"))
		f.lastUserAgent.Store(r.Header.Get("User-Agent"))
		f.api(w, r)
	})
	mux.HandleFunc("/atom", func(w http.ResponseWriter, r *http.Request) {
		f.atomHits.Add(1)
		f.atom(w, r)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	g := NewGitHub("0.24.0")
	g.apiURL = srv.URL + "/api"
	g.atomURL = srv.URL + "/atom"
	return g
}

func serve(body string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(body)) }
}

func failWith(status int) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) { http.Error(w, "boom", status) }
}

func tags(releases []Release) string {
	var out []string
	for _, r := range releases {
		out = append(out, r.Tag)
	}
	return strings.Join(out, " ")
}

func TestGitHubAPI(t *testing.T) {
	f := &fakeGitHub{api: serve(apiBody), atom: failWith(http.StatusInternalServerError)}
	g := newFakeGitHub(t, f)

	releases, err := g.Releases(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got := tags(releases); got != "v0.26.0-alpha.1 v0.25.0" {
		t.Fatalf("releases = %q, want drafts and non-version tags left out", got)
	}
	if ua := f.lastUserAgent.Load(); ua != "pockode/0.24.0" {
		t.Errorf("User-Agent = %q", ua)
	}
	if a := releases[0]; !a.Prerelease || a.Version != "0.26.0-alpha.1" || !slices.Equal(a.Assets, []string{"pockode-linux-amd64"}) {
		t.Errorf("alpha = %+v, want a pre-release without the asset still uploading", a)
	}
	if r := releases[1]; r.Prerelease || !slices.Equal(r.Assets, []string{"pockode-linux-amd64", "checksums.txt"}) {
		t.Errorf("final = %+v", r)
	}
	if f.atomHits.Load() != 0 {
		t.Error("the feed was read although the API answered")
	}
}

func TestGitHubConditionalRequest(t *testing.T) {
	f := &fakeGitHub{atom: failWith(http.StatusInternalServerError)}
	f.api = func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("If-None-Match") == `"v1"` {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		w.Header().Set("ETag", `"v1"`)
		w.Write([]byte(apiBody))
	}
	g := newFakeGitHub(t, f)

	first, err := g.Releases(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	second, err := g.Releases(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if f.lastIfNoneMatch.Load() != `"v1"` {
		t.Errorf("second request If-None-Match = %q", f.lastIfNoneMatch.Load())
	}
	if tags(second) != tags(first) {
		t.Errorf("after 304: %q, want the cached %q", tags(second), tags(first))
	}
}

func TestGitHubFallsBackToAtom(t *testing.T) {
	f := &fakeGitHub{api: failWith(http.StatusBadGateway), atom: serve(atomBody)}
	g := newFakeGitHub(t, f)

	releases, err := g.Releases(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got := tags(releases); got != "v0.26.0-alpha.1 v0.25.0" {
		t.Fatalf("releases = %q", got)
	}
	for _, r := range releases {
		if r.Assets != nil {
			t.Errorf("%s: Assets = %v, want nil (the feed does not list them)", r.Tag, r.Assets)
		}
	}
	if !releases[0].Prerelease || releases[1].Prerelease {
		t.Errorf("pre-release taken from the tag: got %v, %v", releases[0].Prerelease, releases[1].Prerelease)
	}
}

func TestGitHubRateLimitSkipsAPIUntilReset(t *testing.T) {
	reset := time.Now().Add(30 * time.Minute).Truncate(time.Second)
	f := &fakeGitHub{atom: serve(atomBody)}
	f.api = func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-RateLimit-Remaining", "0")
		w.Header().Set("X-RateLimit-Reset", strconv.FormatInt(reset.Unix(), 10))
		http.Error(w, "rate limit exceeded", http.StatusForbidden)
	}
	g := newFakeGitHub(t, f)
	now := time.Now()
	g.now = func() time.Time { return now }

	for range 2 {
		if _, err := g.Releases(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if f.apiHits.Load() != 1 || f.atomHits.Load() != 2 {
		t.Fatalf("api hits %d, atom hits %d; want the API asked once and then skipped", f.apiHits.Load(), f.atomHits.Load())
	}

	now = reset
	g.Releases(context.Background())
	if f.apiHits.Load() != 2 {
		t.Errorf("API not asked again once the limit reset")
	}
}

func TestGitHubBothFail(t *testing.T) {
	f := &fakeGitHub{api: failWith(http.StatusBadGateway), atom: failWith(http.StatusServiceUnavailable)}
	g := newFakeGitHub(t, f)

	_, err := g.Releases(context.Background())
	if err == nil {
		t.Fatal("want an error")
	}
	for _, s := range []string{"502", "503"} {
		if !strings.Contains(err.Error(), s) {
			t.Errorf("error %q does not mention %s", err, s)
		}
	}
}

func TestGitHubRateLimitError(t *testing.T) {
	f := &fakeGitHub{atom: failWith(http.StatusServiceUnavailable)}
	f.api = func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "60")
		http.Error(w, "secondary rate limit", http.StatusTooManyRequests)
	}
	g := newFakeGitHub(t, f)

	_, err := g.Releases(context.Background())
	var rl *RateLimitError
	if !errors.As(err, &rl) {
		t.Fatalf("error %v is not a RateLimitError", err)
	}
	if d := time.Until(rl.Reset); d < 50*time.Second || d > 70*time.Second {
		t.Errorf("Reset in %s, want about 60s", d)
	}
}
