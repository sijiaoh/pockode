package ws

import (
	"context"
	"errors"

	"github.com/pockode/server/rpc"
	"github.com/pockode/server/ticket"
	"github.com/pockode/server/worktree"
	"github.com/sourcegraph/jsonrpc2"
)

func (h *rpcMethodHandler) handleTicketGet(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.TicketGetParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	if params.TicketID == "" {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "ticket_id is required")
		return
	}

	tk, found, err := h.worktreeManager.TicketStore.Get(params.TicketID)
	if err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, "failed to get ticket")
		return
	}
	if !found {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "ticket not found")
		return
	}

	if err := conn.Reply(ctx, req.ID, tk); err != nil {
		h.log.Error("failed to send ticket get response", "error", err)
	}
}

func (h *rpcMethodHandler) handleTicketCreate(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.TicketCreateParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	if params.Title == "" {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "title is required")
		return
	}
	if params.RoleID == "" {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "role_id is required")
		return
	}

	// Verify role exists
	_, found, err := h.worktreeManager.RoleStore.Get(params.RoleID)
	if err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, "failed to verify role")
		return
	}
	if !found {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "role not found")
		return
	}

	created, err := h.worktreeManager.TicketStore.Create(ctx, params.ParentID, params.Title, params.Description, params.RoleID, params.Priority)
	if err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, "failed to create ticket")
		return
	}

	h.log.Info("ticket created", "ticketId", created.ID, "title", created.Title)

	if err := conn.Reply(ctx, req.ID, created); err != nil {
		h.log.Error("failed to send ticket create response", "error", err)
	}
}

func (h *rpcMethodHandler) handleTicketUpdate(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.TicketUpdateParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	if params.TicketID == "" {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "ticket_id is required")
		return
	}

	if params.Status != nil && !params.Status.IsValid() {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid status: "+string(*params.Status))
		return
	}

	updates := ticket.TicketUpdate{
		Title:       params.Title,
		Description: params.Description,
		Status:      params.Status,
		Priority:    params.Priority,
	}

	updated, err := h.worktreeManager.TicketStore.Update(ctx, params.TicketID, updates)
	if err != nil {
		if errors.Is(err, ticket.ErrTicketNotFound) {
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "ticket not found")
			return
		}
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, "failed to update ticket")
		return
	}

	h.log.Info("ticket updated", "ticketId", updated.ID)

	if err := conn.Reply(ctx, req.ID, updated); err != nil {
		h.log.Error("failed to send ticket update response", "error", err)
	}
}

func (h *rpcMethodHandler) handleTicketDelete(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.TicketDeleteParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	if params.TicketID == "" {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "ticket_id is required")
		return
	}

	if err := h.worktreeManager.TicketStore.Delete(ctx, params.TicketID); err != nil {
		if errors.Is(err, ticket.ErrTicketNotFound) {
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "ticket not found")
			return
		}
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, "failed to delete ticket")
		return
	}

	h.log.Info("ticket deleted", "ticketId", params.TicketID)

	if err := conn.Reply(ctx, req.ID, struct{}{}); err != nil {
		h.log.Error("failed to send ticket delete response", "error", err)
	}
}

func (h *rpcMethodHandler) handleTicketStart(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, wt *worktree.Worktree) {
	var params rpc.TicketStartParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	if params.TicketID == "" {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "ticket_id is required")
		return
	}

	tk, found, err := h.worktreeManager.TicketStore.Get(params.TicketID)
	if err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, "failed to get ticket")
		return
	}
	if !found {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "ticket not found")
		return
	}

	if tk.Status != ticket.TicketStatusOpen {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "ticket is not open")
		return
	}

	sessionID, err := h.worktreeManager.TicketStarter.Start(ctx, tk, wt.SessionStore, wt.ChatClient)
	if err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, "failed to start ticket: "+err.Error())
		return
	}

	result := rpc.TicketStartResult{SessionID: sessionID}
	if err := conn.Reply(ctx, req.ID, result); err != nil {
		h.log.Error("failed to send ticket start response", "error", err)
	}
}

func (h *rpcMethodHandler) handleTicketDeleteByStatus(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.TicketDeleteByStatusParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	if !params.Status.IsValid() {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid status: "+string(params.Status))
		return
	}

	count, err := h.worktreeManager.TicketStore.DeleteByStatus(ctx, params.Status)
	if err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, "failed to delete tickets")
		return
	}

	h.log.Info("tickets deleted by status", "status", params.Status, "count", count)

	result := rpc.TicketDeleteByStatusResult{Count: count}
	if err := conn.Reply(ctx, req.ID, result); err != nil {
		h.log.Error("failed to send ticket delete by status response", "error", err)
	}
}

func (h *rpcMethodHandler) handleTicketListSubscribe(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	notifier := h.state.getNotifier()
	id, tickets, err := h.worktreeManager.TicketWatcher.Subscribe(notifier)
	if err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, "failed to subscribe")
		return
	}
	h.state.trackSubscription(id, h.worktreeManager.TicketWatcher)
	h.log.Debug("subscribed", "watcher", "ticket list", "watchId", id)

	result := rpc.TicketListSubscribeResult{
		ID:      id,
		Tickets: tickets,
	}

	if err := conn.Reply(ctx, req.ID, result); err != nil {
		h.log.Error("failed to send ticket list subscribe response", "error", err)
	}
}
