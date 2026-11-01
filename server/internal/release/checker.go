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
	// checkInterval is how long a successful answer is trusted. Releases come
	// days apart, so an hour costs nothing in freshness, and it keeps even a
	// dozen pockode processes behind one address well inside GitHub's 60
	// unauthenticated API requests an hour.
	checkInterval = time.Hour
	// retryInterval is the wait after a failed check: shorter than
	// checkInterval because most failures (no network yet, a timeout) clear up
	// on their own, long enough that a client polling an offline server does
	// not turn into a request per poll.
	retryInterval = 5 * time.Minute
	// recheckInterval is the least time between two checks Recheck starts:
	// a user pressing "Check again" repeatedly, or from several devices, must
	// not spend the address's 60 API requests an hour.
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
	// succeeded. Zero with no Err means the first check has not finished yet,
	// which is not the same as there being nothing to update to.
	CheckedAt time.Time
	// Err is why the most recent check failed, or ErrDevBuild.
	Err error
}

// Checker answers Status, asking its Source at most once per checkInterval
// however many clients ask it. It checks lazily — only when asked, and only
// when the last answer is stale — so a server nobody opens costs GitHub
// nothing.
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
	nextCheck time.Time
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

// Status returns the current answer, first refreshing it if it is stale. A
// refresh already under way is joined rather than repeated. If ctx ends before
// the refresh does, the answer as it stood is returned and the refresh carries
// on for the next caller.
func (c *Checker) Status(ctx context.Context) Status {
	return c.status(ctx, false)
}

// Recheck is Status for a user asking to look now: the cached answer counts as
// stale, unless a check started less than recheckInterval ago, whose answer is
// returned instead.
func (c *Checker) Recheck(ctx context.Context) Status {
	return c.status(ctx, true)
}

func (c *Checker) status(ctx context.Context, force bool) Status {
	if !c.isRelease {
		return Status{Err: ErrDevBuild}
	}
	if done := c.startCheckIfDue(force); done != nil {
		select {
		case <-done:
		case <-ctx.Done():
		}
	}
	return c.snapshot()
}

func (c *Checker) startCheckIfDue(force bool) <-chan struct{} {
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	now := c.now()
	due := !now.Before(c.nextCheck) || (force && !now.Before(c.lastStart.Add(recheckInterval)))
	if c.inflight == nil && due {
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
	now := c.now()
	if err == nil {
		c.releases = releases
		c.checkedAt = now
		c.lastErr = nil
		c.nextCheck = now.Add(checkInterval)
		return
	}
	c.lastErr = err
	c.nextCheck = now.Add(retryInterval)
	c.log.Warn("checking for new pockode releases failed",
		"error", err, "nextAttempt", c.nextCheck.Format(time.RFC3339))
}

func (c *Checker) snapshot() Status {
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	// current was validated in NewChecker, the only way pick fails.
	candidates, _ := pick(c.current, c.releases, c.goos, c.goarch)
	return Status{Candidates: candidates, Latest: latestVersion(c.releases), CheckedAt: c.checkedAt, Err: c.lastErr}
}
