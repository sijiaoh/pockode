package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/pockode/server/work"
)

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
		Name:        "work_done",
		Description: "Mark a work item as done. If the item is still open (not yet in_progress), it will be automatically transitioned.",
		InputSchema: inputSchema{
			Type: "object",
			Properties: map[string]propertySchema{
				"id": {Type: "string", Description: "Work item ID to mark as done"},
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

type toolHandler func(ctx context.Context, args json.RawMessage) (string, error)

func (s *Server) getToolHandler(name string) (toolHandler, bool) {
	switch name {
	case "work_list":
		return s.handleWorkList, true
	case "work_create":
		return s.handleWorkCreate, true
	case "work_update":
		return s.handleWorkUpdate, true
	case "work_get":
		return s.handleWorkGet, true
	case "work_delete":
		return s.handleWorkDelete, true
	case "work_done":
		return s.handleWorkDone, true
	case "work_start":
		return s.handleWorkStart, true
	case "work_needs_input":
		return s.handleWorkNeedsInput, true
	case "work_comment_add":
		return s.handleWorkCommentAdd, true
	case "work_comment_list":
		return s.handleWorkCommentList, true
	case "agent_role_list":
		return s.handleAgentRoleList, true
	case "agent_role_get":
		return s.handleAgentRoleGet, true
	case "agent_role_reset_defaults":
		return s.handleAgentRoleResetDefaults, true
	default:
		return nil, false
	}
}

func (s *Server) handleWorkList(ctx context.Context, args json.RawMessage) (string, error) {
	var params struct {
		ParentID string `json:"parent_id"`
	}
	if len(args) > 0 {
		if err := json.Unmarshal(args, &params); err != nil {
			return "", fmt.Errorf("invalid arguments: %w", err)
		}
	}

	works, err := s.store.List()
	if err != nil {
		return "", err
	}

	if params.ParentID != "" {
		var filtered []work.Work
		for _, w := range works {
			if w.ParentID == params.ParentID {
				filtered = append(filtered, w)
			}
		}
		works = filtered
	}

	// Always return JSON array for consistent parsing by the AI agent.
	// Formatted text would risk prompt injection via user-supplied titles.
	type workItem struct {
		ID          string `json:"id"`
		Type        string `json:"type"`
		ParentID    string `json:"parent_id,omitempty"`
		AgentRoleID string `json:"agent_role_id,omitempty"`
		Status      string `json:"status"`
		Title       string `json:"title"`
	}
	items := make([]workItem, len(works))
	for i, w := range works {
		items[i] = workItem{
			ID:          w.ID,
			Type:        string(w.Type),
			ParentID:    w.ParentID,
			AgentRoleID: w.AgentRoleID,
			Status:      string(w.Status),
			Title:       w.Title,
		}
	}
	b, err := json.Marshal(items)
	if err != nil {
		return "", fmt.Errorf("marshal work list: %w", err)
	}
	return string(b), nil
}

func (s *Server) handleWorkCreate(ctx context.Context, args json.RawMessage) (string, error) {
	var params struct {
		Type        work.WorkType `json:"type"`
		ParentID    string        `json:"parent_id"`
		Title       string        `json:"title"`
		Body        string        `json:"body"`
		AgentRoleID string        `json:"agent_role_id"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return "", fmt.Errorf("invalid arguments: %w", err)
	}

	// Validate agent_role_id is provided and exists
	if params.AgentRoleID == "" {
		return "", fmt.Errorf("agent_role_id is required")
	}
	if _, found, err := s.agentRoleStore.Get(params.AgentRoleID); err != nil {
		return "", fmt.Errorf("failed to validate agent role: %w", err)
	} else if !found {
		return "", fmt.Errorf("agent role %q not found", params.AgentRoleID)
	}

	created, err := s.store.Create(ctx, work.Work{
		Type:        params.Type,
		ParentID:    params.ParentID,
		Title:       params.Title,
		Body:        params.Body,
		AgentRoleID: params.AgentRoleID,
	})
	if err != nil {
		return "", err
	}

	return fmt.Sprintf("Created %s %q (ID: %s)", created.Type, created.Title, created.ID), nil
}

func (s *Server) handleWorkUpdate(ctx context.Context, args json.RawMessage) (string, error) {
	var params struct {
		ID          string  `json:"id"`
		Title       *string `json:"title"`
		Body        *string `json:"body"`
		AgentRoleID *string `json:"agent_role_id"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return "", fmt.Errorf("invalid arguments: %w", err)
	}

	// Validate agent_role_id exists if specified
	if params.AgentRoleID != nil && *params.AgentRoleID != "" {
		if _, found, err := s.agentRoleStore.Get(*params.AgentRoleID); err != nil {
			return "", fmt.Errorf("failed to validate agent role: %w", err)
		} else if !found {
			return "", fmt.Errorf("agent role %q not found", *params.AgentRoleID)
		}
	}

	fields := work.UpdateFields{
		Title:       params.Title,
		Body:        params.Body,
		AgentRoleID: params.AgentRoleID,
	}
	if err := s.store.Update(ctx, params.ID, fields); err != nil {
		return "", err
	}

	var parts []string
	if params.Title != nil {
		parts = append(parts, fmt.Sprintf("title to %q", *params.Title))
	}
	if params.Body != nil {
		parts = append(parts, "body")
	}
	if params.AgentRoleID != nil {
		parts = append(parts, "agent_role_id")
	}
	if len(parts) == 0 {
		return fmt.Sprintf("Updated work %s (no fields changed)", params.ID), nil
	}
	return fmt.Sprintf("Updated work %s %s", params.ID, strings.Join(parts, " and ")), nil
}

func (s *Server) handleWorkGet(_ context.Context, args json.RawMessage) (string, error) {
	var params struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return "", fmt.Errorf("invalid arguments: %w", err)
	}

	w, found, err := s.store.Get(params.ID)
	if err != nil {
		return "", err
	}
	if !found {
		return "", fmt.Errorf("work %s not found", params.ID)
	}

	type workDetail struct {
		ID          string `json:"id"`
		Type        string `json:"type"`
		ParentID    string `json:"parent_id,omitempty"`
		AgentRoleID string `json:"agent_role_id,omitempty"`
		Status      string `json:"status"`
		Title       string `json:"title"`
		Body        string `json:"body,omitempty"`
	}
	b, err := json.Marshal(workDetail{
		ID:          w.ID,
		Type:        string(w.Type),
		ParentID:    w.ParentID,
		AgentRoleID: w.AgentRoleID,
		Status:      string(w.Status),
		Title:       w.Title,
		Body:        w.Body,
	})
	if err != nil {
		return "", fmt.Errorf("marshal work item: %w", err)
	}
	return string(b), nil
}

func (s *Server) handleWorkDelete(ctx context.Context, args json.RawMessage) (string, error) {
	var params struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return "", fmt.Errorf("invalid arguments: %w", err)
	}

	if err := s.store.Delete(ctx, params.ID); err != nil {
		return "", err
	}

	return fmt.Sprintf("Deleted work %s", params.ID), nil
}

func (s *Server) handleWorkDone(ctx context.Context, args json.RawMessage) (string, error) {
	var params struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return "", fmt.Errorf("invalid arguments: %w", err)
	}

	if err := s.store.MarkDone(ctx, params.ID); err != nil {
		return "", err
	}

	return fmt.Sprintf("Marked work %s as done", params.ID), nil
}

func (s *Server) handleWorkStart(ctx context.Context, args json.RawMessage) (string, error) {
	var params struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return "", fmt.Errorf("invalid arguments: %w", err)
	}

	// Validate work exists and has an agent role before claiming
	w, found, err := s.store.Get(params.ID)
	if err != nil {
		return "", err
	}
	if !found {
		return "", fmt.Errorf("work %s not found", params.ID)
	}
	if w.AgentRoleID == "" {
		return "", fmt.Errorf("work %s has no agent_role_id", params.ID)
	}
	if _, roleFound, err := s.agentRoleStore.Get(w.AgentRoleID); err != nil {
		return "", fmt.Errorf("failed to validate agent role: %w", err)
	} else if !roleFound {
		return "", fmt.Errorf("agent role %q not found", w.AgentRoleID)
	}

	// Reuse existing sessionID on restart (stopped/needs_input → in_progress)
	// to preserve chat history. Only generate a new one for fresh starts.
	sessionID := w.SessionID
	if w.Status == work.StatusOpen || sessionID == "" {
		sessionID = uuid.Must(uuid.NewV7()).String()
	}

	// Claim: open/stopped/needs_input → in_progress + attach sessionID.
	// The main server detects this state change via fsnotify and handles
	// session creation + kickoff message (AutoResumer Trigger C).
	if _, err := s.store.Start(ctx, params.ID, sessionID); err != nil {
		return "", err
	}

	return fmt.Sprintf("Started work %s (session: %s)", params.ID, sessionID), nil
}

func (s *Server) handleWorkNeedsInput(ctx context.Context, args json.RawMessage) (string, error) {
	var params struct {
		ID     string `json:"id"`
		Reason string `json:"reason"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return "", fmt.Errorf("invalid arguments: %w", err)
	}

	if err := s.store.MarkNeedsInput(ctx, params.ID); err != nil {
		return "", err
	}

	return fmt.Sprintf("Work %s is now waiting for user input: %s", params.ID, params.Reason), nil
}

func (s *Server) handleWorkCommentAdd(ctx context.Context, args json.RawMessage) (string, error) {
	var params struct {
		WorkID string `json:"work_id"`
		Body   string `json:"body"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return "", fmt.Errorf("invalid arguments: %w", err)
	}

	comment, err := s.store.AddComment(ctx, params.WorkID, params.Body)
	if err != nil {
		return "", err
	}

	return fmt.Sprintf("Comment added (ID: %s)", comment.ID), nil
}

func (s *Server) handleWorkCommentList(_ context.Context, args json.RawMessage) (string, error) {
	var params struct {
		WorkID string `json:"work_id"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return "", fmt.Errorf("invalid arguments: %w", err)
	}

	comments, err := s.store.ListComments(params.WorkID)
	if err != nil {
		return "", err
	}

	type commentItem struct {
		ID        string `json:"id"`
		WorkID    string `json:"work_id"`
		Body      string `json:"body"`
		CreatedAt string `json:"created_at"`
	}
	items := make([]commentItem, len(comments))
	for i, c := range comments {
		items[i] = commentItem{
			ID:        c.ID,
			WorkID:    c.WorkID,
			Body:      c.Body,
			CreatedAt: c.CreatedAt.Format("2006-01-02T15:04:05Z07:00"),
		}
	}
	b, err := json.Marshal(items)
	if err != nil {
		return "", fmt.Errorf("marshal comment list: %w", err)
	}
	return string(b), nil
}

func (s *Server) handleAgentRoleList(_ context.Context, _ json.RawMessage) (string, error) {
	roles, err := s.agentRoleStore.List()
	if err != nil {
		return "", err
	}

	type roleItem struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	items := make([]roleItem, len(roles))
	for i, r := range roles {
		items[i] = roleItem{
			ID:   r.ID,
			Name: r.Name,
		}
	}
	b, err := json.Marshal(items)
	if err != nil {
		return "", fmt.Errorf("marshal agent role list: %w", err)
	}
	return string(b), nil
}

func (s *Server) handleAgentRoleGet(_ context.Context, args json.RawMessage) (string, error) {
	var params struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return "", fmt.Errorf("invalid arguments: %w", err)
	}

	role, found, err := s.agentRoleStore.Get(params.ID)
	if err != nil {
		return "", err
	}
	if !found {
		return "", fmt.Errorf("agent role %q not found", params.ID)
	}

	type roleDetail struct {
		ID         string `json:"id"`
		Name       string `json:"name"`
		RolePrompt string `json:"role_prompt"`
	}
	b, err := json.Marshal(roleDetail{
		ID:         role.ID,
		Name:       role.Name,
		RolePrompt: role.RolePrompt,
	})
	if err != nil {
		return "", fmt.Errorf("marshal agent role: %w", err)
	}
	return string(b), nil
}

func (s *Server) handleAgentRoleResetDefaults(ctx context.Context, _ json.RawMessage) (string, error) {
	if err := s.agentRoleStore.ResetDefaults(ctx); err != nil {
		return "", err
	}
	return "Agent roles reset to defaults", nil
}
