package ws

import (
	"context"
	"errors"
	"fmt"

	"github.com/pockode/server/agentrole"
	"github.com/pockode/server/rpc"
	"github.com/pockode/server/work"
	"github.com/sourcegraph/jsonrpc2"
)

func (h *rpcMethodHandler) replyAgentRoleError(ctx context.Context, conn *jsonrpc2.Conn, id jsonrpc2.ID, err error, fallbackMsg string) {
	if errors.Is(err, agentrole.ErrNotFound) {
		h.replyError(ctx, conn, id, jsonrpc2.CodeInvalidParams, "agent role not found")
	} else if errors.Is(err, agentrole.ErrInvalidRole) {
		h.replyError(ctx, conn, id, jsonrpc2.CodeInvalidParams, err.Error())
	} else {
		h.replyError(ctx, conn, id, jsonrpc2.CodeInternalError, fallbackMsg)
	}
}

func (h *rpcMethodHandler) handleAgentRoleCreate(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.AgentRoleCreateParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	role, err := h.agentRoleStore.Create(ctx, agentrole.AgentRole{
		Name:       params.Name,
		RolePrompt: params.RolePrompt,
		Steps:      params.Steps,
		WorkType:   params.WorkType,
	})
	if err != nil {
		h.replyAgentRoleError(ctx, conn, req.ID, err, "failed to create agent role")
		return
	}

	h.log.Info("agent role created", "roleId", role.ID, "name", role.Name)

	if err := conn.Reply(ctx, req.ID, role); err != nil {
		h.log.Error("failed to send agent role create response", "error", err)
	}
}

func (h *rpcMethodHandler) handleAgentRoleUpdate(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.AgentRoleUpdateParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	fields := agentrole.UpdateFields{
		Name:       params.Name,
		RolePrompt: params.RolePrompt,
		Steps:      params.Steps,
		AgentType:  params.AgentType,
		Model:      params.Model,
		Effort:     params.Effort,
		WorkType:   params.WorkType,
	}
	if err := h.agentRoleStore.Update(ctx, params.ID, fields); err != nil {
		h.replyAgentRoleError(ctx, conn, req.ID, err, "failed to update agent role")
		return
	}

	if params.WorkType != nil && *params.WorkType == work.WorkTypeTask {
		h.dropDefaultStoryRole(params.ID)
	}

	h.log.Info("agent role updated", "roleId", params.ID)

	if err := conn.Reply(ctx, req.ID, struct{}{}); err != nil {
		h.log.Error("failed to send agent role update response", "error", err)
	}
}

func (h *rpcMethodHandler) handleAgentRoleDelete(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.AgentRoleDeleteParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	// Referential integrity: check if any work items reference this role
	works, err := h.workStore.List()
	if err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, "failed to check role references")
		return
	}
	if refCount := work.CountRoleRefs(works)[params.ID]; refCount > 0 {
		// User-facing verbatim: the client prints this sentence as-is —
		// AgentRoleDetailOverlay's delete section adds no prefix of its own —
		// which is why it is a capitalised sentence and not a lowercase fragment
		// like its neighbours. Singular and plural are spelled out rather than
		// left as "work item(s)" for the same reason. See
		// docs/agent-roles-ui.md §5.
		message := fmt.Sprintf("Can't delete: %d work items still use this role. Change their role, or delete them, first.", refCount)
		if refCount == 1 {
			message = "Can't delete: 1 work item still uses this role. Change its role, or delete it, first."
		}
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, message)
		return
	}

	if err := h.agentRoleStore.Delete(ctx, params.ID); err != nil {
		h.replyAgentRoleError(ctx, conn, req.ID, err, "failed to delete agent role")
		return
	}

	h.dropDefaultStoryRole(params.ID)

	h.log.Info("agent role deleted", "roleId", params.ID)

	if err := conn.Reply(ctx, req.ID, struct{}{}); err != nil {
		h.log.Error("failed to send agent role delete response", "error", err)
	}
}

// dropDefaultStoryRole clears the default story role if it is roleID: called
// once that role can no longer start a story — deleted, or narrowed to tasks.
// The role change is accepted and the default goes with it, rather than the
// change being refused, so that editing a role never has to be preceded by a
// trip to a different setting. See docs/projects/data-model.md.
func (h *rpcMethodHandler) dropDefaultStoryRole(roleID string) {
	s := h.settingsStore.Get()
	if s.DefaultAgentRoleID != roleID {
		return
	}
	s.DefaultAgentRoleID = ""
	if err := h.settingsStore.Update(s); err != nil {
		h.log.Error("failed to clear the default story role", "roleId", roleID, "error", err)
	}
}

func (h *rpcMethodHandler) handleAgentRoleResetDefaults(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	pmRoleID, err := h.agentRoleStore.ResetDefaults(ctx)
	if err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, "failed to reset agent roles")
		return
	}

	// Set PM as default agent role
	s := h.settingsStore.Get()
	s.DefaultAgentRoleID = pmRoleID
	if err := h.settingsStore.Update(s); err != nil {
		h.log.Error("failed to set default agent role after reset", "error", err)
	}

	h.log.Info("agent roles reset to defaults")

	if err := conn.Reply(ctx, req.ID, struct{}{}); err != nil {
		h.log.Error("failed to send agent role reset defaults response", "error", err)
	}
}

func (h *rpcMethodHandler) handleAgentRoleListSubscribe(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	id, ok := h.subscriptionID(ctx, conn, req)
	if !ok {
		return
	}

	notifier := h.state.getNotifier()
	items, refCounts, err := h.agentRoleListWatcher.Subscribe(id, notifier)
	if err != nil {
		h.replySubscriptionError(ctx, conn, req.ID, err, "failed to subscribe to agent role list")
		return
	}
	h.state.trackSubscription(id, h.agentRoleListWatcher)
	h.log.Debug("subscribed", "watcher", "agent role list", "watchId", id)

	result := rpc.AgentRoleListSubscribeResult{
		Items:         items,
		WorkRefCounts: refCounts,
	}

	if err := conn.Reply(ctx, req.ID, result); err != nil {
		h.log.Error("failed to send agent role list subscribe response", "error", err)
	}
}
