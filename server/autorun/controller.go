// Package autorun provides automatic ticket processing when autorun is enabled.
package autorun

import (
	"context"
	"log/slog"
	"sync"

	"github.com/pockode/server/chat"
	"github.com/pockode/server/process"
	"github.com/pockode/server/session"
	"github.com/pockode/server/settings"
	"github.com/pockode/server/ticket"
)

// Controller handles automatic ticket processing.
// When autorun is enabled:
// - Prompts agent to continue or close ticket when session becomes idle (for in_progress tickets)
// - Starts the next open ticket when current ticket is done
// - Starts the next open ticket when autorun is enabled (if no ticket is in progress)
type Controller struct {
	ticketStore   ticket.Store
	ticketStarter *ticket.StartService
	sessionStore  session.Store
	chatClient    *chat.Client
	settingsStore *settings.Store

	processingMu sync.Mutex
	processing   bool // Prevents concurrent ticket starts
}

// New creates a new autorun controller.
func New(
	ticketStore ticket.Store,
	ticketStarter *ticket.StartService,
	sessionStore session.Store,
	chatClient *chat.Client,
	settingsStore *settings.Store,
) *Controller {
	return &Controller{
		ticketStore:   ticketStore,
		ticketStarter: ticketStarter,
		sessionStore:  sessionStore,
		chatClient:    chatClient,
		settingsStore: settingsStore,
	}
}

// IsEnabled returns whether autorun is currently enabled.
func (c *Controller) IsEnabled() bool {
	if c.settingsStore == nil {
		return false
	}
	return c.settingsStore.Get().Autorun
}

// OnProcessStateChange handles process state changes.
// When a session becomes idle, prompts the agent to continue or close the ticket
// if autorun is enabled and the session is associated with an in_progress ticket.
// Initial idle events (when a process is first created) are ignored to avoid
// sending continue messages before the initial ticket message.
func (c *Controller) OnProcessStateChange(event process.StateChangeEvent) {
	if !c.IsEnabled() {
		return
	}

	if event.State == process.ProcessStateIdle && !event.IsInitial {
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
			// Ask agent to continue or close ticket to prevent infinite loops
			msg := "Continue working on the ticket. If you have completed all tasks, update the ticket status to done."
			if err := c.chatClient.SendMessage(context.Background(), sessionID, msg); err != nil {
				slog.Error("autorun: failed to send continue", "sessionId", sessionID, "error", err)
			} else {
				slog.Info("autorun: sent continue", "sessionId", sessionID, "ticketId", tk.ID)
			}
			return
		}
	}
}

// OnTicketChange handles ticket state changes.
// Starts the next open ticket when a ticket becomes done or a new ticket is created.
func (c *Controller) OnTicketChange(event ticket.TicketChangeEvent) {
	if !c.IsEnabled() {
		return
	}

	if (event.Op == ticket.OperationUpdate && event.Ticket.Status == ticket.TicketStatusDone) ||
		event.Op == ticket.OperationCreate {
		go c.StartNextOpenTicket()
	}
}

// OnSettingsChange handles settings changes.
// When autorun is enabled and there's no in_progress ticket, starts the next open ticket.
func (c *Controller) OnSettingsChange(s settings.Settings) {
	if !s.Autorun {
		return
	}
	go c.StartNextOpenTicket()
}

// StartNextOpenTicket starts the next open ticket if none is in progress.
func (c *Controller) StartNextOpenTicket() {
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
	_, err := c.ticketStarter.Start(context.Background(), tk, c.sessionStore, c.chatClient)
	return err
}
