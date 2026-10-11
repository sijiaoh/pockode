package relay

import (
	"context"
	"errors"
	"slices"
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
		renew: func(context.Context) (*StoredConfig, error) {
			t.Error("renewed credentials after an ordinary connection failure")
			return nil, errors.New("unexpected renewal")
		},
	}, clock, ctx
}

// withinJitter reports whether d is base ± reconnectJitter.
func withinJitter(d, base time.Duration) bool {
	return d >= time.Duration(float64(base)*(1-reconnectJitter)) &&
		d <= time.Duration(float64(base)*(1+reconnectJitter))
}

// assertWaits checks that the loop waited once per entry of wantSeconds, each
// wait within jitter of that many seconds.
func assertWaits(t *testing.T, slept, wantSeconds []time.Duration) {
	t.Helper()
	if len(slept) != len(wantSeconds) {
		t.Fatalf("waited %d times, want %d: %v", len(slept), len(wantSeconds), slept)
	}
	for i, base := range wantSeconds {
		if !withinJitter(slept[i], base*time.Second) {
			t.Errorf("wait %d = %v, want %v ± %d%%", i+1, slept[i], base*time.Second, int(reconnectJitter*100))
		}
	}
}

// The loop must keep retrying for as long as it is running: the relay is this
// server's only route in from outside, so a client that stopped trying would be
// indistinguishable from one that had crashed.
func TestReconnectorBacksOffExponentiallyUpToACeiling(t *testing.T) {
	r, clock, ctx := newTestReconnector(t, 7)

	r.run(ctx, &StoredConfig{})

	want := []time.Duration{1, 2, 4, 8, 10, 10}
	assertWaits(t, clock.slept, want)
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

// A token the cloud no longer recognizes is rejected on every dial, so retrying
// it would go on forever. The loop has to get new credentials and dial with
// those.
func TestReconnectorRenewsCredentialsWhenTheTokenIsRejected(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)

	var dialedWith []string
	renewals := 0
	r := &reconnector{
		clock: &fakeClock{now: time.Unix(0, 0)},
		log:   testLogger(),
		connect: func(_ context.Context, cfg *StoredConfig) error {
			dialedWith = append(dialedWith, cfg.RelayToken)
			// Ends the loop on the renewed token, or after a few dials should the
			// loop never renew, so a regression fails instead of hanging.
			if cfg.RelayToken != "stale" || len(dialedWith) >= 3 {
				cancel()
			}
			return ErrInvalidToken
		},
		renew: func(context.Context) (*StoredConfig, error) {
			renewals++
			return &StoredConfig{RelayToken: "renewed"}, nil
		},
	}

	r.run(ctx, &StoredConfig{RelayToken: "stale"})

	if renewals != 1 {
		t.Errorf("renewed %d times, want 1", renewals)
	}
	if want := []string{"stale", "renewed"}; !slices.Equal(dialedWith, want) {
		t.Errorf("dialed with %v, want %v", dialedWith, want)
	}
}

// Should the cloud confirm a token its relay keeps rejecting, every renewal
// succeeds and every dial fails. A successful renewal must not reset the
// backoff, or that disagreement would become a tight loop of requests.
func TestReconnectorKeepsBackingOffWhenRenewedTokensAreRejected(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)

	clock := &fakeClock{now: time.Unix(0, 0)}
	dials := 0
	r := &reconnector{
		clock: clock,
		log:   testLogger(),
		connect: func(context.Context, *StoredConfig) error {
			dials++
			if dials >= 6 {
				cancel()
			}
			return ErrInvalidToken
		},
		renew: func(context.Context) (*StoredConfig, error) {
			return &StoredConfig{}, nil
		},
	}

	r.run(ctx, &StoredConfig{})

	want := []time.Duration{1, 2, 4, 8, 10}
	assertWaits(t, clock.slept, want)
}

// While renewal keeps failing the token is still known to be bad, so the loop
// must retry the renewal rather than dial with it: each such dial is one more
// rejection the cloud has to log. The retries back off like any other.
func TestReconnectorRetriesRenewalWithoutRedialingTheRejectedToken(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)

	clock := &fakeClock{now: time.Unix(0, 0)}
	dials := 0
	renewals := 0
	r := &reconnector{
		clock: clock,
		log:   testLogger(),
		connect: func(context.Context, *StoredConfig) error {
			dials++
			if dials >= 2 {
				cancel()
			}
			return ErrInvalidToken
		},
		renew: func(context.Context) (*StoredConfig, error) {
			renewals++
			if renewals < 3 {
				return nil, errors.New("cloud unreachable")
			}
			return &StoredConfig{}, nil
		},
	}

	r.run(ctx, &StoredConfig{})

	if dials != 2 {
		t.Errorf("dialed %d times, want 2 (once rejected, once renewed)", dials)
	}
	if renewals != 3 {
		t.Errorf("renewed %d times, want 3", renewals)
	}
	want := []time.Duration{1, 2, 4}
	assertWaits(t, clock.slept, want)
}

// A cloud that demands a newer client will refuse to register this one however
// often it asks, so retrying would only repeat the rejections.
func TestReconnectorStopsWhenRenewalRequiresAnUpgrade(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)

	attempts := 0
	// Ends a loop that failed to stop, so a regression fails instead of
	// hanging.
	attempt := func() {
		attempts++
		if attempts >= 5 {
			cancel()
		}
	}
	r := &reconnector{
		clock: &fakeClock{now: time.Unix(0, 0)},
		log:   testLogger(),
		connect: func(context.Context, *StoredConfig) error {
			attempt()
			return ErrInvalidToken
		},
		renew: func(context.Context) (*StoredConfig, error) {
			attempt()
			return nil, ErrUpgradeRequired
		},
	}

	r.run(ctx, &StoredConfig{})

	if attempts != 2 {
		t.Errorf("made %d attempts, want 2 (one dial, one renewal)", attempts)
	}
}
