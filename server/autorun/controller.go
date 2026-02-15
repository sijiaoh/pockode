// Package autorun provides automatic ticket processing when autorun is enabled.
package autorun

import (
	"context"
	"log/slog"
	"sync"

	"github.com/google/uuid"
	"github.com/pockode/server/chat"
	"github.com/pockode/server/process"
	"github.com/pockode/server/session"
	"github.com/pockode/server/settings"
	"github.com/pockode/server/ticket"
)

// Controller handles automatic ticket processing.
// When autorun is enabled:
// - Sends "continue" when a session becomes idle (for in_progress tickets)
// - Starts the next open ticket when current ticket is done
// - Starts the next open ticket when autorun is enabled (if no ticket is in progress)
type Controller struct {
	ticketStore   ticket.Store
	roleStore     ticket.RoleStore
	sessionStore  session.Store
	chatClient    *chat.Client
	settingsStore *settings.Store

	processingMu sync.Mutex
	processing   bool // Prevents concurrent ticket starts
}

// New creates a new autorun controller.
func New(
	ticketStore ticket.Store,
	roleStore ticket.RoleStore,
	sessionStore session.Store,
	chatClient *chat.Client,
	settingsStore *settings.Store,
) *Controller {
	return &Controller{
		ticketStore:   ticketStore,
		roleStore:     roleStore,
		sessionStore:  sessionStore,
		chatClient:    chatClient,
		settingsStore: settingsStore,
	}
}

func (c *Controller) isEnabled() bool {
	if c.settingsStore == nil {
		return false
	}
	return c.settingsStore.Get().Autorun
}

// OnProcessStateChange handles process state changes.
// When a session becomes idle, sends "continue" if autorun is enabled
// and the session is associated with an in_progress ticket.
func (c *Controller) OnProcessStateChange(event process.StateChangeEvent) {
	if !c.isEnabled() {
		return
	}

	if event.State == process.ProcessStateIdle {
		go c.handleIdleState(event.SessionID)
	}
}

func (c *Controller) handleIdleState(sessionID string) {
	tickets, err := c.ticketStore.List()
	if err != nil {
		slog.Error("autorun: failed to list tickets", "error", err)
		return
	}

	for _, tk := range tickets {
		if tk.Status == ticket.TicketStatusInProgress && tk.SessionID == sessionID {
			if err := c.chatClient.SendMessage(context.Background(), sessionID, "continue"); err != nil {
				slog.Error("autorun: failed to send continue", "sessionId", sessionID, "error", err)
			} else {
				slog.Info("autorun: sent continue", "sessionId", sessionID, "ticketId", tk.ID)
			}
			return
		}
	}
}

// OnTicketChange handles ticket state changes.
// When a ticket becomes done, starts the next open ticket if autorun is enabled.
func (c *Controller) OnTicketChange(event ticket.TicketChangeEvent) {
	if !c.isEnabled() {
		return
	}

	if event.Op == ticket.OperationUpdate && event.Ticket.Status == ticket.TicketStatusDone {
		go c.startNextOpenTicket()
	}
}

// OnSettingsChange handles settings changes.
// When autorun is enabled and there's no in_progress ticket, starts the next open ticket.
func (c *Controller) OnSettingsChange(s settings.Settings) {
	if !s.Autorun {
		return
	}
	go c.startNextOpenTicket()
}

func (c *Controller) startNextOpenTicket() {
	c.processingMu.Lock()
	if c.processing {
		c.processingMu.Unlock()
		slog.Debug("autorun: already processing, skipping")
		return
	}
	c.processing = true
	c.processingMu.Unlock()

	defer func() {
		c.processingMu.Lock()
		c.processing = false
		c.processingMu.Unlock()
	}()

	// Check if there's already an in_progress ticket
	tickets, err := c.ticketStore.List()
	if err != nil {
		slog.Error("autorun: failed to list tickets", "error", err)
		return
	}

	for _, tk := range tickets {
		if tk.Status == ticket.TicketStatusInProgress {
			slog.Debug("autorun: ticket already in progress", "ticketId", tk.ID)
			return
		}
	}

	// Find the first open ticket (list is sorted by priority)
	for _, tk := range tickets {
		if tk.Status == ticket.TicketStatusOpen {
			if err := c.startTicket(tk); err != nil {
				slog.Error("autorun: failed to start ticket", "ticketId", tk.ID, "error", err)
			}
			return
		}
	}

	slog.Info("autorun: no open tickets to start")
}

func (c *Controller) startTicket(tk ticket.Ticket) error {
	ctx := context.Background()

	// Get the role for system prompt
	role, found, err := c.roleStore.Get(tk.RoleID)
	if err != nil {
		return err
	}
	if !found {
		slog.Warn("autorun: role not found", "roleId", tk.RoleID)
		role = ticket.AgentRole{} // Use empty role
	}

	// Create a new session
	sessionID := uuid.Must(uuid.NewV7()).String()
	if _, err := c.sessionStore.Create(ctx, sessionID); err != nil {
		return err
	}

	// Update session title to match ticket
	if err := c.sessionStore.Update(ctx, sessionID, tk.Title); err != nil {
		slog.Warn("autorun: failed to set session title", "error", err)
	}

	// Update ticket with session ID and status
	inProgress := ticket.TicketStatusInProgress
	if _, err := c.ticketStore.Update(ctx, tk.ID, ticket.TicketUpdate{
		Status:    &inProgress,
		SessionID: &sessionID,
	}); err != nil {
		return err
	}

	// Send the initial message with custom system prompt
	procOpts := process.ProcessOptions{
		Mode:         session.ModeYolo,
		SystemPrompt: ticket.BuildAgentSystemPrompt(tk, role),
	}
	if err := c.chatClient.SendMessageWithOptions(ctx, sessionID, tk.Title, procOpts); err != nil {
		return err
	}

	slog.Info("autorun: ticket started", "ticketId", tk.ID, "sessionId", sessionID)
	return nil
}
