package localapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/pockode/server/apiroute"
	"github.com/pockode/server/authsession"
)

// The token is the guard, but the relay refusing these paths is what keeps the
// token check from being the only thing between the public URL and a login.
func TestPathsStayLocalOnly(t *testing.T) {
	for _, path := range []string{Prefix, LoginTicketPath} {
		if !apiroute.IsLocalOnly(path) {
			t.Errorf("apiroute.IsLocalOnly(%q) = false; the relay would forward it", path)
		}
	}
}

func TestLoginTicketHandlerIssuesARedeemableTicket(t *testing.T) {
	tickets := authsession.NewTickets()
	h := NewLoginTicketHandler(tickets, "local-token")

	req := httptest.NewRequest(http.MethodPost, LoginTicketPath, nil)
	req.Header.Set(TokenHeader, "local-token")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("got status %d, want %d (body: %s)", rec.Code, http.StatusOK, rec.Body.String())
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", got)
	}
	var resp LoginTicketResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode %q: %v", rec.Body.String(), err)
	}
	if !tickets.Redeem(resp.Ticket) {
		t.Fatalf("ticket %q does not redeem on the instance it was issued from", resp.Ticket)
	}
}

func TestLoginTicketHandlerRefuses(t *testing.T) {
	tests := []struct {
		name        string
		serverToken string
		header      string
		value       string
	}{
		{"no credential", "local-token", "", ""},
		{"a wrong token", "local-token", TokenHeader, "other-token"},
		// Authorization is what an older node reads as a password guess; the
		// token is never accepted there, so no caller learns to send it so.
		{"the token as a bearer", "local-token", "Authorization", "Bearer local-token"},
		{"anything when the server has no token", "", TokenHeader, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := NewLoginTicketHandler(authsession.NewTickets(), tt.serverToken)
			req := httptest.NewRequest(http.MethodPost, LoginTicketPath, nil)
			if tt.header != "" {
				req.Header.Set(tt.header, tt.value)
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != http.StatusUnauthorized {
				t.Errorf("got status %d, want %d", rec.Code, http.StatusUnauthorized)
			}
		})
	}
}
