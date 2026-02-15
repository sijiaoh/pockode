package mcp

import "github.com/mark3labs/mcp-go/mcp"

func (s *Server) registerTools() {
	// Read operations
	s.mcpServer.AddTool(ticketListTool(), s.handleTicketList)
	s.mcpServer.AddTool(ticketGetTool(), s.handleTicketGet)
	s.mcpServer.AddTool(roleListTool(), s.handleRoleList)

	// Write operations
	s.mcpServer.AddTool(ticketCreateTool(), s.handleTicketCreate)
	s.mcpServer.AddTool(ticketUpdateTool(), s.handleTicketUpdate)
	s.mcpServer.AddTool(ticketDeleteTool(), s.handleTicketDelete)
}

func ticketListTool() mcp.Tool {
	return mcp.NewTool("ticket_list",
		mcp.WithDescription("List all tickets. Open tickets are sorted by priority ascending (lower = higher priority), others by updated_at descending."),
	)
}

func ticketGetTool() mcp.Tool {
	return mcp.NewTool("ticket_get",
		mcp.WithDescription("Get a single ticket by ID. Returns full ticket details including description."),
		mcp.WithString("ticket_id", mcp.Required(),
			mcp.Description("The ticket ID to retrieve")),
	)
}

func ticketCreateTool() mcp.Tool {
	return mcp.NewTool("ticket_create",
		mcp.WithDescription("Create a new ticket. Use role_list first to get valid role_id values."),
		mcp.WithString("title", mcp.Required(),
			mcp.Description("Short task title")),
		mcp.WithString("description",
			mcp.Description("Detailed instructions for the agent")),
		mcp.WithString("role_id", mcp.Required(),
			mcp.Description("Agent role ID from role_list")),
		mcp.WithString("parent_id",
			mcp.Description("Parent ticket ID for sub-tasks")),
		mcp.WithNumber("priority",
			mcp.Description("Priority order (lower = higher priority). Auto-assigned if omitted.")),
	)
}

func ticketUpdateTool() mcp.Tool {
	return mcp.NewTool("ticket_update",
		mcp.WithDescription("Update a ticket. Only provided fields are modified."),
		mcp.WithString("ticket_id", mcp.Required(),
			mcp.Description("Ticket ID to update")),
		mcp.WithString("title",
			mcp.Description("New title")),
		mcp.WithString("description",
			mcp.Description("New description")),
		mcp.WithString("status",
			mcp.Enum("open", "in_progress", "done"),
			mcp.Description("New status")),
		mcp.WithNumber("priority",
			mcp.Description("Priority order (lower = higher priority)")),
	)
}

func ticketDeleteTool() mcp.Tool {
	return mcp.NewTool("ticket_delete",
		mcp.WithDescription("Delete a ticket permanently."),
		mcp.WithString("ticket_id", mcp.Required(),
			mcp.Description("Ticket ID to delete")),
	)
}

func roleListTool() mcp.Tool {
	return mcp.NewTool("role_list",
		mcp.WithDescription("List all available agent roles with their system prompts."),
	)
}
