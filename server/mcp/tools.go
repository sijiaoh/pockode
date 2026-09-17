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
		Description: "List work items (stories and tasks), optionally filtered by parent_id. Each item is a summary and does not include the body. Call work_get with an item's id to read its body. An item's status is one of: open (never started), active (Pockode is driving it), stopped (handed back to a person; no agent runs for it), closed (finished).",
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
		Description: "Delete a work item. If the item is a story, all its child tasks are also deleted, and the agent sessions of everything deleted go with them.",
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
		Description: "Start a work item: launches an agent session and moves the item to active, which is the only status Pockode drives. A work item that already has a session is restarted in it and keeps its chat history.",
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
		Description: "Record that this work needs something from the user, and end your turn. The work stays active and Pockode stops nudging it; the user's answer, whenever it comes, puts it back to active and wakes you with what they said. Prefer this over asking a blocking question in the chat (AskUserQuestion) for anything you may be waiting on for more than a moment: a chat question holds this agent process open, and if it goes unanswered long enough Pockode cancels it and the ended turn stops the work.",
		InputSchema: inputSchema{
			Type: "object",
			Properties: map[string]propertySchema{
				"id":     {Type: "string", Description: "Work item ID"},
				"reason": {Type: "string", Description: "What you need from the user. Shown to them on the work's detail page — it is the only place they can read what you are waiting for, so write it for them."},
			},
			Required: []string{"id", "reason"},
		},
	},
	{
		Name:        "work_reopen",
		Description: "Reopen a closed work item: moves it from closed back to active and resumes its session. Use when you need to add more child work items or continue working on an item that was finished.",
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
		Description: "Record that this work is waiting for its child tasks, and end your turn. The work stays active and Pockode stops nudging it; when a child closes, Pockode messages you with the news and clears the wait — so if other children are still running and you still have nothing to do, call this again. Only a story has children; a task waiting on a person wants work_needs_input instead. Rejected when none of the work's subtasks is running — a subtask closing is the only thing that ends this wait, so with none running nothing would ever end it; start them first, or use work_needs_input.",
		InputSchema: inputSchema{
			Type: "object",
			Properties: map[string]propertySchema{
				"id": {Type: "string", Description: "Work item ID to wait"},
				// Optional, and the same field work_needs_input fills in: the two
				// are one wait with two people clearing it.
				"reason": {Type: "string", Description: "What you are waiting for. Shown to the user on the work's detail page — it is the only place they can read why this work is paused."},
			},
			Required: []string{"id"},
		},
	},
	{
		Name:        "step_done",
		Description: "Mark the current step as complete, or the whole work when your agent role defines no steps: the work advances to the next step while steps remain, and otherwise closes. Do not use it to pause — work_wait (children) and work_needs_input (the user) are the ways to wait, and a step_done that would close a story with active subtasks is rejected.",
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
