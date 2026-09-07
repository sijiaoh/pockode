package mcp

// This file holds the static MCP tool definitions advertised via tools/list.
// The actual tool logic lives in executor.go and runs inside the main server;
// the stdio process is a thin proxy (see server.go / client.go).

type toolDefinition struct {
	Name        string      `json:"name"`
	Description string      `json:"description"`
	InputSchema inputSchema `json:"inputSchema"`
}

type inputSchema struct {
	Type       string                    `json:"type"`
	Properties map[string]propertySchema `json:"properties,omitempty"`
	Required   []string                  `json:"required,omitempty"`
}

type propertySchema struct {
	Type        string   `json:"type"`
	Description string   `json:"description,omitempty"`
	Enum        []string `json:"enum,omitempty"`
}

var toolDefinitions = []toolDefinition{
	{
		Name:        "work_list",
		Description: "List work items (stories and tasks). Returns all work items, optionally filtered by parent_id.",
		InputSchema: inputSchema{
			Type: "object",
			Properties: map[string]propertySchema{
				"parent_id": {Type: "string", Description: "Filter by parent work ID"},
			},
		},
	},
	{
		Name:        "work_create",
		Description: "Create a new work item (story or task). Stories are top-level; tasks must have a story parent.",
		InputSchema: inputSchema{
			Type: "object",
			Properties: map[string]propertySchema{
				"type":          {Type: "string", Description: "Work type", Enum: []string{"story", "task"}},
				"parent_id":     {Type: "string", Description: "Parent work ID (required for tasks)"},
				"title":         {Type: "string", Description: "Title of the work item"},
				"body":          {Type: "string", Description: "Detailed description or instructions for the work item"},
				"agent_role_id": {Type: "string", Description: "Agent role ID (required)"},
			},
			Required: []string{"type", "title", "agent_role_id"},
		},
	},
	{
		Name:        "work_update",
		Description: "Update a work item's title, body, or agent role.",
		InputSchema: inputSchema{
			Type: "object",
			Properties: map[string]propertySchema{
				"id":            {Type: "string", Description: "Work item ID"},
				"title":         {Type: "string", Description: "New title"},
				"body":          {Type: "string", Description: "New body content"},
				"agent_role_id": {Type: "string", Description: "New agent role ID"},
			},
			Required: []string{"id"},
		},
	},
	{
		Name:        "work_get",
		Description: "Get a single work item by ID with full details including body.",
		InputSchema: inputSchema{
			Type: "object",
			Properties: map[string]propertySchema{
				"id": {Type: "string", Description: "Work item ID"},
			},
			Required: []string{"id"},
		},
	},
	{
		Name:        "work_delete",
		Description: "Delete a work item. If the item is a story, all its child tasks are also deleted.",
		InputSchema: inputSchema{
			Type: "object",
			Properties: map[string]propertySchema{
				"id": {Type: "string", Description: "Work item ID to delete"},
			},
			Required: []string{"id"},
		},
	},
	{
		Name:        "work_start",
		Description: "Start a work item. Transitions it from open (or stopped) to in_progress and launches an agent session.",
		InputSchema: inputSchema{
			Type: "object",
			Properties: map[string]propertySchema{
				"id": {Type: "string", Description: "Work item ID to start"},
			},
			Required: []string{"id"},
		},
	},
	{
		Name:        "work_needs_input",
		Description: "Pause a work item to wait for user input. Transitions from in_progress to needs_input. Use when the agent needs user confirmation or clarification before continuing.",
		InputSchema: inputSchema{
			Type: "object",
			Properties: map[string]propertySchema{
				"id":     {Type: "string", Description: "Work item ID"},
				"reason": {Type: "string", Description: "Why user input is needed (shown to the user)"},
			},
			Required: []string{"id", "reason"},
		},
	},
	{
		Name:        "work_reopen",
		Description: "Reopen a closed work item. Transitions from closed to in_progress. Use when you need to add more child work items or continue working on a completed item.",
		InputSchema: inputSchema{
			Type: "object",
			Properties: map[string]propertySchema{
				"id": {Type: "string", Description: "Work item ID to reopen"},
			},
			Required: []string{"id"},
		},
	},
	{
		Name:        "work_wait",
		Description: "Pause a work item to wait for child work to complete. Transitions from in_progress to waiting. Use when the agent has started child tasks and needs to wait for them to finish before continuing.",
		InputSchema: inputSchema{
			Type: "object",
			Properties: map[string]propertySchema{
				"id": {Type: "string", Description: "Work item ID to wait"},
			},
			Required: []string{"id"},
		},
	},
	{
		Name:        "step_done",
		Description: "Mark current work progress as complete. The work item must be in_progress status. Work items advance CurrentStep when more steps remain, otherwise close. Use work_wait, not step_done, to wait for child work.",
		InputSchema: inputSchema{
			Type: "object",
			Properties: map[string]propertySchema{
				"id": {Type: "string", Description: "Work item ID"},
			},
			Required: []string{"id"},
		},
	},
	{
		Name:        "work_comment_add",
		Description: "Add a comment to a work item. Use this to report progress, results, or notes.",
		InputSchema: inputSchema{
			Type: "object",
			Properties: map[string]propertySchema{
				"work_id": {Type: "string", Description: "Work item ID to comment on"},
				"body":    {Type: "string", Description: "Comment text"},
			},
			Required: []string{"work_id", "body"},
		},
	},
	{
		Name:        "work_comment_list",
		Description: "List comments on a work item.",
		InputSchema: inputSchema{
			Type: "object",
			Properties: map[string]propertySchema{
				"work_id": {Type: "string", Description: "Work item ID"},
			},
			Required: []string{"work_id"},
		},
	},
	{
		Name:        "work_comment_update",
		Description: "Update a comment's body text.",
		InputSchema: inputSchema{
			Type: "object",
			Properties: map[string]propertySchema{
				"id":   {Type: "string", Description: "Comment ID"},
				"body": {Type: "string", Description: "New comment text"},
			},
			Required: []string{"id", "body"},
		},
	},
	{
		Name:        "agent_role_list",
		Description: "List all available agent roles. Use this to find which roles can be assigned to work items. Use agent_role_get for full details including role_prompt.",
		InputSchema: inputSchema{
			Type:       "object",
			Properties: map[string]propertySchema{},
		},
	},
	{
		Name:        "agent_role_get",
		Description: "Get a single agent role by ID with full details including role_prompt.",
		InputSchema: inputSchema{
			Type: "object",
			Properties: map[string]propertySchema{
				"id": {Type: "string", Description: "Agent role ID"},
			},
			Required: []string{"id"},
		},
	},
	{
		Name:        "agent_role_reset_defaults",
		Description: "Reset all agent roles to their default values. This deletes all existing roles and recreates the defaults.",
		InputSchema: inputSchema{
			Type:       "object",
			Properties: map[string]propertySchema{},
		},
	},
}
