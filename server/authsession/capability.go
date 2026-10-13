package authsession

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"sync"
	"time"
)

const (
	// CapabilityTTL is how long a capability stays usable. Long enough that a
	// video watched to the end or a page left open does not lose its next
	// request partway; the client issues a new one when a load fails, so a
	// shorter life would cost nothing but a re-issue, and a longer one is more
	// time for a URL that leaked — through history, a log, a shared screenshot
	// — to stay good.
	CapabilityTTL = 4 * time.Hour
	// maxCapabilities bounds the set authenticated clients can make the server
	// hold. It is one bound for all sessions: an app issues one per file or page
	// it shows, so every device together stays far below it within one TTL, and
	// a capability evicted early costs its holder only a re-issue.
	maxCapabilities = 256
)

// ErrSessionNotLive refuses to issue a capability for a session the store no
// longer holds: it would be dead on arrival.
var ErrSessionNotLive = errors.New("session is not live")

// Capabilities are bearer credentials for one thing each, carried where a
// header cannot be: in the URL a browser element loads by itself. G is what a
// capability grants; this package keeps it without looking at it.
//
// A capability is bound to the session that issued it and lives no longer
// than that session, so whatever ends a session — idling out, eviction, a
// changed password — ends its capabilities with it. Unlike a Ticket it is used
// any number of times until CapabilityTTL. As with sessions and tickets, only
// the SHA-256 of a capability is kept, and only in memory: a restart revokes
// every one.
//
// The zero value is not usable; use NewCapabilities.
type Capabilities[G any] struct {
	sessions *Store
	now      func() time.Time

	capabilitiesMu sync.Mutex
	// by capability hash
	capabilities map[string]capability[G]
}

type capability[G any] struct {
	session string // hash of the issuing session's token
	expiry  time.Time
	grant   G
}

func NewCapabilities[G any](sessions *Store) *Capabilities[G] {
	return &Capabilities[G]{
		sessions:     sessions,
		now:          time.Now,
		capabilities: make(map[string]capability[G]),
	}
}

// Issue returns a new capability granting grant for as long as sessionToken
// stays a live session, and the moment it expires even if the session does
// not. It is URL-safe, so it can be a path segment.
func (c *Capabilities[G]) Issue(sessionToken string, grant G) (string, time.Time, error) {
	session := hashToken(sessionToken)
	if sessionToken == "" || !c.sessions.live(session) {
		return "", time.Time{}, ErrSessionNotLive
	}

	b := make([]byte, tokenLen)
	if _, err := rand.Read(b); err != nil {
		return "", time.Time{}, err
	}
	token := base64.RawURLEncoding.EncodeToString(b)

	now := c.now()
	c.capabilitiesMu.Lock()
	defer c.capabilitiesMu.Unlock()

	c.pruneLocked(now)
	if len(c.capabilities) >= maxCapabilities {
		c.evictOldestLocked()
	}
	expiry := now.Add(CapabilityTTL)
	c.capabilities[hashToken(token)] = capability[G]{session: session, expiry: expiry, grant: grant}
	return token, expiry, nil
}

// Resolve returns what capability grants, and false if it was never issued,
// has expired, or its session has ended.
//
// The lookup is by hash rather than a constant-time comparison, as for
// Tickets.Redeem.
func (c *Capabilities[G]) Resolve(token string) (G, bool) {
	var zero G
	if token == "" {
		return zero, false
	}
	key := hashToken(token)
	now := c.now()

	c.capabilitiesMu.Lock()
	entry, ok := c.capabilities[key]
	if ok && !now.Before(entry.expiry) {
		delete(c.capabilities, key)
		ok = false
	}
	c.capabilitiesMu.Unlock()

	// Asked of the session store on every use rather than pushed from it when a
	// session ends: sessions end by idling out as much as by anything done to
	// them, and nothing fires when that happens.
	if !ok {
		return zero, false
	}
	if !c.sessions.live(entry.session) {
		c.capabilitiesMu.Lock()
		delete(c.capabilities, key)
		c.capabilitiesMu.Unlock()
		return zero, false
	}
	return entry.grant, true
}

// pruneLocked drops what can no longer resolve — expired, or of a session that
// has ended — so that dead capabilities never push a live one out at the cap.
func (c *Capabilities[G]) pruneLocked(now time.Time) {
	for key, entry := range c.capabilities {
		if !now.Before(entry.expiry) || !c.sessions.live(entry.session) {
			delete(c.capabilities, key)
		}
	}
}

// evictOldestLocked drops the capability closest to expiry, which, with one TTL
// for all of them, is the one issued first.
func (c *Capabilities[G]) evictOldestLocked() {
	var oldestKey string
	var oldest time.Time
	for key, entry := range c.capabilities {
		if oldestKey == "" || entry.expiry.Before(oldest) {
			oldestKey, oldest = key, entry.expiry
		}
	}
	delete(c.capabilities, oldestKey)
}
