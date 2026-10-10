// Package authguard slows down password guessing by locking out password
// attempts for a doubling interval once too many have failed.
//
// The counter is global rather than per client: there is a single credential,
// and on the relay path every request arrives from the local relay client, so
// the remote address says nothing about who is guessing. Session tokens and
// preview tickets must not go through a Guard — a device already logged in
// keeps working while someone else is locked out.
//
// State lives in memory only; restarting the server clears it, which is the
// owner's way out of a lockout they caused themselves.
package authguard

import (
	"log/slog"
	"strconv"
	"sync"
	"time"
)

const (
	// freeFailures are tolerated without delay, so a few typos never lock the
	// owner out.
	freeFailures = 5
	firstLockout = time.Second
	maxLockout   = 15 * time.Minute
	// idleReset forgets past failures once none has happened for this long.
	idleReset = time.Hour
)

// Guard counts failed password attempts. The zero value is not usable; call
// New. A Guard is safe for concurrent use.
type Guard struct {
	now func() time.Time

	stateMu     sync.Mutex
	failures    int
	lastFailure time.Time
	lockedUntil time.Time
}

func New() *Guard {
	return newWithClock(time.Now)
}

func newWithClock(now func() time.Time) *Guard {
	return &Guard{now: now}
}

// NewFrozen returns a Guard whose clock never moves, so a lockout it starts
// lasts as long as the test using it, however slowly a contended machine runs
// that test. It is for tests of the places that call Attempt; a real lockout
// would expire under them after a second.
func NewFrozen() *Guard {
	at := time.Now()
	return newWithClock(func() time.Time { return at })
}

// Attempt runs verify unless the guard is locked, and records its result.
//
// ok reports whether verify accepted the password. retryAfter is non-zero
// only when the attempt was refused because of a lockout: verify was not
// called — so even the correct password is refused — and retryAfter is how
// long remains. A wrong password returns (false, 0), including the one that
// starts a lockout; the next attempt learns of it.
//
// verify runs under the guard's lock so that concurrent attempts cannot all
// slip past the check before any of them is counted. It should be a plain
// comparison such as password.Matches.
func (g *Guard) Attempt(verify func() bool) (ok bool, retryAfter time.Duration) {
	g.stateMu.Lock()
	defer g.stateMu.Unlock()

	now := g.now()
	if remaining := g.lockedUntil.Sub(now); remaining > 0 {
		return false, remaining
	}
	if g.failures > 0 && now.Sub(g.lastFailure) >= idleReset {
		g.failures = 0
	}

	if verify() {
		g.failures = 0
		return true, 0
	}

	g.failures++
	g.lastFailure = now
	if lockout := lockoutAfter(g.failures); lockout > 0 {
		g.lockedUntil = now.Add(lockout)
		slog.Warn("too many failed password attempts, refusing passwords for a while",
			"failures", g.failures, "lockout", lockout)
	}
	return false, 0
}

// lockoutAfter is the lockout that the given number of consecutive failures
// earns: none for the free ones, then 1s, 2s, 4s… up to maxLockout.
func lockoutAfter(failures int) time.Duration {
	excess := failures - freeFailures
	if excess <= 0 {
		return 0
	}
	lockout := firstLockout
	for i := 1; i < excess && lockout < maxLockout; i++ {
		lockout *= 2
	}
	return min(lockout, maxLockout)
}

// RetryAfterSeconds is retryAfter as an HTTP Retry-After value: whole
// seconds, rounded up so a client that waits exactly that long is not refused
// again.
func RetryAfterSeconds(retryAfter time.Duration) string {
	return strconv.FormatInt(int64((retryAfter+time.Second-1)/time.Second), 10)
}
