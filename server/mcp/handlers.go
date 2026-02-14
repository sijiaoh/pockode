package mcp

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/pockode/server/ticket"
)

func (s *Server) handleTicketList(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	tickets, err := s.ticketStore.List()
	if err != nil {
		return InternalError(err), nil
	}
	return jsonResult(tickets)
}

func (s *Server) handleTicketGet(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	id, err := req.RequireString("ticket_id")
	if err != nil {
		return ValidationError("ticket_id is required"), nil
	}

	t, found, err := s.ticketStore.Get(id)
	if err != nil {
		return InternalError(err), nil
	}
	if !found {
		return NotFound("ticket", id), nil
	}
	return jsonResult(t)
}

func (s *Server) handleTicketCreate(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	title, err := req.RequireString("title")
	if err != nil {
		return ValidationError("title is required"), nil
	}
	roleID, err := req.RequireString("role_id")
	if err != nil {
		return ValidationError("role_id is required"), nil
	}

	// Validate role exists
	if _, found, _ := s.roleStore.Get(roleID); !found {
		return NotFound("role", roleID), nil
	}

	desc := req.GetString("description", "")
	parentID := req.GetString("parent_id", "")

	t, err := s.ticketStore.Create(ctx, parentID, title, desc, roleID)
	if err != nil {
		return InternalError(err), nil
	}
	return jsonResult(t)
}

func (s *Server) handleTicketUpdate(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	id, err := req.RequireString("ticket_id")
	if err != nil {
		return ValidationError("ticket_id is required"), nil
	}

	updates := ticket.TicketUpdate{}
	if v := req.GetString("title", ""); v != "" {
		updates.Title = &v
	}
	if v := req.GetString("description", ""); v != "" {
		updates.Description = &v
	}
	if v := req.GetString("status", ""); v != "" {
		status := ticket.TicketStatus(v)
		updates.Status = &status
	}

	t, err := s.ticketStore.Update(ctx, id, updates)
	if errors.Is(err, ticket.ErrTicketNotFound) {
		return NotFound("ticket", id), nil
	}
	if err != nil {
		return InternalError(err), nil
	}
	return jsonResult(t)
}

func (s *Server) handleTicketDelete(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	id, err := req.RequireString("ticket_id")
	if err != nil {
		return ValidationError("ticket_id is required"), nil
	}

	if err := s.ticketStore.Delete(ctx, id); errors.Is(err, ticket.ErrTicketNotFound) {
		return NotFound("ticket", id), nil
	} else if err != nil {
		return InternalError(err), nil
	}
	return mcp.NewToolResultText(`{"success":true}`), nil
}

func (s *Server) handleRoleList(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	roles, err := s.roleStore.List()
	if err != nil {
		return InternalError(err), nil
	}
	return jsonResult(roles)
}

func jsonResult(v any) (*mcp.CallToolResult, error) {
	data, _ := json.MarshalIndent(v, "", "  ")
	return mcp.NewToolResultText(string(data)), nil
}
