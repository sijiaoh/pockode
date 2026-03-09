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

	// Validate that the referenced agent role exists
	if params.Settings.DefaultAgentRoleID != "" {
		_, found, err := h.agentRoleStore.Get(params.Settings.DefaultAgentRoleID)
		if err != nil {
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, "failed to validate agent role")
			return
		}
		if !found {
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "agent role not found")
			return
		}
	}

	// Validate default agent type if set
	if params.Settings.DefaultAgentType != "" && !params.Settings.DefaultAgentType.IsValid() {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid default agent type")
		return
	}

	// Validate default mode if set
	if params.Settings.DefaultMode != "" && !params.Settings.DefaultMode.IsValid() {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid default mode")
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
