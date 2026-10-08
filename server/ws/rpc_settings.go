package ws

import (
	"context"
	"fmt"

	"github.com/pockode/server/rpc"
	"github.com/pockode/server/session"
	"github.com/pockode/server/settings"
	"github.com/pockode/server/work"
	"github.com/sourcegraph/jsonrpc2"
)

func (h *rpcMethodHandler) handleSettingsSubscribe(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	id, ok := h.subscriptionID(ctx, conn, req)
	if !ok {
		return
	}

	notifier := h.state.getNotifier()
	settings, err := h.settingsWatcher.Subscribe(id, notifier)
	if err != nil {
		h.replySubscriptionError(ctx, conn, req.ID, err, "failed to subscribe to settings")
		return
	}
	h.state.trackSubscription(id, h.settingsWatcher)
	h.log.Debug("subscribed to settings", "watchId", id)

	result := rpc.SettingsSubscribeResult{
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

	// The default agent role is the role a new story starts on, so it must be one
	// that takes stories. Judged only when it changes: settings.update replaces
	// the whole object, and a stored value that went stale some other way (an
	// edit to settings.json) must not make every unrelated setting unsavable.
	if id := params.Settings.DefaultAgentRoleID; id != "" && id != h.settingsStore.Get().DefaultAgentRoleID {
		role, found, err := h.agentRoleStore.Get(id)
		if err != nil {
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, "failed to validate agent role")
			return
		}
		if !found {
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "agent role not found")
			return
		}
		if !role.AcceptsWorkType(work.WorkTypeStory) {
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams,
				fmt.Sprintf("%s can't run stories, so it can't be the default story role", role.Name))
			return
		}
	}

	// The default agent, model and effort are judged as one: a model or effort
	// only exists within an agent's list, so a leftover value from the agent the
	// user just switched away from is refused rather than silently dropped —
	// the client clears the pair when it changes the agent.
	if err := session.ValidateEngine(params.Settings.Engine()); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, err.Error())
		return
	}

	// Validate default mode if set
	if params.Settings.DefaultMode != "" && !params.Settings.DefaultMode.IsValid() {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid default mode")
		return
	}

	// Validate worktree base directory if set
	if err := settings.ValidateWorktreeBaseDir(params.Settings.WorktreeBaseDir); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, err.Error())
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
