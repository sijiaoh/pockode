package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

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
				"type":      {Type: "string", Description: "Work type", Enum: []string{"story", "task"}},
				"parent_id": {Type: "string", Description: "Parent work ID (required for tasks)"},
				"title":     {Type: "string", Description: "Title of the work item"},
				"body":      {Type: "string", Description: "Detailed description or instructions for the work item"},
			},
			Required: []string{"type", "title"},
		},
	},
	{
		Name:        "work_update",
		Description: "Update a work item's title or body.",
		InputSchema: inputSchema{
			Type: "object",
			Properties: map[string]propertySchema{
				"id":    {Type: "string", Description: "Work item ID"},
				"title": {Type: "string", Description: "New title"},
				"body":  {Type: "string", Description: "New body content"},
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
		Name:        "work_done",
		Description: "Mark a work item as done. If all sibling tasks are also done, the parent story will automatically close. If the item is still open (not yet in_progress), it will be automatically transitioned.",
		InputSchema: inputSchema{
			Type: "object",
			Properties: map[string]propertySchema{
				"id": {Type: "string", Description: "Work item ID to mark as done"},
			},
			Required: []string{"id"},
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
	case "work_done":
		return s.handleWorkDone, true
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
		ID       string `json:"id"`
		Type     string `json:"type"`
		ParentID string `json:"parent_id,omitempty"`
		Status   string `json:"status"`
		Title    string `json:"title"`
	}
	items := make([]workItem, len(works))
	for i, w := range works {
		items[i] = workItem{
			ID:       w.ID,
			Type:     string(w.Type),
			ParentID: w.ParentID,
			Status:   string(w.Status),
			Title:    w.Title,
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
		Type     work.WorkType `json:"type"`
		ParentID string        `json:"parent_id"`
		Title    string        `json:"title"`
		Body     string        `json:"body"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return "", fmt.Errorf("invalid arguments: %w", err)
	}

	created, err := s.store.Create(ctx, work.Work{
		Type:     params.Type,
		ParentID: params.ParentID,
		Title:    params.Title,
		Body:     params.Body,
	})
	if err != nil {
		return "", err
	}

	return fmt.Sprintf("Created %s %q (ID: %s)", created.Type, created.Title, created.ID), nil
}

func (s *Server) handleWorkUpdate(ctx context.Context, args json.RawMessage) (string, error) {
	var params struct {
		ID    string  `json:"id"`
		Title *string `json:"title"`
		Body  *string `json:"body"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return "", fmt.Errorf("invalid arguments: %w", err)
	}

	fields := work.UpdateFields{
		Title: params.Title,
		Body:  params.Body,
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
		ID       string `json:"id"`
		Type     string `json:"type"`
		ParentID string `json:"parent_id,omitempty"`
		Status   string `json:"status"`
		Title    string `json:"title"`
		Body     string `json:"body,omitempty"`
	}
	b, err := json.Marshal(workDetail{
		ID:       w.ID,
		Type:     string(w.Type),
		ParentID: w.ParentID,
		Status:   string(w.Status),
		Title:    w.Title,
		Body:     w.Body,
	})
	if err != nil {
		return "", fmt.Errorf("marshal work item: %w", err)
	}
	return string(b), nil
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
