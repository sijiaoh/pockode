package ws

import (
	"context"

	"github.com/pockode/server/rpc"
	"github.com/sourcegraph/jsonrpc2"
)

func (h *rpcMethodHandler) handleFSSubscribe(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.FSSubscribeParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	connID := h.state.getConnID()
	id, err := h.state.worktree.FSWatcher.Subscribe(params.Path, conn, connID)
	if err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, err.Error())
		return
	}
	h.log.Debug("subscribed", "watcher", "fs", "watchId", id, "path", params.Path)

	if err := conn.Reply(ctx, req.ID, rpc.FSSubscribeResult{ID: id}); err != nil {
		h.log.Error("failed to send fs subscribe response", "error", err)
	}
}
