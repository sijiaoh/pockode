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
	// fields of an object one. Both are here for question_post, whose questions
	// and their options are lists of objects — the first tool arguments in
	// Pockode that are not scalars, and a model given a bare "array" would have
	// to guess the shape of.
	Items      *propertySchema           `json:"items,omitempty"`
	Properties map[string]propertySchema `json:"properties,omitempty"`
	Required   []string                  `json:"required,omitempty"`
}

var toolDefinitions = []toolDefinition{
	{
		Name:        "story_list",
		Description: "List the stories in this project. A story is a top-level work item; its tasks are listed separately with task_list. Each item is a summary and does not include the body. Call work_get with an item's id to read its body. An item's status is one of: open (never started), active (Pockode is driving it), stopped (handed back to a person; no agent runs for it), closed (finished). A story this chat is watching (see story_start's watch) carries watched: true; the field is absent on every other story, including one watched by another chat.",
		InputSchema: inputSchema{
			Type:       "object",
			Properties: map[string]propertySchema{},
		},
	},
	{
		Name:        "task_list",
		Description: "List the tasks of one story. Each item is a summary and does not include the body. Call work_get with an item's id to read its body. An item's status is one of: open (never started), active (Pockode is driving it), stopped (handed back to a person; no agent runs for it), closed (finished).",
		InputSchema: inputSchema{
			Type: "object",
			Properties: map[string]propertySchema{
				"story_id": {Type: "string", Description: "The story whose tasks to list"},
			},
			Required: []string{"story_id"},
		},
	},
	{
		Name:        "story_create",
		Description: "Create a story: a top-level piece of work, which can be broken into tasks with task_create.",
		InputSchema: inputSchema{
			Type: "object",
			Properties: map[string]propertySchema{
				"title":         {Type: "string", Description: "Title of the story"},
				"body":          {Type: "string", Description: "Detailed description or instructions for the story"},
				"agent_role_id": {Type: "string", Description: "Agent role ID (required). The role must take stories: agent_role_list with work_type \"story\" lists those"},
			},
			Required: []string{"title", "agent_role_id"},
		},
	},
	{
		Name:        "task_create",
		Description: "Create a task under a story. A task is the second and last level: it cannot have tasks of its own, and it runs in the worktree of the story it belongs to.",
		InputSchema: inputSchema{
			Type: "object",
			Properties: map[string]propertySchema{
				"story_id":      {Type: "string", Description: "The story this task belongs to"},
				"title":         {Type: "string", Description: "Title of the task"},
				"body":          {Type: "string", Description: "Detailed description or instructions for the task"},
				"agent_role_id": {Type: "string", Description: "Agent role ID (required). The role must take tasks: agent_role_list with work_type \"task\" lists those"},
			},
			Required: []string{"story_id", "title", "agent_role_id"},
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
				"agent_role_id": {Type: "string", Description: "New agent role ID. A new role must take this work item's type (see agent_role_list's work_type)"},
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
		Name:        "story_start",
		Description: "Start a story: launches an agent session and moves it to active, which is the only status Pockode drives. A story that already has a session is restarted in it and keeps its chat history.",
		InputSchema: inputSchema{
			Type: "object",
			Properties: map[string]propertySchema{
				"id":       {Type: "string", Description: "Story ID to start"},
				"worktree": {Type: "string", Description: "Name of the git worktree to run this story in, created (with a branch of the same name) if it does not exist yet. Omit it to run in the worktree the story is already assigned to (the main one, unless it was set elsewhere). Only in a git repository: outside one there are no worktrees, so omit it."},
				"watch":    {Type: "boolean", Description: "Set true to watch the story from this chat: Pockode sends a message here — starting a turn if this chat is idle — when the story closes, when it is stopped (handed back to a person), and when the story itself posts a question, which you may answer with question_answer. Its tasks' questions, starts and closings are not reported. The watch lasts until the story closes — through stops and restarts, but not past the close, so a story closed and reopened is unwatched until a later start with watch — or until this chat lets go of it with story_unwatch, and a story has one watcher, so a later start with watch moves it to whoever made that call. Omit it to start the story without changing who is watching it."},
			},
			Required: []string{"id"},
		},
	},
	{
		Name:        "story_unwatch",
		Description: "Stop watching a story from this chat: Pockode no longer sends a message here when it closes, is stopped, or posts a question. The story itself is not touched — it keeps running, with its status, steps and tasks as they were. Only this chat's own watch is released: a story watched by another chat, or by nobody, is left as it is, and the result says which. A story stops being watched by itself when it closes, so there is no need to call this for a story that has finished.",
		InputSchema: inputSchema{
			Type: "object",
			Properties: map[string]propertySchema{
				"id": {Type: "string", Description: "Story ID to stop watching"},
			},
			Required: []string{"id"},
		},
	},
	{
		// The worktree argument is the whole reason this is a tool of its own:
		// a task runs where its story runs, so there is nothing for it to
		// choose, and a schema without the argument says so without the agent
		// having to read a sentence about it.
		Name:        "task_start",
		Description: "Start a task: launches an agent session and moves it to active, which is the only status Pockode drives. A task that already has a session is restarted in it and keeps its chat history. It runs in the worktree of the story it belongs to, which is why there is nothing to choose here.",
		InputSchema: inputSchema{
			Type: "object",
			Properties: map[string]propertySchema{
				"id": {Type: "string", Description: "Task ID to start"},
			},
			Required: []string{"id"},
		},
	},
	{
		Name:        "work_reopen",
		Description: "Reopen a closed work item, story or task alike: moves it from closed back to active and resumes its session. Use when there is more to do on something that was finished — on a story, that includes giving it further tasks.",
		InputSchema: inputSchema{
			Type: "object",
			Properties: map[string]propertySchema{
				"id": {Type: "string", Description: "Work item ID to reopen"},
			},
			Required: []string{"id"},
		},
	},
	{
		Name:        "story_wait",
		Description: "Record that this story is waiting for its tasks, and end your turn. The story stays active and Pockode stops nudging it; when a task closes, Pockode messages you with the news and clears the wait — so if other tasks are still running and you still have nothing to do, call this again. Only a story has tasks, which is why only a story can wait for them. Rejected when none of the story's tasks is running — a task closing is the only thing that ends this wait, so with none running nothing would ever end it; start them first. This is not how you wait for a person: ask them with question_post, which does not end anything.",
		InputSchema: inputSchema{
			Type: "object",
			Properties: map[string]propertySchema{
				"id": {Type: "string", Description: "Story ID to wait"},
			},
			Required: []string{"id"},
		},
	},
	{
		Name:        "step_done",
		Description: "Mark the current step as complete, or the whole work when your agent role defines no steps: the work advances to the next step while steps remain, and otherwise closes. Do not use it to pause — story_wait is how a story waits for its tasks, and a step_done that would close a story with active subtasks is rejected. Completing a step withdraws any questions you posted during it: the step is over, so their answers would arrive for work you have already finished.",
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
		Name: "agent_role_list",
		Description: "List all available agent roles. Use this to find which roles can be assigned to work items. " +
			"A role's work_type says which kind of work item it takes (story or task); a role without one takes either. " +
			"Use agent_role_get for full details including role_prompt.",
		InputSchema: inputSchema{
			Type: "object",
			Properties: map[string]propertySchema{
				"work_type": {Type: "string", Enum: []string{"story", "task"}, Description: "Only list roles that can take this kind of work item, including roles that take either"},
			},
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
		Description: "Ask the user questions and keep working. The call returns immediately with a request id for each question; it does not wait for an answer. " +
			"Each answer — or the user's refusal to answer — arrives later as an ordinary message in this chat, in a turn of its own, possibly long after this turn has ended. Do not wait for it here, and do not ask again because nothing came back. " +
			"Meanwhile, carry on with whatever does not depend on the answers, or end your turn. " +
			"The user may also simply reply in the chat instead; if their message answers a question, treat it as answered and call question_cancel to take its card down.\n\n" +
			"How to ask: the user reads the questions in a panel that covers the conversation, often on a phone and long after you asked, so each question must make sense on its own and carry the context it needs. " +
			"When the answer is one of a known set, offer options; when the set is large or open-ended, ask for free text. " +
			"Never add an \"Other\" option: the user always has their own input box and can decline to answer. " +
			"Use multi_select when more than one option can apply. " +
			"If you would choose one option yourself, mark it recommended and put it first; the user sees it flagged, and it is not picked for them. A single-choice question may recommend at most one option.",
		InputSchema: inputSchema{
			Type: "object",
			Properties: map[string]propertySchema{
				"questions": {
					Type:        "array",
					Description: "The questions to ask, in the order the user should read them. Each is answered, declined or withdrawn on its own.",
					Items: &propertySchema{
						Type: "object",
						Properties: map[string]propertySchema{
							"question": {Type: "string", Description: "The question, in full, as the user will read it: understandable on its own, with the context needed to decide. Distinct from every other question in the call."},
							"header":   {Type: "string", Description: "A word or two naming the question, shown as its title."},
							"options": {
								Type:        "array",
								Description: "The answers offered, when the answer is one of a known set. Omit it to ask for free text.",
								Items: &propertySchema{
									Type: "object",
									Properties: map[string]propertySchema{
										"label":       {Type: "string", Description: "The option as the user picks it, and the answer you get back verbatim — keep it short. Must be unique within the question."},
										"description": {Type: "string", Description: "What choosing this option means — its consequence or trade-off — rather than a restatement of the label."},
										"recommended": {Type: "boolean", Description: "This is the option you would choose. Put it first. At most one per question unless multi_select. Mark it here rather than writing \"(Recommended)\" into the label: the label is the answer you get back."},
									},
									Required: []string{"label"},
								},
							},
							"multi_select": {Type: "boolean", Description: "Allow more than one option to be picked. Only meaningful with options."},
						},
						Required: []string{"question", "header"},
					},
				},
			},
			Required: []string{"questions"},
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
				"note":       {Type: "string", Description: "A remark beside the options you picked (and, on a multi-select question, the text beside them), for what the labels alone cannot say (\"Postgres, but pin it to 16\"). It reaches the asking agent marked as a note, not as part of the answer. Refused on a question that offered no options and on a single-select question answered with text, where the answer is already in your own words — say everything there instead."},
				"session_id": {Type: "string", Description: "The session the question is waiting in. A question is the pair (session_id, request_id), not the request id alone: a fork copies the questions it inherits with their ids unchanged, so one id can be waiting in two sessions at once, both still asking. It may be left out while the id is waiting in one session only — that one is answered. When more than one is, the call is refused and lists the candidates with the work each is running; call again naming the one you mean. Nothing picks for you, because answering the other leaves the question you meant still waiting."},
			},
			Required: []string{"request_id"},
		},
	},
	{
		Name: "question_cancel",
		Description: "Withdraw a question you posted with question_post, because you no longer need the answer — you worked it out, or the user already answered it in the chat. " +
			"The card stops asking and nothing is sent to anyone. A question that has already been answered, declined or withdrawn cannot be withdrawn again, and the error says what became of it. " +
			"It withdraws the copy in your own session, which is the only one it can: a fork carries an unanswered question into the new session with its id unchanged, and that copy belongs to that session's agent.",
		InputSchema: inputSchema{
			Type: "object",
			Properties: map[string]propertySchema{
				"request_id": {Type: "string", Description: "The request id question_post returned."},
			},
			Required: []string{"request_id"},
		},
	},
}
