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
	if err := wt.FSWatcher.Subscribe(params.ID, params.Path, notifier); err != nil {
		if h.replySubscriptionIDError(ctx, conn, req.ID, err) {
			return
		}
		// What is left is a path that could not be watched, reported as the
		// client's mistake the way this handler has always reported it.
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, err.Error())
		return
	}
	h.state.trackSubscription(params.ID, wt.FSWatcher)
	h.log.Debug("subscribed", "watcher", "fs", "watchId", params.ID, "path", params.Path)

	if err := conn.Reply(ctx, req.ID, struct{}{}); err != nil {
		h.log.Error("failed to send fs subscribe response", "error", err)
	}
}
