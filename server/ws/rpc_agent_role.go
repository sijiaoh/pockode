package ws

import (
	"context"
	"errors"
	"fmt"

	"github.com/pockode/server/agentrole"
	"github.com/pockode/server/rpc"
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
	}
	if err := h.agentRoleStore.Update(ctx, params.ID, fields); err != nil {
		h.replyAgentRoleError(ctx, conn, req.ID, err, "failed to update agent role")
		return
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
	var refCount int
	for _, w := range works {
		if w.AgentRoleID == params.ID {
			refCount++
		}
	}
	if refCount > 0 {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams,
			fmt.Sprintf("cannot delete: role is referenced by %d work item(s)", refCount))
		return
	}

	if err := h.agentRoleStore.Delete(ctx, params.ID); err != nil {
		h.replyAgentRoleError(ctx, conn, req.ID, err, "failed to delete agent role")
		return
	}

	// Clear default agent role if the deleted role was the default
	if s := h.settingsStore.Get(); s.DefaultAgentRoleID == params.ID {
		s.DefaultAgentRoleID = ""
		if err := h.settingsStore.Update(s); err != nil {
			h.log.Error("failed to clear default agent role after deletion", "error", err)
		}
	}

	h.log.Info("agent role deleted", "roleId", params.ID)

	if err := conn.Reply(ctx, req.ID, struct{}{}); err != nil {
		h.log.Error("failed to send agent role delete response", "error", err)
	}
}

func (h *rpcMethodHandler) handleAgentRoleResetDefaults(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	if err := h.agentRoleStore.ResetDefaults(ctx); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, "failed to reset agent roles")
		return
	}

	// Clear default agent role since old IDs are no longer valid
	if s := h.settingsStore.Get(); s.DefaultAgentRoleID != "" {
		s.DefaultAgentRoleID = ""
		if err := h.settingsStore.Update(s); err != nil {
			h.log.Error("failed to clear default agent role after reset", "error", err)
		}
	}

	h.log.Info("agent roles reset to defaults")

	if err := conn.Reply(ctx, req.ID, struct{}{}); err != nil {
		h.log.Error("failed to send agent role reset defaults response", "error", err)
	}
}

func (h *rpcMethodHandler) handleAgentRoleListSubscribe(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	notifier := h.state.getNotifier()
	id, items, err := h.agentRoleListWatcher.Subscribe(notifier)
	if err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, "failed to subscribe")
		return
	}
	h.state.trackSubscription(id, h.agentRoleListWatcher)
	h.log.Debug("subscribed", "watcher", "agent role list", "watchId", id)

	result := rpc.AgentRoleListSubscribeResult{
		ID:    id,
		Items: items,
	}

	if err := conn.Reply(ctx, req.ID, result); err != nil {
		h.log.Error("failed to send agent role list subscribe response", "error", err)
	}
}
