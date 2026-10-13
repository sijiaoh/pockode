package authsession

import (
	"errors"
	"testing"
	"time"
)

func newCapabilities(t *testing.T) (*Capabilities[string], *Store, string) {
	t.Helper()
	s := newStore(t, t.TempDir(), "hunter2")
	session, err := s.Issue()
	if err != nil {
		t.Fatalf("Issue session: %v", err)
	}
	return NewCapabilities[string](s), s, session
}

func issueCapability(t *testing.T, c *Capabilities[string], session, grant string) string {
	t.Helper()
	token, _, err := c.Issue(session, grant)
	if err != nil {
		t.Fatalf("Issue capability: %v", err)
	}
	return token
}

func TestCapabilityResolvesToItsGrantUntilExpiry(t *testing.T) {
	c, _, session := newCapabilities(t)
	issuedAt := time.Now()
	c.now = func() time.Time { return issuedAt }
	token, expiry, err := c.Issue(session, "docs/")
	if err != nil {
		t.Fatalf("Issue capability: %v", err)
	}
	if want := issuedAt.Add(CapabilityTTL); !expiry.Equal(want) {
		t.Errorf("expiry = %v, want %v", expiry, want)
	}

	// Used any number of times, unlike a ticket.
	for range 2 {
		if grant, ok := c.Resolve(token); !ok || grant != "docs/" {
			t.Fatalf("Resolve = (%q, %v), want (\"docs/\", true)", grant, ok)
		}
	}

	c.now = func() time.Time { return expiry }
	if _, ok := c.Resolve(token); ok {
		t.Error("Resolve at the reported expiry = true, want false")
	}
}

func TestCapabilityRefusesWhatWasNotIssued(t *testing.T) {
	c, _, session := newCapabilities(t)
	token := issueCapability(t, c, session, "docs/")

	for _, forged := range []string{"", token + "x", token[:len(token)-1], session} {
		if _, ok := c.Resolve(forged); ok {
			t.Errorf("Resolve(%q) = true, want false", forged)
		}
	}
}

// A capability is a derivative of its session: whatever ends the session ends
// it too, here the session idling out after the capability was issued.
func TestCapabilityDiesWithItsSession(t *testing.T) {
	c, s, session := newCapabilities(t)
	other, err := s.Issue()
	if err != nil {
		t.Fatalf("Issue session: %v", err)
	}
	token := issueCapability(t, c, session, "docs/")
	untouched := issueCapability(t, c, other, "docs/")

	s.mu.Lock()
	for i := range s.data.Sessions {
		if s.data.Sessions[i].Hash == hashToken(session) {
			s.data.Sessions[i].LastUsedAt = time.Now().Add(-IdleTTL - time.Minute)
		}
	}
	s.mu.Unlock()

	if _, ok := c.Resolve(token); ok {
		t.Error("capability of an ended session resolved, want refused")
	}
	if _, ok := c.Resolve(untouched); !ok {
		t.Error("capability of a live session refused, want resolved")
	}
	// Refused and forgotten: a dead capability must not hold a place under the
	// cap that a live one could need.
	c.capabilitiesMu.Lock()
	n := len(c.capabilities)
	c.capabilitiesMu.Unlock()
	if n != 1 {
		t.Errorf("held %d capabilities after the session ended, want 1", n)
	}
	if _, _, err := c.Issue(session, "docs/"); !errors.Is(err, ErrSessionNotLive) {
		t.Errorf("Issue for an ended session: err = %v, want ErrSessionNotLive", err)
	}
	if _, _, err := c.Issue("", "docs/"); !errors.Is(err, ErrSessionNotLive) {
		t.Errorf("Issue without a session: err = %v, want ErrSessionNotLive", err)
	}
}

func TestCapabilityIssueEvictsOldestBeyondCap(t *testing.T) {
	c, _, session := newCapabilities(t)
	start := time.Now()
	issued := make([]string, 0, maxCapabilities+1)
	for i := range maxCapabilities + 1 {
		c.now = func() time.Time { return start.Add(time.Duration(i) * time.Millisecond) }
		issued = append(issued, issueCapability(t, c, session, "docs/"))
	}

	if _, ok := c.Resolve(issued[0]); ok {
		t.Error("oldest capability survived the cap, want it evicted")
	}
	if _, ok := c.Resolve(issued[len(issued)-1]); !ok {
		t.Error("newest capability was evicted, want it kept")
	}
	c.capabilitiesMu.Lock()
	n := len(c.capabilities)
	c.capabilitiesMu.Unlock()
	if n != maxCapabilities {
		t.Errorf("held %d capabilities, want %d", n, maxCapabilities)
	}
}

// Only the session's own holder keeps it from idling out: a capability, which
// a page's script may hold, must not keep a session alive that its user left.
func TestCapabilityDoesNotKeepItsSessionAlive(t *testing.T) {
	c, s, session := newCapabilities(t)
	lastUsed := func() time.Time {
		s.mu.Lock()
		defer s.mu.Unlock()
		for _, r := range s.data.Sessions {
			if r.Hash == hashToken(session) {
				return r.LastUsedAt
			}
		}
		t.Fatal("session not held")
		return time.Time{}
	}
	before := lastUsed()

	token := issueCapability(t, c, session, "docs/")
	if _, ok := c.Resolve(token); !ok {
		t.Fatal("Resolve = false, want true")
	}
	if after := lastUsed(); !after.Equal(before) {
		t.Errorf("LastUsedAt moved from %v to %v, want it untouched", before, after)
	}
}
