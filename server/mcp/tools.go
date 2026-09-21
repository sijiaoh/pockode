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
	// Items describes the elements of an array property, and Properties the
	// fields of an object one. Both are here for question_post's options, which
	// is a list of objects — the first tool argument in Pockode that is not a
	// scalar, and a model given a bare "array" would have to guess the shape of.
	Items      *propertySchema           `json:"items,omitempty"`
	Properties map[string]propertySchema `json:"properties,omitempty"`
	Required   []string                  `json:"required,omitempty"`
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
				"id":       {Type: "string", Description: "Work item ID to start"},
				"worktree": {Type: "string", Description: "Name of the git worktree to run this story in, created (with a branch of the same name) if it does not exist yet. Only a story takes this: a task always runs in the worktree of the story it belongs to. Omit it to run in the worktree the story is already assigned to (the main one, unless it was set elsewhere)."},
			},
			Required: []string{"id"},
		},
	},
	{
		// Retired: it is answered with an error naming question_post, and the
		// entry is kept only so that an agent mid-conversation with the old
		// lifecycle rules in its context gets that sentence instead of "unknown
		// tool". It goes for good once nothing can still be holding those rules.
		//
		// The old input schema is kept with it, unread though it is. An agent
		// carrying those rules will send `id` and `reason`, and a schema that no
		// longer accepted them could have its call refused by the CLI before the
		// sentence below ever reached the model — which is the one thing this
		// entry exists to prevent.
		Name:        "work_needs_input",
		Description: "Retired — use question_post instead. Ask the user the question itself: question_post returns immediately, you can carry on working, and their answer arrives as a message in this chat.",
		InputSchema: inputSchema{
			Type: "object",
			Properties: map[string]propertySchema{
				"id":     {Type: "string", Description: "Work item ID"},
				"reason": {Type: "string", Description: "What you need from the user."},
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
		Description: "Record that this work is waiting for its child tasks, and end your turn. The work stays active and Pockode stops nudging it; when a child closes, Pockode messages you with the news and clears the wait — so if other children are still running and you still have nothing to do, call this again. Only a story has children. Rejected when none of the work's subtasks is running — a subtask closing is the only thing that ends this wait, so with none running nothing would ever end it; start them first. This is not how you wait for a person: ask them with question_post, which does not end anything.",
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
		Description: "Mark the current step as complete, or the whole work when your agent role defines no steps: the work advances to the next step while steps remain, and otherwise closes. Do not use it to pause — work_wait is how a story waits for its subtasks, and a step_done that would close a story with active subtasks is rejected. Completing a step withdraws any questions you posted during it: the step is over, so their answers would arrive for work you have already finished.",
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
	{
		Name: "question_post",
		Description: "Ask the user one question and keep working. The call returns immediately with a request id; it does not wait for an answer. " +
			"The answer — or the user's refusal to answer — arrives later as an ordinary message in this chat, in a turn of its own, possibly long after this turn has ended. Do not wait for it here, and do not ask again because nothing came back. " +
			"The user may also simply reply in the chat instead of using the question card; if their message answers the question, treat it as answered and call question_cancel to take the card down. " +
			"Post one question per call: each gets its own request id, which is what lets the user answer one and decline another. " +
			"This is the only way to ask. Your CLI's own ask-the-user tool does not reach the user here — Pockode refuses it and tells you to come back to this one — so a question asked that way is a turn spent for nothing.",
		InputSchema: inputSchema{
			Type: "object",
			Properties: map[string]propertySchema{
				"question": {Type: "string", Description: "The question, in full, as the user will read it."},
				"header":   {Type: "string", Description: "A short label for the question (a few words), shown as the card's title."},
				"options": {
					Type:        "array",
					Description: "The answers offered. Omit it to ask for free text.",
					Items: &propertySchema{
						Type: "object",
						Properties: map[string]propertySchema{
							"label":       {Type: "string", Description: "The option as the user picks it. Must be unique within the question."},
							"description": {Type: "string", Description: "What choosing it means, if that is not obvious from the label."},
						},
						Required: []string{"label"},
					},
				},
				"multi_select": {Type: "boolean", Description: "Allow more than one option to be picked. Only meaningful with options."},
			},
			Required: []string{"question", "header"},
		},
	},
	{
		Name: "question_answer",
		Description: "Answer a question another agent posted with question_post, when you know the answer it is waiting for. " +
			"You may answer any question but one of your own — withdraw those with question_cancel instead. " +
			"The asking agent is told the answer came from you and not from the user, and the question stops waiting for anyone. " +
			"If you do not know the answer, do not guess: ask the user yourself with question_post. " +
			"The call returns once the answer has reached the asking agent, which can take a moment if its process had been shut down in the meantime.",
		InputSchema: inputSchema{
			Type: "object",
			Properties: map[string]propertySchema{
				"request_id": {Type: "string", Description: "The request id of the question being answered."},
				"answers": {
					Type:        "array",
					Description: "The labels of the options you are picking, exactly as the question offered them. Leave it out for a question that offered no options.",
					Items:       &propertySchema{Type: "string"},
				},
				"text":       {Type: "string", Description: "The answer in your own words. This is the whole answer to a question that offered no options; beside options it is the \"other\" answer, and only a multi-select question takes it together with a label."},
				"session_id": {Type: "string", Description: "The session whose question this is. Needed only when the same question is open in more than one session, which the error will tell you."},
			},
			Required: []string{"request_id"},
		},
	},
	{
		Name: "question_cancel",
		Description: "Withdraw a question you posted with question_post, because you no longer need the answer — you worked it out, or the user already answered it in the chat. " +
			"The card stops asking and nothing is sent to anyone. A question that has already been answered, declined or withdrawn cannot be withdrawn again, and the error says what became of it.",
		InputSchema: inputSchema{
			Type: "object",
			Properties: map[string]propertySchema{
				"request_id": {Type: "string", Description: "The request id question_post returned."},
			},
			Required: []string{"request_id"},
		},
	},
}
