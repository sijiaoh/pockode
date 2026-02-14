package ws

import (
	"context"
	"errors"

	"github.com/pockode/server/rpc"
	"github.com/pockode/server/ticket"
	"github.com/sourcegraph/jsonrpc2"
)

func (h *rpcMethodHandler) handleAgentRoleList(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	roles, err := h.worktreeManager.RoleStore.List()
	if err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, "failed to list roles")
		return
	}

	result := rpc.AgentRoleListResult{Roles: roles}
	if err := conn.Reply(ctx, req.ID, result); err != nil {
		h.log.Error("failed to send agent role list response", "error", err)
	}
}

func (h *rpcMethodHandler) handleAgentRoleCreate(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.AgentRoleCreateParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	if params.Name == "" {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "name is required")
		return
	}

	role, err := h.worktreeManager.RoleStore.Create(ctx, params.Name, params.SystemPrompt)
	if err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, "failed to create role")
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

	if params.RoleID == "" {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "role_id is required")
		return
	}
	if params.Name == "" {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "name is required")
		return
	}

	role, err := h.worktreeManager.RoleStore.Update(ctx, params.RoleID, params.Name, params.SystemPrompt)
	if err != nil {
		if errors.Is(err, ticket.ErrRoleNotFound) {
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "role not found")
			return
		}
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, "failed to update role")
		return
	}

	h.log.Info("agent role updated", "roleId", role.ID, "name", role.Name)

	if err := conn.Reply(ctx, req.ID, role); err != nil {
		h.log.Error("failed to send agent role update response", "error", err)
	}
}

func (h *rpcMethodHandler) handleAgentRoleDelete(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.AgentRoleDeleteParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	if params.RoleID == "" {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "role_id is required")
		return
	}

	if err := h.worktreeManager.RoleStore.Delete(ctx, params.RoleID); err != nil {
		if errors.Is(err, ticket.ErrRoleNotFound) {
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "role not found")
			return
		}
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, "failed to delete role")
		return
	}

	h.log.Info("agent role deleted", "roleId", params.RoleID)

	if err := conn.Reply(ctx, req.ID, struct{}{}); err != nil {
		h.log.Error("failed to send agent role delete response", "error", err)
	}
}
