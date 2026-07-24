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

// MessageBroadcastFunc broadcasts a user message to all session subscribers,
// optionally excluding one notifier. The exclude parameter is typed as any
// to avoid importing the watch package; the wiring code casts it.
type MessageBroadcastFunc func(sessionID string, event agent.MessageEvent, exclude any)

// Client coordinates chat operations across session and process management.
// It is the single entry point for programmatic chat interactions.
type Client struct {
	store     session.Store
	pm        *process.Manager
	broadcast MessageBroadcastFunc
}

func NewClient(store session.Store, pm *process.Manager) *Client {
	return &Client{store: store, pm: pm}
}

// SetBroadcaster sets the function used to broadcast user messages to subscribers.
func (c *Client) SetBroadcaster(fn MessageBroadcastFunc) {
	c.broadcast = fn
}

// SendMessage sends a user message to the agent process, persists it to
// history, and broadcasts it to all session subscribers.
func (c *Client) SendMessage(ctx context.Context, sessionID, content string) error {
	return c.sendMessage(ctx, sessionID, content, nil)
}

// SendMessageExcluding is like SendMessage but excludes one notifier from
// the broadcast. Used when the caller already notified itself (e.g. the
// WebSocket client that sent the message).
func (c *Client) SendMessageExcluding(ctx context.Context, sessionID, content string, exclude any) error {
	return c.sendMessage(ctx, sessionID, content, exclude)
}

// SendWorkMessage sends a work-driven automatic message (kickoff, restart,
// auto-continue, etc.). It is tagged with origin "work" plus a subtype and
// optional meta so the frontend can render it as a collapsed workflow message
// rather than a user bubble.
func (c *Client) SendWorkMessage(ctx context.Context, sessionID, content, subtype string, meta *agent.MessageMeta) error {
	event := agent.MessageEvent{
		Content: content,
		Origin:  agent.MessageOriginWork,
		Subtype: subtype,
		Meta:    meta,
	}
	return c.sendEvent(ctx, sessionID, event, nil)
}

func (c *Client) sendMessage(ctx context.Context, sessionID, content string, exclude any) error {
	return c.sendEvent(ctx, sessionID, agent.MessageEvent{Content: content}, exclude)
}

func (c *Client) sendEvent(ctx context.Context, sessionID string, event agent.MessageEvent, exclude any) error {
	proc, err := c.getOrCreateProcess(ctx, sessionID)
	if err != nil {
		return err
	}

	// Persist message to history
	if err := c.store.AppendToHistory(ctx, sessionID, agent.NewEventRecord(event)); err != nil {
		slog.Error("failed to persist message", "sessionId", sessionID, "error", err)
	}

	if err := proc.SendMessage(event.Content); err != nil {
		return err
	}

	if c.broadcast != nil {
		c.broadcast(sessionID, event, exclude)
	}

	return nil
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
	proc, created, err := c.pm.GetOrCreateProcess(ctx, sessionID, resume, meta.AgentType, meta.Mode)
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
