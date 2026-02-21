package worktree

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/pockode/server/agentrole"
	"github.com/pockode/server/work"
)

// WorkStarter implements work.WorkStartHandler by creating a session
// and sending a kickoff message via the main worktree.
type WorkStarter struct {
	worktreeManager *Manager
	workStore       work.Store
	agentRoleStore  agentrole.Store
}

func NewWorkStarter(wm *Manager, ws work.Store, ars agentrole.Store) *WorkStarter {
	return &WorkStarter{
		worktreeManager: wm,
		workStore:       ws,
		agentRoleStore:  ars,
	}
}

// HandleWorkStart creates a session and sends the kickoff message for a
// work item that has already been claimed (status=in_progress, sessionID set).
func (s *WorkStarter) HandleWorkStart(ctx context.Context, w work.Work) error {
	if w.AgentRoleID == "" {
		return fmt.Errorf("work %s has no agent_role_id", w.ID)
	}

	role, found, err := s.agentRoleStore.Get(w.AgentRoleID)
	if err != nil {
		return fmt.Errorf("get agent role: %w", err)
	}
	if !found {
		return fmt.Errorf("agent role %q not found", w.AgentRoleID)
	}

	mainWt, err := s.worktreeManager.Get("")
	if err != nil {
		return fmt.Errorf("get main worktree: %w", err)
	}
	defer s.worktreeManager.Release(mainWt)

	if _, err := mainWt.SessionStore.Create(ctx, w.SessionID); err != nil {
		return fmt.Errorf("create session: %w", err)
	}

	if err := mainWt.SessionStore.Update(ctx, w.SessionID, w.Title); err != nil {
		slog.Warn("failed to set session title", "sessionId", w.SessionID, "error", err)
	}

	var parentTitle string
	if w.ParentID != "" {
		if parent, found, err := s.workStore.Get(w.ParentID); err == nil && found {
			parentTitle = parent.Title
		} else {
			slog.Warn("failed to get parent for kickoff message", "parentId", w.ParentID, "error", err)
		}
	}

	kickoffMsg := work.BuildKickoffMessage(w, parentTitle, role.RolePrompt)
	if err := mainWt.ChatClient.SendMessage(ctx, w.SessionID, kickoffMsg); err != nil {
		if delErr := mainWt.SessionStore.Delete(ctx, w.SessionID); delErr != nil {
			slog.Error("failed to clean up session after kickoff failure", "sessionId", w.SessionID, "error", delErr)
		}
		return fmt.Errorf("send kickoff message: %w", err)
	}

	return nil
}
