package worktree

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/pockode/server/agentrole"
	"github.com/pockode/server/settings"
	"github.com/pockode/server/work"
)

// WorkStarter implements work.WorkStartHandler by creating a session
// and sending a kickoff message via the main worktree.
type WorkStarter struct {
	worktreeManager *Manager
	agentRoleStore  agentrole.Store
	settingsStore   *settings.Store
}

func NewWorkStarter(wm *Manager, ars agentrole.Store, ss *settings.Store) *WorkStarter {
	return &WorkStarter{
		worktreeManager: wm,
		agentRoleStore:  ars,
		settingsStore:   ss,
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

	role, found, err := s.agentRoleStore.Get(w.AgentRoleID)
	if err != nil {
		return fmt.Errorf("get agent role: %w", err)
	}
	if !found {
		return fmt.Errorf("agent role %q not found", w.AgentRoleID)
	}

	wt, err := s.worktreeManager.Get(w.Worktree)
	if err != nil {
		return fmt.Errorf("get worktree %q: %w", w.Worktree, err)
	}
	defer s.worktreeManager.Release(wt)

	// Check if session already exists to distinguish restart from fresh start.
	_, sessionExists, err := wt.SessionStore.Get(w.SessionID)
	if err != nil {
		return fmt.Errorf("check session: %w", err)
	}

	if sessionExists {
		return s.sendRestart(ctx, wt, w)
	}
	return s.createAndSendKickoff(ctx, wt, w, role.Steps)
}

func (s *WorkStarter) sendRestart(ctx context.Context, wt *Worktree, w work.Work) error {
	msg := work.BuildRestartMessage(w)
	meta := work.NewMessageMeta(w.Title, 0, 0)
	if err := wt.ChatClient.SendSystemMessage(ctx, w.SessionID, msg, work.MessageSubtypeRestart, meta); err != nil {
		return fmt.Errorf("send restart message: %w", err)
	}
	return nil
}

func (s *WorkStarter) createAndSendKickoff(ctx context.Context, wt *Worktree, w work.Work, steps []string) error {
	defaults := s.settingsStore.Get()
	if _, err := wt.SessionStore.Create(ctx, w.SessionID, defaults.DefaultAgentType, defaults.DefaultMode); err != nil {
		return fmt.Errorf("create session: %w", err)
	}

	if err := wt.SessionStore.Update(ctx, w.SessionID, w.Title); err != nil {
		slog.Warn("failed to set session title", "sessionId", w.SessionID, "error", err)
	}

	// Include first step in kickoff message if agent role has steps
	msg := work.BuildKickoffMessageWithSteps(w, steps, w.CurrentStep)
	meta := work.NewMessageMeta(w.Title, w.CurrentStep+1, len(steps))
	if err := wt.ChatClient.SendSystemMessage(ctx, w.SessionID, msg, work.MessageSubtypeKickoff, meta); err != nil {
		if delErr := wt.SessionStore.Delete(ctx, w.SessionID); delErr != nil {
			slog.Error("failed to clean up session after kickoff failure", "sessionId", w.SessionID, "error", delErr)
		}
		return fmt.Errorf("send kickoff message: %w", err)
	}

	return nil
}
