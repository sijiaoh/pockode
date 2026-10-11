package ws

import (
	"context"

	"github.com/pockode/server/rpc"
	"github.com/sourcegraph/jsonrpc2"
)

func (h *rpcMethodHandler) handleRemoteURLSubscribe(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	id, ok := h.subscriptionID(ctx, conn, req)
	if !ok {
		return
	}

	remoteURL, err := h.remoteURLWatcher.Subscribe(id, h.state.getNotifier())
	if err != nil {
		h.replySubscriptionError(ctx, conn, req.ID, err, "failed to subscribe to remote url")
		return
	}
	h.state.trackSubscription(id, h.remoteURLWatcher)

	if err := conn.Reply(ctx, req.ID, rpc.RemoteURLSubscribeResult{RemoteURL: remoteURL}); err != nil {
		h.log.Error("failed to send remote url subscribe response", "error", err)
	}
}
