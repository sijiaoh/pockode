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

func TestCheckerCachesAndRetries(t *testing.T) {
	src := &fakeSource{releases: []Release{rel("v0.25.0")}}
	c, now := newTestChecker("0.24.0", src)
	ctx := context.Background()

	st := c.Status(ctx)
	if st.Err != nil || len(st.Candidates) != 1 || st.Candidates[0].Version != "0.25.0" || !st.CheckedAt.Equal(*now) {
		t.Fatalf("Status = %+v", st)
	}
	checked := *now

	*now = now.Add(checkInterval - time.Second)
	c.Status(ctx)
	if src.calls.Load() != 1 {
		t.Fatalf("asked %d times within checkInterval, want once", src.calls.Load())
	}

	*now = now.Add(time.Second)
	src.set(nil, errors.New("offline"))
	st = c.Status(ctx)
	if src.calls.Load() != 2 {
		t.Fatal("a stale answer was not refreshed")
	}
	if st.Err == nil || len(st.Candidates) != 1 || !st.CheckedAt.Equal(checked) {
		t.Fatalf("after a failed check: %+v, want the error beside the last good answer", st)
	}

	*now = now.Add(retryInterval - time.Second)
	c.Status(ctx)
	if src.calls.Load() != 2 {
		t.Fatal("retried before retryInterval")
	}
	*now = now.Add(time.Second)
	src.set([]Release{rel("v0.25.0"), rel("v0.26.0-alpha.1")}, nil)
	st = c.Status(ctx)
	if st.Err != nil || len(st.Candidates) != 2 {
		t.Fatalf("after recovering: %+v", st)
	}
}

func TestCheckerJoinsRunningCheck(t *testing.T) {
	src := &fakeSource{releases: []Release{rel("v0.25.0")}, release: make(chan struct{})}
	c, _ := newTestChecker("0.24.0", src)

	// A caller that gives up gets the answer as it stood; the check carries on.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if st := c.Status(ctx); st.Candidates != nil || !st.CheckedAt.IsZero() {
		t.Fatalf("Status before any answer = %+v", st)
	}

	var wg sync.WaitGroup
	results := make([]Status, 5)
	for i := range results {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results[i] = c.Status(context.Background())
		}()
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

func TestCheckerRecheck(t *testing.T) {
	src := &fakeSource{releases: []Release{rel("v0.25.0")}}
	c, now := newTestChecker("0.24.0", src)
	ctx := context.Background()

	c.Status(ctx)
	*now = now.Add(recheckInterval - time.Second)
	c.Recheck(ctx)
	if n := src.calls.Load(); n != 1 {
		t.Fatalf("asked %d times, want Recheck within recheckInterval of the last check to reuse it", n)
	}

	*now = now.Add(time.Second)
	src.set([]Release{rel("v0.25.0"), rel("v0.26.0-alpha.1")}, nil)
	st := c.Recheck(ctx)
	if n := src.calls.Load(); n != 2 || len(st.Candidates) != 2 || !st.CheckedAt.Equal(*now) {
		t.Fatalf("Recheck past recheckInterval: %d calls, %+v; want a fresh answer", n, st)
	}

	// The fresh answer is cached as any other.
	*now = now.Add(time.Second)
	c.Status(ctx)
	if n := src.calls.Load(); n != 2 {
		t.Errorf("Status right after a Recheck asked again (%d calls)", n)
	}
}
