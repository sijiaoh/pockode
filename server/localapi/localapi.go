// Package localapi serves the routes local code calls with this server's
// server.json token rather than the user's password — today the login tickets
// the cluster that started this node opens it with — and holds the token check
// the MCP API shares. The token is the guard; the relay refusing these paths
// (apiroute.IsLocalOnly) is defence in depth.
package localapi

import (
	"crypto/subtle"
	"encoding/json"
	"log/slog"
	"net/http"
)

// TokenHeader carries the token to the routes under Prefix. It is not
// Authorization on purpose: a node too old to know a route would read a
// Bearer value as a password guess and count it against the password lockout.
const TokenHeader = "X-Pockode-Local-Token"

// Prefix is where the Pockode-specific local routes answer. It is spelled out
// as Pockode's own because the relay refuses local-only paths on every port it
// previews too, and a generic prefix would take the path from the user's apps.
const Prefix = "/api/pockode-local/"

// LoginTicketPath issues a one-time app login: POST with TokenHeader, reply
// LoginTicketResponse.
const LoginTicketPath = Prefix + "login-ticket"

// LoginTicketResponse is the reply to a successful POST to LoginTicketPath.
// The ticket is redeemable once, within authsession.TicketTTL, by the WebSocket
// auth of the server that issued it.
type LoginTicketResponse struct {
	Ticket string `json:"ticket"`
}

// TokenMatches reports whether presented is the server's local token. It fails
// closed on an empty token: ConstantTimeCompare("", "") is 1, which would
// otherwise let a server started without one accept an empty credential.
func TokenMatches(presented, token string) bool {
	if token == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(presented), []byte(token)) == 1
}

// TicketIssuer issues the app-login tickets; authsession.Tickets implements
// it. The WebSocket auth redeems them, so the two must share one instance —
// and not the preview tickets', so neither redeems as the other.
type TicketIssuer interface {
	Issue() (string, error)
}

// LoginTicketHandler serves LoginTicketPath.
type LoginTicketHandler struct {
	tickets TicketIssuer
	token   string
}

func NewLoginTicketHandler(tickets TicketIssuer, token string) *LoginTicketHandler {
	return &LoginTicketHandler{tickets: tickets, token: token}
}

func (h *LoginTicketHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !TokenMatches(r.Header.Get(TokenHeader), h.token) {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	ticket, err := h.tickets.Issue()
	if err != nil {
		slog.Error("failed to issue login ticket", "error", err)
		http.Error(w, "failed to issue login ticket", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	// A ticket is a credential; no cache between here and the caller keeps it.
	w.Header().Set("Cache-Control", "no-store")
	if err := json.NewEncoder(w).Encode(LoginTicketResponse{Ticket: ticket}); err != nil {
		slog.Error("failed to send login ticket", "error", err)
	}
}
