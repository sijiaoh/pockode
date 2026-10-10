package authsession

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// newTestTickets returns a ticket set on a clock the test moves by hand.
func newTestTickets() (*Tickets, *time.Time) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	t := NewTickets()
	t.now = func() time.Time { return now }
	return t, &now
}

func issueTicket(t *testing.T, tickets *Tickets) string {
	t.Helper()
	ticket, err := tickets.Issue()
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	return ticket
}

func TestTicketRedeemsOnce(t *testing.T) {
	tickets, _ := newTestTickets()
	ticket := issueTicket(t, tickets)

	if !tickets.Redeem(ticket) {
		t.Fatal("first Redeem = false, want true")
	}
	if tickets.Redeem(ticket) {
		t.Error("second Redeem = true, want false: a ticket is single-use")
	}
}

// Two tabs racing with one ticket (a double click, a reload) must not both
// get a session.
func TestTicketRedeemsOnceUnderConcurrency(t *testing.T) {
	tickets, _ := newTestTickets()
	ticket := issueTicket(t, tickets)

	var wins atomic.Int32
	var wg sync.WaitGroup
	for range 16 {
		wg.Go(func() {
			if tickets.Redeem(ticket) {
				wins.Add(1)
			}
		})
	}
	wg.Wait()
	if got := wins.Load(); got != 1 {
		t.Errorf("%d concurrent Redeems succeeded, want exactly 1", got)
	}
}

func TestTicketsAreIndependent(t *testing.T) {
	tickets, _ := newTestTickets()
	a := issueTicket(t, tickets)
	b := issueTicket(t, tickets)
	if a == b {
		t.Fatal("two tickets are identical")
	}

	if !tickets.Redeem(a) {
		t.Error("Redeem(a) = false, want true")
	}
	if !tickets.Redeem(b) {
		t.Error("Redeem(b) = false after a was spent, want true")
	}
}

func TestTicketExpires(t *testing.T) {
	tickets, now := newTestTickets()
	fresh := issueTicket(t, tickets)
	stale := issueTicket(t, tickets)

	*now = now.Add(TicketTTL - time.Second)
	if !tickets.Redeem(fresh) {
		t.Error("Redeem just inside the TTL = false, want true")
	}

	*now = now.Add(time.Second)
	if tickets.Redeem(stale) {
		t.Error("Redeem at the TTL = true, want false")
	}
}

func TestRedeemUnknownTicket(t *testing.T) {
	tickets, _ := newTestTickets()
	ticket := issueTicket(t, tickets)

	if tickets.Redeem(ticket + "x") {
		t.Error("Redeem(unknown ticket) = true, want false")
	}
	if tickets.Redeem("") {
		t.Error(`Redeem("") = true, want false`)
	}
	// A failed guess must not cost the real ticket anything.
	if !tickets.Redeem(ticket) {
		t.Error("Redeem(issued ticket) = false after unknown ones were tried, want true")
	}
}

// The set is only held in memory and holds no ticket verbatim, so a dump of it
// could not be replayed.
func TestTicketIsNotStoredVerbatim(t *testing.T) {
	tickets, _ := newTestTickets()
	ticket := issueTicket(t, tickets)

	if _, ok := tickets.tickets[ticket]; ok {
		t.Error("the ticket set is keyed by the ticket itself")
	}
}

// A client that keeps asking and never redeems must not grow the set without
// bound; the tickets lost to that are the oldest ones.
func TestTicketsAreCapped(t *testing.T) {
	tickets, now := newTestTickets()
	first := issueTicket(t, tickets)
	*now = now.Add(time.Millisecond)
	second := issueTicket(t, tickets)
	for range maxTickets - 1 {
		*now = now.Add(time.Millisecond)
		issueTicket(t, tickets)
	}

	if n := len(tickets.tickets); n != maxTickets {
		t.Errorf("held %d tickets, want %d", n, maxTickets)
	}
	if tickets.Redeem(first) {
		t.Error("the oldest ticket survived the cap")
	}
	if !tickets.Redeem(second) {
		t.Error("the second-oldest ticket was evicted too")
	}
}
