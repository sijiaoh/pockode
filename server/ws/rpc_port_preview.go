package ws

import (
	"context"

	"github.com/pockode/server/rpc"
	"github.com/sourcegraph/jsonrpc2"
)

// handlePortPreviewTicket hands the logged-in app a ticket for a preview tab,
// which the tab redeems on the preview host for a session cookie of its own: a
// preview host is a different origin, so the app's login never reaches it.
func (h *rpcMethodHandler) handlePortPreviewTicket(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	// Previews exist only through the relay, and remoteURL is how this handler
	// knows it is up — the same field auth reports previews by.
	if h.remoteURL == "" {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidRequest, "port previews are unavailable: the relay is disabled")
		return
	}
	ticket, err := h.previewTickets.Issue()
	if err != nil {
		h.replyInternalError(ctx, conn, req.ID, "failed to issue preview ticket", err)
		return
	}
	if err := conn.Reply(ctx, req.ID, rpc.PortPreviewTicketResult{Ticket: ticket}); err != nil {
		h.log.Error("failed to send port preview ticket response", "error", err)
	}
}
