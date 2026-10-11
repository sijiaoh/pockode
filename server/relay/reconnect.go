package relay

import (
	"context"
	"errors"
	"log/slog"
	"math/rand/v2"
	"time"
)

const (
	reconnectInitialBackoff = time.Second

	// reconnectMaxBackoff is deliberately well under the cloud relay's grace
	// period for a disconnected tunnel (30 s). A reconnect landing inside that
	// window reclaims the subdomain's entry, so public requests waiting in the
	// gap get served instead of answered 503. Raising this past the grace
	// period would forfeit that; the two values must move together.
	reconnectMaxBackoff = 10 * time.Second

	// reconnectJitter spreads each wait by ±20%. Without it every pockode that
	// was connected to a cloud instance restarts its backoff at the same
	// instant and they retry in lockstep, arriving as one burst on a server
	// that has only just come back up.
	reconnectJitter = 0.2

	// stableConnection is how long an uplink must have lasted for its failure to
	// count as a new problem rather than a continuing one, so that a server
	// which ran for hours and then dropped retries at once instead of
	// inheriting a backoff earned by some earlier outage.
	stableConnection = time.Minute
)

// clock is the reconnect loop's only contact with real time, so tests can drive
// many backoff rounds without spending any.
type clock interface {
	Now() time.Time
	// Sleep waits for d, or until ctx ends — whichever comes first, so that a
	// shutdown is not held up by a backoff that was already scheduled. It
	// reports nothing: the loop's own condition sees the ended context.
	Sleep(ctx context.Context, d time.Duration)
}

type realClock struct{}

func (realClock) Now() time.Time { return time.Now() }

func (realClock) Sleep(ctx context.Context, d time.Duration) {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-timer.C:
	case <-ctx.Done():
	}
}

// reconnector keeps the uplink up for as long as its context lives, retrying
// with exponential backoff whenever the connection drops. It never gives up on
// a dropped connection: the relay is this server's only route in from the
// outside, so a client that stopped trying would be indistinguishable from one
// that had crashed.
//
// A rejected token is different: dialing again with it can only be rejected
// again, so the loop renews the credentials instead and dials again only once
// that succeeds. The one thing it gives up on is a cloud that demands a newer
// client, which no number of retries from this binary can satisfy.
//
// connect, renew and clock are fields rather than direct calls so tests can
// fail the uplink and its renewal on demand and observe the resulting delays.
type reconnector struct {
	connect func(context.Context, *StoredConfig) error
	renew   func(context.Context) (*StoredConfig, error)
	clock   clock
	log     *slog.Logger
}

func (r *reconnector) run(ctx context.Context, cfg *StoredConfig) {
	backoff := reconnectInitialBackoff
	nextDelay := func() time.Duration {
		d := withJitter(backoff)
		backoff = min(backoff*2, reconnectMaxBackoff)
		return d
	}
	renewing := false

	for ctx.Err() == nil {
		if renewing {
			renewed, err := r.renew(ctx)
			if ctx.Err() != nil {
				return
			}
			if errors.Is(err, ErrUpgradeRequired) {
				r.log.Error("relay stopped: relay token rejected and the cloud requires a newer Pockode to register again", "error", err)
				return
			}
			// Success leaves the backoff where it is, so that a cloud which
			// confirms a token its relay keeps rejecting is still asked at the
			// backoff's pace rather than in a tight loop.
			if err == nil {
				cfg = renewed
				renewing = false
				continue
			}
			delay := nextDelay()
			r.log.Error("failed to renew relay credentials", "error", err, "retry_in", delay)
			r.clock.Sleep(ctx, delay)
			continue
		}

		start := r.clock.Now()
		err := r.connect(ctx, cfg)
		if ctx.Err() != nil {
			return
		}
		renewing = errors.Is(err, ErrInvalidToken)

		var delay time.Duration
		if r.clock.Now().Sub(start) >= stableConnection {
			backoff = reconnectInitialBackoff
		} else {
			delay = nextDelay()
		}

		r.log.Error("relay connection failed", "error", err, "retry_in", delay)
		if delay > 0 {
			r.clock.Sleep(ctx, delay)
		}
	}
}

func withJitter(d time.Duration) time.Duration {
	return d + time.Duration(float64(d)*reconnectJitter*(2*rand.Float64()-1))
}
