package authsession

import (
	"crypto/rand"
	"encoding/base64"
	"sync"
	"time"
)

const (
	// TicketTTL is how long a ticket waits to be redeemed. It only has to cover
	// the app opening a new tab and that tab's first request reaching the
	// preview host; anything longer is time for a leaked ticket to be used.
	TicketTTL = 60 * time.Second
	// maxTickets bounds the set an authenticated client can make the server
	// hold by asking for tickets it never redeems. A real app holds one or two
	// at a time, so evicting the oldest costs nobody a ticket they meant to use.
	maxTickets = 64
)

// Tickets are one-time login tickets: a logged-in app hands one to a browser
// tab that is not logged in (a port preview host, a different origin with its
// own cookie), which exchanges it for a session of its own without the
// password being typed again.
//
// A ticket is redeemable once, for TicketTTL, and only by the process that
// issued it: the set is held in memory, so a restart spends every outstanding
// ticket, and the tab falls back to the password. As with sessions, only the
// SHA-256 of a ticket is kept.
//
// The zero value is not usable; use NewTickets.
type Tickets struct {
	now func() time.Time

	ticketsMu sync.Mutex
	// expiry by ticket hash
	tickets map[string]time.Time
}

func NewTickets() *Tickets {
	return &Tickets{now: time.Now, tickets: make(map[string]time.Time)}
}

// Issue returns a new ticket. It is URL-safe, so it can travel in a query
// string.
func (t *Tickets) Issue() (string, error) {
	b := make([]byte, tokenLen)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	ticket := base64.RawURLEncoding.EncodeToString(b)

	now := t.now()
	t.ticketsMu.Lock()
	defer t.ticketsMu.Unlock()

	t.pruneLocked(now)
	if len(t.tickets) >= maxTickets {
		t.evictOldestLocked()
	}
	t.tickets[hashToken(ticket)] = now.Add(TicketTTL)
	return ticket, nil
}

// Redeem reports whether ticket is live, and spends it either way: a second
// Redeem of the same ticket is false. The caller issues whatever the ticket
// stands for only on true.
//
// The lookup is by hash rather than a constant-time comparison: the map key is
// a SHA-256 of the input, which an attacker cannot steer toward a stored one.
func (t *Tickets) Redeem(ticket string) bool {
	if ticket == "" {
		return false
	}
	key := hashToken(ticket)
	now := t.now()

	t.ticketsMu.Lock()
	defer t.ticketsMu.Unlock()

	expiry, ok := t.tickets[key]
	if !ok {
		return false
	}
	delete(t.tickets, key)
	return now.Before(expiry)
}

func (t *Tickets) pruneLocked(now time.Time) {
	for key, expiry := range t.tickets {
		if !now.Before(expiry) {
			delete(t.tickets, key)
		}
	}
}

// evictOldestLocked drops the ticket closest to expiry, which, with one TTL for
// all of them, is the one issued first.
func (t *Tickets) evictOldestLocked() {
	var oldestKey string
	var oldest time.Time
	for key, expiry := range t.tickets {
		if oldestKey == "" || expiry.Before(oldest) {
			oldestKey, oldest = key, expiry
		}
	}
	delete(t.tickets, oldestKey)
}
