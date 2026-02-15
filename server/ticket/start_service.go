package ticket

import (
	"context"
	"log/slog"

	"github.com/google/uuid"
	"github.com/pockode/server/chat"
	"github.com/pockode/server/process"
	"github.com/pockode/server/session"
)

// StartService handles starting a ticket by creating a session and sending the initial message.
type StartService struct {
	ticketStore Store
	roleStore   RoleStore
}

// NewStartService creates a new ticket start service.
func NewStartService(ticketStore Store, roleStore RoleStore) *StartService {
	return &StartService{
		ticketStore: ticketStore,
		roleStore:   roleStore,
	}
}

// Start begins work on a ticket: creates a session, updates status, and sends the initial message.
// sessionStore and chatClient are passed per-call since they are worktree-specific.
// Returns the session ID on success.
func (s *StartService) Start(ctx context.Context, tk Ticket, sessionStore session.Store, chatClient *chat.Client) (string, error) {
	role, found, err := s.roleStore.Get(tk.RoleID)
	if err != nil {
		return "", err
	}
	if !found {
		slog.Warn("role not found, using empty role", "roleId", tk.RoleID)
		role = AgentRole{}
	}

	sessionID := uuid.Must(uuid.NewV7()).String()
	if _, err := sessionStore.Create(ctx, sessionID); err != nil {
		return "", err
	}
	if err := sessionStore.Update(ctx, sessionID, tk.Title); err != nil {
		slog.Warn("failed to set session title", "error", err)
	}

	inProgress := TicketStatusInProgress
	if _, err := s.ticketStore.Update(ctx, tk.ID, TicketUpdate{
		Status:    &inProgress,
		SessionID: &sessionID,
	}); err != nil {
		return "", err
	}

	procOpts := process.ProcessOptions{
		Mode:         session.ModeYolo,
		SystemPrompt: BuildAgentSystemPrompt(tk, role),
	}
	if err := chatClient.SendMessageWithOptions(ctx, sessionID, tk.Title, procOpts); err != nil {
		s.rollbackTicketStatus(ctx, tk.ID)
		return "", err
	}

	slog.Info("ticket started", "ticketId", tk.ID, "sessionId", sessionID)
	return sessionID, nil
}

func (s *StartService) rollbackTicketStatus(ctx context.Context, ticketID string) {
	openStatus := TicketStatusOpen
	emptySession := ""
	if _, err := s.ticketStore.Update(ctx, ticketID, TicketUpdate{
		Status:    &openStatus,
		SessionID: &emptySession,
	}); err != nil {
		slog.Error("failed to rollback ticket status", "ticketId", ticketID, "error", err)
	} else {
		slog.Warn("rolled back ticket to open", "ticketId", ticketID)
	}
}
