package ws

import (
	"context"
	"errors"

	"github.com/pockode/server/rpc"
	"github.com/pockode/server/settings"
	"github.com/sourcegraph/jsonrpc2"
)

func (h *rpcMethodHandler) handleSettingsGet(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	result := h.settingsStore.Get()
	if err := conn.Reply(ctx, req.ID, result); err != nil {
		h.log.Error("failed to send settings get response", "error", err)
	}
}

func (h *rpcMethodHandler) handleSettingsUpdate(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.SettingsUpdateParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	if err := h.settingsStore.Update(params.Settings); err != nil {
		if errors.Is(err, settings.ErrInvalidSandboxMode) {
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid sandbox mode")
			return
		}
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, "failed to update settings")
		return
	}

	if err := conn.Reply(ctx, req.ID, struct{}{}); err != nil {
		h.log.Error("failed to send settings update response", "error", err)
	}
}
