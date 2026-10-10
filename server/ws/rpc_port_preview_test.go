package ws

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/coder/websocket"
	"github.com/pockode/server/authsession"
	"github.com/pockode/server/internal/authsessiontest"
	"github.com/pockode/server/rpc"
)

// callAuthenticated authenticates a fresh connection and then sends method on
// it, returning the reply to method.
func callAuthenticated(t *testing.T, serverURL, method string, params any) rpcResponse {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), opTimeout)
	defer cancel()

	conn, err := dialTestClient(ctx, serverURL)
	if err != nil {
		t.Fatalf("failed to connect: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	if resp := exchange(t, ctx, conn, 1, "auth", rpc.AuthParams{Password: testPassword}); resp.Error != nil {
		t.Fatalf("auth failed: %v", resp.Error)
	}
	return exchange(t, ctx, conn, 2, method, params)
}

func TestHandler_PortPreviewTicket_IssuesRedeemableTicket(t *testing.T) {
	tickets := authsession.NewTickets()
	server := newTicketTestServer(t, testPassword, "https://abc123.cloud.pockode.com", authsessiontest.New(), tickets)

	resp := callAuthenticated(t, server.URL, "port_preview.ticket", nil)
	if resp.Error != nil {
		t.Fatalf("port_preview.ticket failed: %v", resp.Error)
	}
	// Decoded by its wire name, which is what the web client reads.
	var result struct {
		Ticket string `json:"ticket"`
	}
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !tickets.Redeem(result.Ticket) {
		t.Errorf("ticket %q does not redeem on the set the preview host is given", result.Ticket)
	}
}

func TestHandler_PortPreviewTicket_RefusedWithoutRelay(t *testing.T) {
	server := newAuthTestServer(t, testPassword, "", authsessiontest.New())

	resp := callAuthenticated(t, server.URL, "port_preview.ticket", nil)
	if resp.Error == nil {
		t.Fatalf("port_preview.ticket succeeded without the relay: %s", resp.Result)
	}
	if !strings.Contains(resp.Error.Message, "relay is disabled") {
		t.Errorf("error = %q, want it to say the relay is disabled", resp.Error.Message)
	}
}
