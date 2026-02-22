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
	agentRoleStore  agentrole.Store
}

func NewWorkStarter(wm *Manager, ars agentrole.Store) *WorkStarter {
	return &WorkStarter{
		worktreeManager: wm,
		agentRoleStore:  ars,
	}
}

// HandleWorkStart creates a session and sends the kickoff message for a
// work item that has already been claimed (status=in_progress, sessionID set).
// If a session with the same ID already exists (restart case), it skips
// session creation and sends a restart message instead.
func (s *WorkStarter) HandleWorkStart(ctx context.Context, w work.Work) error {
	if w.AgentRoleID == "" {
		return fmt.Errorf("work %s has no agent_role_id", w.ID)
	}

	_, found, err := s.agentRoleStore.Get(w.AgentRoleID)
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

	// Check if session already exists to distinguish restart from fresh start.
	_, sessionExists, err := mainWt.SessionStore.Get(w.SessionID)
	if err != nil {
		return fmt.Errorf("check session: %w", err)
	}

	if sessionExists {
		return s.sendRestart(ctx, mainWt, w)
	}
	return s.createAndSendKickoff(ctx, mainWt, w)
}

func (s *WorkStarter) sendRestart(ctx context.Context, wt *Worktree, w work.Work) error {
	msg := work.BuildRestartMessage(w)
	if err := wt.ChatClient.SendMessage(ctx, w.SessionID, msg); err != nil {
		return fmt.Errorf("send restart message: %w", err)
	}
	return nil
}

func (s *WorkStarter) createAndSendKickoff(ctx context.Context, wt *Worktree, w work.Work) error {
	if _, err := wt.SessionStore.Create(ctx, w.SessionID); err != nil {
		return fmt.Errorf("create session: %w", err)
	}

	if err := wt.SessionStore.Update(ctx, w.SessionID, w.Title); err != nil {
		slog.Warn("failed to set session title", "sessionId", w.SessionID, "error", err)
	}

	msg := work.BuildKickoffMessage(w)
	if err := wt.ChatClient.SendMessage(ctx, w.SessionID, msg); err != nil {
		if delErr := wt.SessionStore.Delete(ctx, w.SessionID); delErr != nil {
			slog.Error("failed to clean up session after kickoff failure", "sessionId", w.SessionID, "error", delErr)
		}
		return fmt.Errorf("send kickoff message: %w", err)
	}

	return nil
}
