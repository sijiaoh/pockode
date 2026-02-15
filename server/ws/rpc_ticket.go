package ws

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/pockode/server/process"
	"github.com/pockode/server/rpc"
	"github.com/pockode/server/session"
	"github.com/pockode/server/ticket"
	"github.com/pockode/server/worktree"
	"github.com/sourcegraph/jsonrpc2"
)

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

	created, err := h.worktreeManager.TicketStore.Create(ctx, params.ParentID, params.Title, params.Description, params.RoleID)
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

	updates := ticket.TicketUpdate{
		Title:       params.Title,
		Description: params.Description,
		Status:      params.Status,
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

	// Get the ticket
	tk, found, err := h.worktreeManager.TicketStore.Get(params.TicketID)
	if err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, "failed to get ticket")
		return
	}
	if !found {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "ticket not found")
		return
	}

	// Only open tickets can be started
	if tk.Status != ticket.TicketStatusOpen {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "ticket is not open")
		return
	}

	// Get the role for system prompt
	role, found, err := h.worktreeManager.RoleStore.Get(tk.RoleID)
	if err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, "failed to get role")
		return
	}
	if !found {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "role not found")
		return
	}

	// Create a new session
	sessionID := uuid.Must(uuid.NewV7()).String()
	if _, err := wt.SessionStore.Create(ctx, sessionID); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, "failed to create session")
		return
	}

	// Update session title to match ticket
	if err := wt.SessionStore.Update(ctx, sessionID, tk.Title); err != nil {
		h.log.Warn("failed to set session title", "error", err)
	}

	// Update ticket with session ID and status
	inProgress := ticket.TicketStatusInProgress
	_, err = h.worktreeManager.TicketStore.Update(ctx, params.TicketID, ticket.TicketUpdate{
		Status:    &inProgress,
		SessionID: &sessionID,
	})
	if err != nil {
		h.log.Warn("failed to update ticket status", "error", err)
	}

	// Send the initial message with custom system prompt
	initialMessage := tk.Description
	if initialMessage == "" {
		initialMessage = tk.Title
	}
	procOpts := process.ProcessOptions{
		Mode:         session.ModeYolo,
		SystemPrompt: buildTicketSystemPrompt(tk.ID, role.SystemPrompt),
	}
	if err := wt.ChatClient.SendMessageWithOptions(ctx, sessionID, initialMessage, procOpts); err != nil {
		h.log.Error("failed to send initial message", "error", err)
		// Don't fail the request - session is created, user can send message manually
	}

	h.log.Info("ticket started", "ticketId", params.TicketID, "sessionId", sessionID)

	result := rpc.TicketStartResult{SessionID: sessionID}
	if err := conn.Reply(ctx, req.ID, result); err != nil {
		h.log.Error("failed to send ticket start response", "error", err)
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

// buildTicketSystemPrompt combines Pockode's fixed prompt with the role's custom prompt.
// The fixed prompt instructs the agent to update ticket status when work is complete.
func buildTicketSystemPrompt(ticketID string, rolePrompt string) string {
	const template = `You are working on ticket: %s

When you have completed all tasks for this ticket, update its status to done using the ticket_update tool with status: "done".
`
	pockodePrompt := fmt.Sprintf(template, ticketID)
	if rolePrompt == "" {
		return pockodePrompt
	}
	return pockodePrompt + rolePrompt
}
