package authguard

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type fakeClock struct{ now time.Time }

func (c *fakeClock) Now() time.Time          { return c.now }
func (c *fakeClock) Advance(d time.Duration) { c.now = c.now.Add(d) }

func newTestGuard() (*Guard, *fakeClock) {
	clock := &fakeClock{now: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
	return newWithClock(clock.Now), clock
}

func right() bool { return true }
func wrong() bool { return false }

func TestAttempt_BackoffCurve(t *testing.T) {
	g, clock := newTestGuard()

	want := []time.Duration{
		0, 0, 0, 0, 0,
		1 * time.Second, 2 * time.Second, 4 * time.Second, 8 * time.Second,
		16 * time.Second, 32 * time.Second, 64 * time.Second, 128 * time.Second,
		256 * time.Second, 512 * time.Second,
		15 * time.Minute, 15 * time.Minute, 15 * time.Minute,
	}
	for i, w := range want {
		ok, retryAfter := g.Attempt(wrong)
		if ok || retryAfter != 0 {
			t.Fatalf("failure %d: got (%v, %v), want (false, 0)", i+1, ok, retryAfter)
		}
		if w == 0 {
			continue
		}
		_, got := g.Attempt(func() bool {
			t.Fatalf("failure %d: verify called while locked", i+1)
			return false
		})
		if got != w {
			t.Fatalf("failure %d: lockout %v, want %v", i+1, got, w)
		}
		clock.Advance(got)
	}
}

func TestAttempt_CorrectPasswordRefusedWhileLocked(t *testing.T) {
	g, clock := newTestGuard()
	for range freeFailures + 1 {
		g.Attempt(wrong)
	}

	called := false
	ok, retryAfter := g.Attempt(func() bool { called = true; return true })
	if ok || called || retryAfter != time.Second {
		t.Fatalf("locked: got ok=%v called=%v retryAfter=%v, want false/false/1s", ok, called, retryAfter)
	}

	clock.Advance(400 * time.Millisecond)
	if _, retryAfter := g.Attempt(right); retryAfter != 600*time.Millisecond {
		t.Fatalf("retryAfter = %v, want the 600ms that remain", retryAfter)
	}

	clock.Advance(600 * time.Millisecond)
	if ok, retryAfter := g.Attempt(right); !ok || retryAfter != 0 {
		t.Fatalf("after lockout: got (%v, %v), want (true, 0)", ok, retryAfter)
	}
}

func TestAttempt_Reset(t *testing.T) {
	tests := []struct {
		name  string
		reset func(*testing.T, *Guard, *fakeClock)
	}{
		{
			name: "successful login",
			reset: func(t *testing.T, g *Guard, _ *fakeClock) {
				if ok, _ := g.Attempt(right); !ok {
					t.Fatal("correct password refused")
				}
			},
		},
		{
			name:  "an hour without failures",
			reset: func(_ *testing.T, _ *Guard, c *fakeClock) { c.Advance(time.Hour) },
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			g, clock := newTestGuard()
			for range freeFailures {
				g.Attempt(wrong)
			}
			tt.reset(t, g, clock)

			// Back to a full allowance of free failures.
			for i := range freeFailures {
				if _, retryAfter := g.Attempt(wrong); retryAfter != 0 {
					t.Fatalf("failure %d after reset refused: %v", i+1, retryAfter)
				}
			}
			if _, retryAfter := g.Attempt(right); retryAfter != 0 {
				t.Fatalf("locked after %d failures following a reset: %v", freeFailures, retryAfter)
			}
		})
	}
}

func TestAttempt_FailuresWithinTheHourAccumulate(t *testing.T) {
	g, clock := newTestGuard()
	for range freeFailures {
		g.Attempt(wrong)
		clock.Advance(59 * time.Minute)
	}
	g.Attempt(wrong)
	if _, retryAfter := g.Attempt(right); retryAfter != time.Second {
		t.Fatalf("retryAfter = %v, want 1s: failures less than an hour apart must not reset", retryAfter)
	}
}

func TestAttempt_ConcurrentGuessesCannotOutrunTheLockout(t *testing.T) {
	g, _ := newTestGuard()
	var verified atomic.Int32
	var wg sync.WaitGroup
	for range 50 {
		wg.Go(func() {
			g.Attempt(func() bool { verified.Add(1); return false })
		})
	}
	wg.Wait()

	if got := verified.Load(); got != freeFailures+1 {
		t.Fatalf("verify ran %d times, want %d: the lockout must stop guesses already in flight", got, freeFailures+1)
	}
}

// A client that waits exactly Retry-After must find the lockout over, so any
// fraction of a second left counts as a whole one.
func TestRetryAfterSeconds_RoundsUp(t *testing.T) {
	tests := []struct {
		retryAfter time.Duration
		want       string
	}{
		{time.Nanosecond, "1"},
		{time.Second, "1"},
		{time.Second + time.Nanosecond, "2"},
		{maxLockout, "900"},
	}
	for _, tt := range tests {
		if got := RetryAfterSeconds(tt.retryAfter); got != tt.want {
			t.Errorf("RetryAfterSeconds(%v) = %q, want %q", tt.retryAfter, got, tt.want)
		}
	}
}
