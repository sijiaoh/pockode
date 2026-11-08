package release

import (
	"context"
	"errors"
	"log/slog"
	"runtime"
	"sync"
	"time"
)

const (
	// recheckInterval is the least time between two checks: a user pressing
	// "Check again" repeatedly, or from several devices, must not spend the
	// address's 60 unauthenticated GitHub API requests an hour. Several
	// pockode processes behind one address share that budget too, which holds
	// because none of them checks unless a user asks it to.
	recheckInterval = time.Minute
	// fetchTimeout bounds one check. The check runs detached from whichever
	// caller started it, so this is the only thing that ends a stuck one.
	fetchTimeout = 20 * time.Second
)

// ErrDevBuild is Status.Err for a binary whose version is not a release
// version — "dev", what a build without -X main.version reports. Such a build
// is never offered anything and never asks GitHub: it was built from a source
// tree that may well be ahead of every release, so "newer than dev" would
// offer a downgrade as readily as an update, and it cannot be updated from the
// UI anyway. Not asking also keeps a developer's restarts from spending the
// address's shared rate limit.
var ErrDevBuild = errors.New("this is a development build, which is not updated from releases")

// Status is what a client needs to offer updates.
type Status struct {
	// Candidates holds the latest candidate, then the alpha one, each only if
	// it is newer than the running version. It reflects the most recent
	// successful check, even when Err says a later one failed.
	Candidates []Candidate
	// Latest is the version of the newest final release, whether or not it
	// is a candidate: what an alpha candidate is a pre-release beside.
	// Empty when there is none, or no check has succeeded.
	Latest string
	// CheckedAt is when Candidates was last confirmed; zero until a check has
	// succeeded. Zero with no Err means this process has not checked yet —
	// nobody has asked it to, or the first check has not finished — which is
	// not the same as there being nothing to update to.
	CheckedAt time.Time
	// Err is why the most recent check failed, or ErrDevBuild.
	Err error
}

// Checker answers Status from what this process last learned, and asks its
// Source only when a user asks it to look (Recheck), at most once per
// recheckInterval however many clients ask. It never looks on its own: a
// server nobody checks costs GitHub nothing, and opening a client is not
// asking to check.
type Checker struct {
	current      string
	isRelease    bool
	source       Source
	goos, goarch string
	log          *slog.Logger
	now          func() time.Time

	stateMu   sync.Mutex
	releases  []Release
	checkedAt time.Time
	lastErr   error
	lastStart time.Time
	inflight  chan struct{} // closed when the running check finishes
}

// NewChecker returns a Checker for this binary, which reports currentVersion
// (no leading "v").
func NewChecker(log *slog.Logger, currentVersion string, source Source) *Checker {
	return &Checker{
		current:   currentVersion,
		isRelease: IsRelease(currentVersion),
		source:    source,
		goos:      runtime.GOOS,
		goarch:    runtime.GOARCH,
		log:       log,
		now:       time.Now,
	}
}

// Status returns the answer as this process knows it, never starting a check.
// A check already under way is joined, so that a caller arriving during
// another's Recheck gets its answer. If ctx ends first, the answer as it stood
// is returned and the check carries on.
func (c *Checker) Status(ctx context.Context) Status {
	return c.status(ctx, false)
}

// Recheck is Status for a user asking to look now: it starts a check, unless
// one started less than recheckInterval ago, whose answer is returned (joined
// if it is still running) instead.
func (c *Checker) Recheck(ctx context.Context) Status {
	return c.status(ctx, true)
}

func (c *Checker) status(ctx context.Context, force bool) Status {
	if !c.isRelease {
		return Status{Err: ErrDevBuild}
	}
	if done := c.running(force); done != nil {
		select {
		case <-done:
		case <-ctx.Done():
		}
	}
	return c.snapshot()
}

// running returns the check under way, if any, first starting one when start
// is set and no check has started within recheckInterval.
func (c *Checker) running(start bool) <-chan struct{} {
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	now := c.now()
	if start && c.inflight == nil && !now.Before(c.lastStart.Add(recheckInterval)) {
		c.lastStart = now
		c.inflight = make(chan struct{})
		go c.check(c.inflight)
	}
	return c.inflight
}

func (c *Checker) check(done chan struct{}) {
	ctx, cancel := context.WithTimeout(context.Background(), fetchTimeout)
	defer cancel()
	releases, err := c.source.Releases(ctx)

	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	defer close(done)
	c.inflight = nil
	if err == nil {
		c.releases = releases
		c.checkedAt = c.now()
		c.lastErr = nil
		return
	}
	c.lastErr = err
	c.log.Warn("checking for new pockode releases failed", "error", err)
}

func (c *Checker) snapshot() Status {
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	// current was validated in NewChecker, the only way pick fails.
	candidates, _ := pick(c.current, c.releases, c.goos, c.goarch)
	return Status{Candidates: candidates, Latest: latestVersion(c.releases), CheckedAt: c.checkedAt, Err: c.lastErr}
}
