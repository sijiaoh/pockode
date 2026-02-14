package ws

import (
	"context"

	"github.com/pockode/server/rpc"
	"github.com/sourcegraph/jsonrpc2"
)

func (h *rpcMethodHandler) handleSettingsSubscribe(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	notifier := h.state.getNotifier()
	id, settings := h.settingsWatcher.Subscribe(notifier)
	h.state.trackSubscription(id, h.settingsWatcher)
	h.log.Debug("subscribed to settings", "watchId", id)

	result := rpc.SettingsSubscribeResult{
		ID:       id,
		Settings: settings,
	}
	if err := conn.Reply(ctx, req.ID, result); err != nil {
		h.log.Error("failed to send settings subscribe response", "error", err)
	}
}

func (h *rpcMethodHandler) handleSettingsUpdate(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.SettingsUpdateParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	if err := h.settingsStore.Update(params.Settings); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, "failed to update settings")
		return
	}

	if err := conn.Reply(ctx, req.ID, struct{}{}); err != nil {
		h.log.Error("failed to send settings update response", "error", err)
	}
}
