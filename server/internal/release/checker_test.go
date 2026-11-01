package release

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type fakeSource struct {
	calls    atomic.Int32
	release  chan struct{} // when non-nil, each call blocks until it is closed
	resultMu sync.Mutex
	releases []Release
	err      error
}

func (s *fakeSource) Releases(ctx context.Context) ([]Release, error) {
	s.calls.Add(1)
	if s.release != nil {
		<-s.release
	}
	s.resultMu.Lock()
	defer s.resultMu.Unlock()
	return s.releases, s.err
}

func (s *fakeSource) set(releases []Release, err error) {
	s.resultMu.Lock()
	defer s.resultMu.Unlock()
	s.releases, s.err = releases, err
}

func newTestChecker(current string, src Source) (*Checker, *time.Time) {
	c := NewChecker(slog.New(slog.DiscardHandler), current, src)
	c.goos, c.goarch = "linux", "amd64"
	now := time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)
	c.now = func() time.Time { return now }
	return c, &now
}

func TestCheckerDevBuildNeverAsks(t *testing.T) {
	src := &fakeSource{releases: []Release{rel("v0.25.0")}}
	c, _ := newTestChecker("dev", src)

	st := c.Status(context.Background())
	if !errors.Is(st.Err, ErrDevBuild) || st.Candidates != nil {
		t.Fatalf("Status = %+v, want ErrDevBuild and no candidates", st)
	}
	if src.calls.Load() != 0 {
		t.Error("a dev build asked for releases")
	}
}

func TestCheckerStatusNeverAsks(t *testing.T) {
	src := &fakeSource{releases: []Release{rel("v0.25.0")}}
	c, now := newTestChecker("0.24.0", src)
	ctx := context.Background()

	if st := c.Status(ctx); st.Err != nil || st.Candidates != nil || !st.CheckedAt.IsZero() {
		t.Fatalf("Status before any check = %+v, want nothing known and no error", st)
	}
	*now = now.Add(24 * time.Hour)
	c.Status(ctx)
	if n := src.calls.Load(); n != 0 {
		t.Fatalf("Status asked the source %d times, want never", n)
	}

	c.Recheck(ctx)
	*now = now.Add(24 * time.Hour)
	st := c.Status(ctx)
	if n := src.calls.Load(); n != 1 || len(st.Candidates) != 1 {
		t.Fatalf("Status a day after a Recheck: %d calls, %+v; want the cached answer and no new ask", n, st)
	}
}

func TestCheckerRecheck(t *testing.T) {
	src := &fakeSource{releases: []Release{rel("v0.25.0")}}
	c, now := newTestChecker("0.24.0", src)
	ctx := context.Background()

	st := c.Recheck(ctx)
	if n := src.calls.Load(); n != 1 || st.Err != nil || len(st.Candidates) != 1 || st.Candidates[0].Version != "0.25.0" || !st.CheckedAt.Equal(*now) {
		t.Fatalf("first Recheck: %d calls, %+v", n, st)
	}
	checked := *now

	*now = now.Add(recheckInterval - time.Second)
	src.set([]Release{rel("v0.25.0"), rel("v0.26.0-alpha.1")}, nil)
	st = c.Recheck(ctx)
	if n := src.calls.Load(); n != 1 || len(st.Candidates) != 1 || !st.CheckedAt.Equal(checked) {
		t.Fatalf("Recheck within recheckInterval: %d calls, %+v; want the cached answer", n, st)
	}

	*now = now.Add(time.Second)
	st = c.Recheck(ctx)
	if n := src.calls.Load(); n != 2 || len(st.Candidates) != 2 || !st.CheckedAt.Equal(*now) {
		t.Fatalf("Recheck past recheckInterval: %d calls, %+v; want a fresh answer", n, st)
	}
	checked = *now

	// A failure is reported beside the last good answer, and is held to the
	// same interval: a client retrying an offline server is not a request per
	// retry.
	*now = now.Add(recheckInterval)
	src.set(nil, errors.New("offline"))
	st = c.Recheck(ctx)
	if st.Err == nil || len(st.Candidates) != 2 || !st.CheckedAt.Equal(checked) {
		t.Fatalf("after a failed check: %+v, want the error beside the last good answer", st)
	}
	*now = now.Add(recheckInterval - time.Second)
	c.Recheck(ctx)
	if n := src.calls.Load(); n != 3 {
		t.Fatalf("asked %d times, want a failed check to hold off the next for recheckInterval", n)
	}
}

func TestCheckerJoinsRunningCheck(t *testing.T) {
	src := &fakeSource{releases: []Release{rel("v0.25.0")}, release: make(chan struct{})}
	c, _ := newTestChecker("0.24.0", src)

	// A caller that gives up gets the answer as it stood; the check carries on.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if st := c.Recheck(ctx); st.Candidates != nil || !st.CheckedAt.IsZero() {
		t.Fatalf("Recheck before any answer = %+v", st)
	}

	// Both entry points wait for the check under way rather than answering
	// before it or starting another.
	var wg sync.WaitGroup
	var returned atomic.Int32
	results := make([]Status, 6)
	for i := range results {
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer returned.Add(1)
			if i%2 == 0 {
				results[i] = c.Status(context.Background())
			} else {
				results[i] = c.Recheck(context.Background())
			}
		}()
	}
	time.Sleep(20 * time.Millisecond)
	if n := returned.Load(); n != 0 {
		t.Errorf("%d callers returned before the running check answered", n)
	}
	close(src.release)
	wg.Wait()

	if n := src.calls.Load(); n != 1 {
		t.Errorf("source asked %d times, want once", n)
	}
	for i, st := range results {
		if len(st.Candidates) != 1 {
			t.Errorf("caller %d: %+v", i, st)
		}
	}
}
