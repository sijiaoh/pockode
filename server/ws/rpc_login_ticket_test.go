package ws

import (
	"encoding/json"
	"testing"

	"github.com/pockode/server/authsession"
	"github.com/pockode/server/internal/authsessiontest"
	"github.com/pockode/server/rpc"
	"github.com/sourcegraph/jsonrpc2"
)

func issueLoginTicket(t *testing.T, tickets *authsession.Tickets) string {
	t.Helper()
	ticket, err := tickets.Issue()
	if err != nil {
		t.Fatalf("Issue ticket: %v", err)
	}
	return ticket
}

func authSessionToken(t *testing.T, resp rpcResponse) string {
	t.Helper()
	if resp.Error != nil {
		t.Fatalf("auth refused: %+v", resp.Error)
	}
	var result rpc.AuthResult
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	return result.SessionToken
}

func TestHandler_Auth_LoginTicket(t *testing.T) {
	t.Run("alone it issues a session, once", func(t *testing.T) {
		sessions := authsessiontest.New()
		tickets := authsession.NewTickets()
		server := newLoginTicketTestServer(t, sessions, tickets)
		ticket := issueLoginTicket(t, tickets)

		token := authSessionToken(t, callOnce(t, server.URL, "auth", rpc.AuthParams{LoginTicket: ticket}))
		if !sessions.Validate(token) {
			t.Fatalf("session token %q is not one the store issued", token)
		}

		if got := authReason(t, callOnce(t, server.URL, "auth", rpc.AuthParams{LoginTicket: ticket})); got != rpc.AuthReasonInvalidTicket {
			t.Errorf("reused ticket: reason = %q, want %q", got, rpc.AuthReasonInvalidTicket)
		}
	})

	t.Run("an unknown ticket is refused", func(t *testing.T) {
		server := newLoginTicketTestServer(t, authsessiontest.New(), authsession.NewTickets())

		if got := authReason(t, callOnce(t, server.URL, "auth", rpc.AuthParams{LoginTicket: "not-a-ticket"})); got != rpc.AuthReasonInvalidTicket {
			t.Errorf("reason = %q, want %q", got, rpc.AuthReasonInvalidTicket)
		}
	})

	// Every Open from the cluster sends a ticket; issuing a session for each
	// would fill the session cap and evict other devices.
	t.Run("a live session is kept and the ticket still spent", func(t *testing.T) {
		sessions := authsessiontest.New()
		live, err := sessions.Issue()
		if err != nil {
			t.Fatalf("Issue: %v", err)
		}
		tickets := authsession.NewTickets()
		server := newLoginTicketTestServer(t, sessions, tickets)
		ticket := issueLoginTicket(t, tickets)

		if got := authSessionToken(t, callOnce(t, server.URL, "auth", rpc.AuthParams{SessionToken: live, LoginTicket: ticket})); got != live {
			t.Errorf("session token = %q, want the live one kept (%q)", got, live)
		}
		if tickets.Redeem(ticket) {
			t.Error("ticket still redeemable after a connect that carried it")
		}
	})

	t.Run("a live session is kept even beside a spent ticket", func(t *testing.T) {
		sessions := authsessiontest.New()
		live, err := sessions.Issue()
		if err != nil {
			t.Fatalf("Issue: %v", err)
		}
		server := newLoginTicketTestServer(t, sessions, authsession.NewTickets())

		if got := authSessionToken(t, callOnce(t, server.URL, "auth", rpc.AuthParams{SessionToken: live, LoginTicket: "spent"})); got != live {
			t.Errorf("session token = %q, want %q", got, live)
		}
	})

	t.Run("an expired session falls back to the ticket", func(t *testing.T) {
		sessions := authsessiontest.New()
		tickets := authsession.NewTickets()
		server := newLoginTicketTestServer(t, sessions, tickets)
		ticket := issueLoginTicket(t, tickets)

		token := authSessionToken(t, callOnce(t, server.URL, "auth", rpc.AuthParams{SessionToken: "gone", LoginTicket: ticket}))
		if token == "gone" || !sessions.Validate(token) {
			t.Errorf("session token = %q, want a newly issued one", token)
		}
	})

	t.Run("an expired session beside a bad ticket says the ticket", func(t *testing.T) {
		server := newLoginTicketTestServer(t, authsessiontest.New(), authsession.NewTickets())

		if got := authReason(t, callOnce(t, server.URL, "auth", rpc.AuthParams{SessionToken: "gone", LoginTicket: "spent"})); got != rpc.AuthReasonInvalidTicket {
			t.Errorf("reason = %q, want %q", got, rpc.AuthReasonInvalidTicket)
		}
	})

	// Refused as malformed, and spent anyway: the URL it came in is in the
	// browser's history whatever the request looked like.
	t.Run("with a password it is refused and spent", func(t *testing.T) {
		tickets := authsession.NewTickets()
		server := newLoginTicketTestServer(t, authsessiontest.New(), tickets)
		ticket := issueLoginTicket(t, tickets)

		resp := callOnce(t, server.URL, "auth", rpc.AuthParams{Password: testPassword, LoginTicket: ticket})
		if resp.Error == nil || resp.Error.Code != jsonrpc2.CodeInvalidParams {
			t.Fatalf("got %+v, want an invalid-params error", resp.Error)
		}
		if tickets.Redeem(ticket) {
			t.Error("ticket still redeemable after a refused connect that carried it")
		}
	})
}

// A ticket is not a password guess: failed tickets, whose password is empty,
// must not start the lockout the correct password would then be refused by.
func TestHandler_Auth_InvalidTicketsAreNotCountedAsGuesses(t *testing.T) {
	server := newLoginTicketTestServer(t, authsessiontest.New(), authsession.NewTickets())

	// authguard locks on the 6th failure in a row.
	for range 6 {
		if got := authReason(t, callOnce(t, server.URL, "auth", rpc.AuthParams{LoginTicket: "not-a-ticket"})); got != rpc.AuthReasonInvalidTicket {
			t.Fatalf("reason = %q, want %q", got, rpc.AuthReasonInvalidTicket)
		}
	}

	if resp := callOnce(t, server.URL, "auth", rpc.AuthParams{Password: testPassword}); resp.Error != nil {
		t.Fatalf("correct password after failed tickets: %+v, want accepted", resp.Error)
	}
}
