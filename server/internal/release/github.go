package release

import (
	"context"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	// releasesURL lists published releases, pre-releases included, newest
	// created first. 100 is the most one page holds; a page is fetched at most
	// once an hour (see Checker), and asking for the most keeps the newest
	// final release on it even after a long run of alphas.
	releasesURL = "https://api.github.com/repos/" + Repo + "/releases?per_page=100"
	// atomURL is the fallback: it is served by github.com rather than the API,
	// so it does not draw on the API's rate limit, but it names only the
	// newest releases and none of their assets.
	atomURL = "https://github.com/" + Repo + "/releases.atom"

	// maxListBody bounds the API's answer. A release with generated notes and
	// seven assets is around 15 KB of JSON, so a full page is under 2 MB.
	maxListBody = 16 << 20
	maxAtomBody = 4 << 20
)

// Source lists published releases.
type Source interface {
	Releases(ctx context.Context) ([]Release, error)
}

// RateLimitError reports that the GitHub API refused to answer until Reset.
type RateLimitError struct {
	Reset time.Time
}

func (e *RateLimitError) Error() string {
	return fmt.Sprintf("GitHub API rate limit exceeded; resets at %s", e.Reset.Format(time.RFC3339))
}

// GitHub reads releases from the GitHub REST API, unauthenticated, and from
// the repository's releases.atom when the API fails.
//
// Unauthenticated requests share a budget of 60 an hour per IP address — with
// everything else on the machine and every other pockode behind the same NAT.
// What keeps this from eating it is Checker asking rarely. Requests after the
// first are conditional, which saves the body but not the budget: GitHub only
// exempts a 304 from the limit for authenticated requests. Once the API has
// said it is rate-limited, it is not asked again until the limit resets.
//
// Requests go through http.DefaultTransport, so HTTPS_PROXY, HTTP_PROXY and
// NO_PROXY apply as for any Go program.
type GitHub struct {
	client    *http.Client
	apiURL    string
	atomURL   string
	userAgent string
	now       func() time.Time

	apiMu        sync.Mutex
	etag         string
	cached       []Release // what etag validates
	blockedUntil time.Time
}

// NewGitHub returns the source for this repository's releases, for a binary
// reporting currentVersion. GitHub rejects API requests that carry no
// User-Agent.
func NewGitHub(currentVersion string) *GitHub {
	return &GitHub{
		// No Timeout of its own: every call is bounded by its ctx.
		client:    &http.Client{},
		apiURL:    releasesURL,
		atomURL:   atomURL,
		userAgent: "pockode/" + currentVersion,
		now:       time.Now,
	}
}

// Releases asks the API and, if that fails for any reason, the Atom feed. The
// error names both failures when neither answers.
func (g *GitHub) Releases(ctx context.Context) ([]Release, error) {
	releases, apiErr := g.fromAPI(ctx)
	if apiErr == nil {
		return releases, nil
	}
	releases, atomErr := g.fromAtom(ctx)
	if atomErr == nil {
		return releases, nil
	}
	return nil, fmt.Errorf("%w; falling back to %s: %w", apiErr, g.atomURL, atomErr)
}

func (g *GitHub) fromAPI(ctx context.Context) ([]Release, error) {
	g.apiMu.Lock()
	etag, cached, blockedUntil := g.etag, g.cached, g.blockedUntil
	g.apiMu.Unlock()
	if g.now().Before(blockedUntil) {
		return nil, &RateLimitError{Reset: blockedUntil}
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, g.apiURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	req.Header.Set("User-Agent", g.userAgent)
	if etag != "" {
		req.Header.Set("If-None-Match", etag)
	}

	resp, err := g.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("list releases: %w", err)
	}
	defer resp.Body.Close()

	switch resp.StatusCode {
	case http.StatusOK:
	case http.StatusNotModified:
		if cached != nil {
			return cached, nil
		}
		return nil, errors.New("list releases: 304 Not Modified without a cached answer")
	default:
		if reset, ok := rateLimitReset(resp, g.now()); ok {
			g.apiMu.Lock()
			g.blockedUntil = reset
			g.apiMu.Unlock()
			return nil, &RateLimitError{Reset: reset}
		}
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, fmt.Errorf("list releases: %s: %s", resp.Status, strings.TrimSpace(string(body)))
	}

	var payload []struct {
		TagName    string `json:"tag_name"`
		Draft      bool   `json:"draft"`
		Prerelease bool   `json:"prerelease"`
		Assets     []struct {
			Name  string `json:"name"`
			State string `json:"state"`
		} `json:"assets"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxListBody)).Decode(&payload); err != nil {
		return nil, fmt.Errorf("decode release list: %w", err)
	}
	releases := make([]Release, 0, len(payload))
	for _, p := range payload {
		v, ok := parseTag(p.TagName)
		if !ok || p.Draft {
			continue
		}
		r := Release{
			Tag:        p.TagName,
			Version:    v,
			Prerelease: p.Prerelease || isPrerelease(v),
			Assets:     []string{},
		}
		for _, a := range p.Assets {
			// An asset still being received is listed under its final name;
			// only "uploaded" means the file is all there.
			if a.State == "uploaded" {
				r.Assets = append(r.Assets, a.Name)
			}
		}
		releases = append(releases, r)
	}

	g.apiMu.Lock()
	g.etag = resp.Header.Get("ETag")
	g.cached = releases
	g.apiMu.Unlock()
	return releases, nil
}

// rateLimitReset recognises GitHub's two ways of saying "not now": a primary
// limit spent (403/429, x-ratelimit-remaining: 0, reset as a Unix time) and a
// secondary limit (retry-after in seconds).
//
// https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
func rateLimitReset(resp *http.Response, now time.Time) (time.Time, bool) {
	if resp.StatusCode != http.StatusForbidden && resp.StatusCode != http.StatusTooManyRequests {
		return time.Time{}, false
	}
	if s := resp.Header.Get("Retry-After"); s != "" {
		if secs, err := strconv.Atoi(s); err == nil {
			return now.Add(time.Duration(secs) * time.Second), true
		}
	}
	if resp.Header.Get("X-RateLimit-Remaining") == "0" {
		if unix, err := strconv.ParseInt(resp.Header.Get("X-RateLimit-Reset"), 10, 64); err == nil {
			return time.Unix(unix, 0), true
		}
	}
	return time.Time{}, false
}

// fromAtom reads releases.atom. Each entry's alternate link is the release
// page, ".../releases/tag/<tag>", which is where the tag is taken from. The
// feed says neither which releases are pre-releases nor what they carry, so
// Prerelease follows the tag and Assets stays nil.
func (g *GitHub) fromAtom(ctx context.Context) ([]Release, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, g.atomURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/atom+xml")
	req.Header.Set("User-Agent", g.userAgent)

	resp, err := g.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch release feed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("fetch release feed: %s", resp.Status)
	}

	var feed struct {
		Entries []struct {
			Links []struct {
				Rel  string `xml:"rel,attr"`
				Href string `xml:"href,attr"`
			} `xml:"link"`
		} `xml:"entry"`
	}
	if err := xml.NewDecoder(io.LimitReader(resp.Body, maxAtomBody)).Decode(&feed); err != nil {
		return nil, fmt.Errorf("decode release feed: %w", err)
	}
	var releases []Release
	for _, e := range feed.Entries {
		for _, l := range e.Links {
			if l.Rel != "" && l.Rel != "alternate" {
				continue
			}
			tag, ok := tagFromReleasePage(l.Href)
			if !ok {
				continue
			}
			v, ok := parseTag(tag)
			if !ok {
				continue
			}
			releases = append(releases, Release{Tag: tag, Version: v, Prerelease: isPrerelease(v)})
			break
		}
	}
	return releases, nil
}

func tagFromReleasePage(href string) (string, bool) {
	u, err := url.Parse(href)
	if err != nil {
		return "", false
	}
	dir, tag := path.Split(u.Path)
	if !strings.HasSuffix(dir, "/releases/tag/") || tag == "" {
		return "", false
	}
	return tag, true
}
