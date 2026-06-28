package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"github.com/pockode/server/agentrole"
	"github.com/pockode/server/settings"
	"github.com/pockode/server/work"
)

// ErrUnknownTool indicates a tools/call referenced a tool that does not exist.
var ErrUnknownTool = errors.New("unknown tool")

// WorkNotifier delivers the next-step prompt that follows an in-process
// step_done. The AutoResumer sends it only on request, so the Executor calls it
// after advancing the step in-process. (The reopen nudge lives in
// work.Operations, which owns the reopen transition for both transports.)
type WorkNotifier interface {
	NotifyStepDone(w work.Work)
}

// SettingsStore is the slice of the settings store the executor needs to keep
// the default agent role in sync on agent_role_reset_defaults (parity with the
// WebSocket handler).
type SettingsStore interface {
	Get() settings.Settings
	Update(settings.Settings) error
}

// Executor runs MCP tool calls against the live server stores. It is the
// in-process counterpart to the stdio proxy: the proxy (running inside the AI
// CLI subprocess) forwards each tool call over HTTP, and the Executor performs
// the actual work using the same stores and work.Operations as the WebSocket
// handlers. This keeps the server as the single writer of work data.
type Executor struct {
	store          work.Store
	agentRoleStore agentrole.Store
	ops            *work.Operations
	notifier       WorkNotifier
	settingsStore  SettingsStore
}

// NewExecutor creates an Executor. ops performs the start/reopen transitions and
// their side effects (the same operations the WebSocket layer calls); it is
// required whenever work_start or work_reopen is reachable. notifier delivers
// the step-advance message on step_done; a nil notifier skips that follow-up.
// settingsStore keeps the default agent role in sync on reset; a nil
// settingsStore skips that update. Nils are tolerated only where the
// corresponding tools are unreachable (e.g. narrow tests).
func NewExecutor(store work.Store, agentRoleStore agentrole.Store, ops *work.Operations, notifier WorkNotifier, settingsStore SettingsStore) *Executor {
	return &Executor{store: store, agentRoleStore: agentRoleStore, ops: ops, notifier: notifier, settingsStore: settingsStore}
}

// Execute runs the named tool and returns its text result. It returns a
// wrapped ErrUnknownTool when the name is not recognized.
func (e *Executor) Execute(ctx context.Context, name string, args json.RawMessage) (string, error) {
	switch name {
	case "work_list":
		return e.workList(args)
	case "work_create":
		return e.workCreate(ctx, args)
	case "work_update":
		return e.workUpdate(ctx, args)
	case "work_get":
		return e.workGet(args)
	case "work_delete":
		return e.workDelete(ctx, args)
	case "work_start":
		return e.workStart(ctx, args)
	case "work_needs_input":
		return e.workNeedsInput(ctx, args)
	case "work_reopen":
		return e.workReopen(ctx, args)
	case "work_wait":
		return e.workWait(ctx, args)
	case "step_done":
		return e.stepDone(ctx, args)
	case "work_comment_add":
		return e.workCommentAdd(ctx, args)
	case "work_comment_list":
		return e.workCommentList(args)
	case "work_comment_update":
		return e.workCommentUpdate(ctx, args)
	case "agent_role_list":
		return e.agentRoleList()
	case "agent_role_get":
		return e.agentRoleGet(args)
	case "agent_role_reset_defaults":
		return e.agentRoleResetDefaults(ctx)
	default:
		return "", fmt.Errorf("%w: %s", ErrUnknownTool, name)
	}
}

func (e *Executor) workList(args json.RawMessage) (string, error) {
	var params struct {
		ParentID string `json:"parent_id"`
	}
	if len(args) > 0 {
		if err := json.Unmarshal(args, &params); err != nil {
			return "", fmt.Errorf("invalid arguments: %w", err)
		}
	}

	works, err := e.store.List()
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

func (e *Executor) workCreate(ctx context.Context, args json.RawMessage) (string, error) {
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
	if _, found, err := e.agentRoleStore.Get(params.AgentRoleID); err != nil {
		return "", fmt.Errorf("failed to validate agent role: %w", err)
	} else if !found {
		return "", fmt.Errorf("agent role %q not found", params.AgentRoleID)
	}

	created, err := e.store.Create(ctx, work.Work{
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

func (e *Executor) workUpdate(ctx context.Context, args json.RawMessage) (string, error) {
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
		if _, found, err := e.agentRoleStore.Get(*params.AgentRoleID); err != nil {
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
	if err := e.store.Update(ctx, params.ID, fields); err != nil {
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

func (e *Executor) workGet(args json.RawMessage) (string, error) {
	var params struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return "", fmt.Errorf("invalid arguments: %w", err)
	}

	w, found, err := e.store.Get(params.ID)
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

func (e *Executor) workDelete(ctx context.Context, args json.RawMessage) (string, error) {
	var params struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return "", fmt.Errorf("invalid arguments: %w", err)
	}

	if err := e.store.Delete(ctx, params.ID); err != nil {
		return "", err
	}

	return fmt.Sprintf("Deleted work %s", params.ID), nil
}

func (e *Executor) workStart(ctx context.Context, args json.RawMessage) (string, error) {
	var params struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return "", fmt.Errorf("invalid arguments: %w", err)
	}

	w, err := e.ops.StartWork(ctx, params.ID)
	if err != nil {
		return "", err
	}

	return fmt.Sprintf("Started work %s (session: %s)", w.ID, w.SessionID), nil
}

func (e *Executor) workNeedsInput(ctx context.Context, args json.RawMessage) (string, error) {
	var params struct {
		ID     string `json:"id"`
		Reason string `json:"reason"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return "", fmt.Errorf("invalid arguments: %w", err)
	}

	if err := e.store.MarkNeedsInput(ctx, params.ID); err != nil {
		return "", err
	}

	return fmt.Sprintf("Work %s is now waiting for user input: %s", params.ID, params.Reason), nil
}

func (e *Executor) workReopen(ctx context.Context, args json.RawMessage) (string, error) {
	var params struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return "", fmt.Errorf("invalid arguments: %w", err)
	}

	if err := e.ops.ReopenWork(ctx, params.ID); err != nil {
		return "", err
	}

	return fmt.Sprintf("Reopened work %s", params.ID), nil
}

func (e *Executor) workWait(ctx context.Context, args json.RawMessage) (string, error) {
	var params struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return "", fmt.Errorf("invalid arguments: %w", err)
	}

	if err := e.store.MarkWaiting(ctx, params.ID); err != nil {
		return "", err
	}

	return fmt.Sprintf("Work %s is now waiting for child work to complete", params.ID), nil
}

func (e *Executor) stepDone(ctx context.Context, args json.RawMessage) (string, error) {
	var params struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return "", fmt.Errorf("invalid arguments: %w", err)
	}

	// Get the work item to find its agent role
	w, found, err := e.store.Get(params.ID)
	if err != nil {
		return "", err
	}
	if !found {
		return "", work.ErrWorkNotFound
	}

	// Get step count from agent role
	role, found, err := e.agentRoleStore.Get(w.AgentRoleID)
	if err != nil {
		return "", fmt.Errorf("failed to get agent role: %w", err)
	}
	if !found {
		return "", fmt.Errorf("agent role %s not found", w.AgentRoleID)
	}

	totalSteps := len(role.Steps)

	hasMoreSteps, err := e.store.StepDone(ctx, params.ID, totalSteps)
	if err != nil {
		return "", err
	}

	if hasMoreSteps {
		// Deliver the next-step prompt to the agent session. Re-read to get the
		// advanced CurrentStep.
		if e.notifier != nil {
			if advanced, found, getErr := e.store.Get(params.ID); getErr == nil && found {
				e.notifier.NotifyStepDone(advanced)
			}
		}
		return fmt.Sprintf("Step %d completed for work %s, advancing to step %d of %d", w.CurrentStep+1, params.ID, w.CurrentStep+2, totalSteps), nil
	}
	if totalSteps == 0 {
		return fmt.Sprintf("Work %s closed", params.ID), nil
	}
	return fmt.Sprintf("Step %d (final step) completed for work %s. Work is now closed.", w.CurrentStep+1, params.ID), nil
}

func (e *Executor) workCommentAdd(ctx context.Context, args json.RawMessage) (string, error) {
	var params struct {
		WorkID string `json:"work_id"`
		Body   string `json:"body"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return "", fmt.Errorf("invalid arguments: %w", err)
	}

	comment, err := e.store.AddComment(ctx, params.WorkID, params.Body)
	if err != nil {
		return "", err
	}

	return fmt.Sprintf("Comment added (ID: %s)", comment.ID), nil
}

func (e *Executor) workCommentList(args json.RawMessage) (string, error) {
	var params struct {
		WorkID string `json:"work_id"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return "", fmt.Errorf("invalid arguments: %w", err)
	}

	comments, err := e.store.ListComments(params.WorkID)
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

func (e *Executor) workCommentUpdate(ctx context.Context, args json.RawMessage) (string, error) {
	var params struct {
		ID   string `json:"id"`
		Body string `json:"body"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return "", fmt.Errorf("invalid arguments: %w", err)
	}

	comment, err := e.store.UpdateComment(ctx, params.ID, params.Body)
	if err != nil {
		return "", err
	}

	type commentDetail struct {
		ID        string `json:"id"`
		WorkID    string `json:"work_id"`
		Body      string `json:"body"`
		CreatedAt string `json:"created_at"`
	}
	b, err := json.Marshal(commentDetail{
		ID:        comment.ID,
		WorkID:    comment.WorkID,
		Body:      comment.Body,
		CreatedAt: comment.CreatedAt.Format("2006-01-02T15:04:05Z07:00"),
	})
	if err != nil {
		return "", fmt.Errorf("marshal comment: %w", err)
	}
	return string(b), nil
}

func (e *Executor) agentRoleList() (string, error) {
	roles, err := e.agentRoleStore.List()
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

func (e *Executor) agentRoleGet(args json.RawMessage) (string, error) {
	var params struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return "", fmt.Errorf("invalid arguments: %w", err)
	}

	role, found, err := e.agentRoleStore.Get(params.ID)
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

func (e *Executor) agentRoleResetDefaults(ctx context.Context) (string, error) {
	pmRoleID, err := e.agentRoleStore.ResetDefaults(ctx)
	if err != nil {
		return "", err
	}

	// Repoint the default agent role to the new PM role, like the WebSocket
	// handler. Otherwise settings.DefaultAgentRoleID dangles at the now-deleted
	// old role, which breaks the settings UI and settings.update validation.
	if e.settingsStore != nil {
		s := e.settingsStore.Get()
		s.DefaultAgentRoleID = pmRoleID
		if err := e.settingsStore.Update(s); err != nil {
			slog.Error("failed to set default agent role after reset", "error", err)
		}
	}

	return "Agent roles reset to defaults", nil
}
