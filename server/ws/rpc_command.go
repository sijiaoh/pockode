package ws

import (
	"context"

	"github.com/pockode/server/rpc"
	"github.com/sourcegraph/jsonrpc2"
)

func (h *rpcMethodHandler) handleCommandList(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	commands := h.commandStore.List()

	result := rpc.CommandListResult{Commands: commands}

	if err := conn.Reply(ctx, req.ID, result); err != nil {
		h.log.Error("failed to send command list response", "error", err)
	}
}
