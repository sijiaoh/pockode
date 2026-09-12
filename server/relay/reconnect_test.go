package relay

import (
	"context"
	"errors"
	"testing"
	"time"
)

// fakeClock advances only when the loop waits, so a test can run any number of
// backoff rounds in no time and read back exactly what was waited.
type fakeClock struct {
	now         time.Time
	slept       []time.Duration
	beforeSleep func()
}

func (c *fakeClock) Now() time.Time { return c.now }

func (c *fakeClock) Sleep(_ context.Context, d time.Duration) {
	c.slept = append(c.slept, d)
	c.now = c.now.Add(d)
	if c.beforeSleep != nil {
		c.beforeSleep()
	}
}

// newTestReconnector wires a reconnector whose uplink fails immediately, giving
// up the loop once it has retried stopAfter times. It returns the clock, which
// holds the waits the loop asked for.
func newTestReconnector(t *testing.T, stopAfter int) (*reconnector, *fakeClock, context.Context) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)

	clock := &fakeClock{now: time.Unix(0, 0)}
	attempts := 0
	return &reconnector{
		clock: clock,
		log:   testLogger(),
		connect: func(context.Context, *StoredConfig) error {
			attempts++
			if attempts >= stopAfter {
				cancel()
			}
			return errors.New("uplink refused")
		},
	}, clock, ctx
}

// withinJitter reports whether d is base ± reconnectJitter.
func withinJitter(d, base time.Duration) bool {
	return d >= time.Duration(float64(base)*(1-reconnectJitter)) &&
		d <= time.Duration(float64(base)*(1+reconnectJitter))
}

// The loop must keep retrying for as long as it is running: the relay is this
// server's only route in from outside, so a client that stopped trying would be
// indistinguishable from one that had crashed.
func TestReconnectorBacksOffExponentiallyUpToACeiling(t *testing.T) {
	r, clock, ctx := newTestReconnector(t, 7)

	r.run(ctx, &StoredConfig{})

	want := []time.Duration{1, 2, 4, 8, 10, 10}
	if len(clock.slept) != len(want) {
		t.Fatalf("waited %d times, want %d: %v", len(clock.slept), len(want), clock.slept)
	}
	for i, base := range want {
		if !withinJitter(clock.slept[i], base*time.Second) {
			t.Errorf("wait %d = %v, want %v ± %d%%", i+1, clock.slept[i], base*time.Second, int(reconnectJitter*100))
		}
	}
}

// Every pockode connected to a restarting cloud starts its backoff at the same
// instant. Without jitter they retry in lockstep and land as one burst on a
// server that has only just come back up.
func TestReconnectorJittersEachWait(t *testing.T) {
	// Long enough to be pinned at the ceiling, where an unjittered
	// implementation would produce an identical wait every time.
	r, clock, ctx := newTestReconnector(t, 20)

	r.run(ctx, &StoredConfig{})

	atCeiling := clock.slept[len(clock.slept)-10:]
	for _, d := range atCeiling {
		if d != atCeiling[0] {
			return
		}
	}
	t.Errorf("every wait at the ceiling was exactly %v, want jitter", atCeiling[0])
}

// A tunnel that ran for hours and then dropped is a new problem, not a
// continuing one. Inheriting the old backoff would make a long-lived server
// wait ten seconds for its first retry.
func TestReconnectorResetsBackoffAfterAStableConnection(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)

	clock := &fakeClock{now: time.Unix(0, 0)}
	attempts := 0
	r := &reconnector{
		clock: clock,
		log:   testLogger(),
		connect: func(context.Context, *StoredConfig) error {
			attempts++
			switch attempts {
			case 1, 2, 3:
				// Fail fast, so the backoff climbs to 4 s.
			case 4:
				clock.now = clock.now.Add(stableConnection)
			case 5:
				// Fails fast again, now on the reset budget.
			default:
				cancel()
			}
			return errors.New("uplink refused")
		},
	}

	r.run(ctx, &StoredConfig{})

	// Three climbing waits, then the stable connection retries with no wait at
	// all, then the budget starts over.
	if len(clock.slept) != 4 {
		t.Fatalf("waited %d times, want 4: %v", len(clock.slept), clock.slept)
	}
	if !withinJitter(clock.slept[3], reconnectInitialBackoff) {
		t.Errorf("wait after a stable connection = %v, want %v ± %d%%",
			clock.slept[3], reconnectInitialBackoff, int(reconnectJitter*100))
	}
}

// Shutdown must not be held up by a backoff that was already scheduled.
func TestReconnectorStopsWithoutWaitingWhenShuttingDown(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	clock := &fakeClock{now: time.Unix(0, 0)}
	r := &reconnector{
		clock: clock,
		log:   testLogger(),
		connect: func(context.Context, *StoredConfig) error {
			cancel()
			return errors.New("uplink refused")
		},
	}

	r.run(ctx, &StoredConfig{})

	if len(clock.slept) != 0 {
		t.Errorf("waited %v while shutting down, want no wait", clock.slept)
	}
}

// The loop condition, not the wait, is what ends the loop: a shutdown during a
// backoff must not be followed by one more connection attempt.
func TestReconnectorStopsWhileWaitingToRetry(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	clock := &fakeClock{now: time.Unix(0, 0), beforeSleep: cancel}
	attempts := 0
	r := &reconnector{
		clock: clock,
		log:   testLogger(),
		connect: func(context.Context, *StoredConfig) error {
			attempts++
			return errors.New("uplink refused")
		},
	}

	r.run(ctx, &StoredConfig{})

	if attempts != 1 {
		t.Errorf("attempted %d connections, want 1 (the wait was interrupted)", attempts)
	}
}
