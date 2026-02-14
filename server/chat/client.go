package chat

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/process"
	"github.com/pockode/server/session"
)

var ErrSessionNotFound = errors.New("session not found")

// Client coordinates chat operations across session and process management.
// It is the single entry point for programmatic chat interactions.
type Client struct {
	store session.Store
	pm    *process.Manager
}

func NewClient(store session.Store, pm *process.Manager) *Client {
	return &Client{store: store, pm: pm}
}

func (c *Client) SendMessage(ctx context.Context, sessionID, content string) error {
	proc, err := c.getOrCreateProcess(ctx, sessionID)
	if err != nil {
		return err
	}

	// Persist user message to history
	event := agent.MessageEvent{Content: content}
	if err := c.store.AppendToHistory(ctx, sessionID, agent.NewEventRecord(event)); err != nil {
		slog.Error("failed to persist user message", "sessionId", sessionID, "error", err)
	}

	return proc.SendMessage(content)
}

func (c *Client) SendPermissionResponse(ctx context.Context, sessionID string, data agent.PermissionRequestData, choice agent.PermissionChoice) error {
	proc, err := c.getOrCreateProcess(ctx, sessionID)
	if err != nil {
		return err
	}

	if err := proc.SendPermissionResponse(data, choice); err != nil {
		return err
	}

	// Persist response to history
	event := agent.PermissionResponseEvent{
		RequestID: data.RequestID,
		Choice:    choiceToString(choice),
	}
	if err := c.store.AppendToHistory(ctx, sessionID, agent.NewEventRecord(event)); err != nil {
		slog.Error("failed to persist permission response", "sessionId", sessionID, "error", err)
	}

	return nil
}

func (c *Client) SendQuestionResponse(ctx context.Context, sessionID string, data agent.QuestionRequestData, answers map[string]string) error {
	proc, err := c.getOrCreateProcess(ctx, sessionID)
	if err != nil {
		return err
	}

	if err := proc.SendQuestionResponse(data, answers); err != nil {
		return err
	}

	// Persist response to history
	event := agent.QuestionResponseEvent{
		RequestID: data.RequestID,
		Answers:   answers,
	}
	if err := c.store.AppendToHistory(ctx, sessionID, agent.NewEventRecord(event)); err != nil {
		slog.Error("failed to persist question response", "sessionId", sessionID, "error", err)
	}

	return nil
}

func (c *Client) Interrupt(ctx context.Context, sessionID string) error {
	proc, err := c.getOrCreateProcess(ctx, sessionID)
	if err != nil {
		return err
	}
	return proc.SendInterrupt()
}

// getOrCreateProcess handles session validation, process creation, and activation.
func (c *Client) getOrCreateProcess(ctx context.Context, sessionID string) (*process.Process, error) {
	meta, found, err := c.store.Get(sessionID)
	if err != nil {
		return nil, fmt.Errorf("get session: %w", err)
	}
	if !found {
		return nil, ErrSessionNotFound
	}

	resume := meta.Activated
	proc, created, err := c.pm.GetOrCreateProcess(ctx, sessionID, resume, meta.Mode)
	if err != nil {
		return nil, err
	}

	// Activate session on first process creation
	if created && !resume {
		if err := c.store.Activate(ctx, sessionID); err != nil {
			slog.Error("failed to activate session", "sessionId", sessionID, "error", err)
		}
	}

	return proc, nil
}

func choiceToString(choice agent.PermissionChoice) string {
	switch choice {
	case agent.PermissionAllow:
		return "allow"
	case agent.PermissionAlwaysAllow:
		return "always_allow"
	default:
		return "deny"
	}
}
