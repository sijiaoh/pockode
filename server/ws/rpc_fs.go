package ws

import (
	"context"

	"github.com/pockode/server/rpc"
	"github.com/pockode/server/worktree"
	"github.com/sourcegraph/jsonrpc2"
)

func (h *rpcMethodHandler) handleFSSubscribe(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, wt *worktree.Worktree) {
	var params rpc.FSSubscribeParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	notifier := h.state.getNotifier()
	id, err := wt.FSWatcher.Subscribe(params.Path, notifier)
	if err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, err.Error())
		return
	}
	h.state.trackSubscription(id, wt.FSWatcher)
	h.log.Debug("subscribed", "watcher", "fs", "watchId", id, "path", params.Path)

	if err := conn.Reply(ctx, req.ID, rpc.FSSubscribeResult{ID: id}); err != nil {
		h.log.Error("failed to send fs subscribe response", "error", err)
	}
}
