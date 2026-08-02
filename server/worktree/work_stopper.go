package worktree

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/pockode/server/work"
)

// WorkStopper stops a running work item by transitioning it to stopped
// and terminating the associated agent process.
type WorkStopper struct {
	worktreeManager *Manager
	workStore       work.Store
}

func NewWorkStopper(wm *Manager, ws work.Store) *WorkStopper {
	return &WorkStopper{
		worktreeManager: wm,
		workStore:       ws,
	}
}

// HandleWorkStop transitions the work to stopped and kills its agent process.
func (s *WorkStopper) HandleWorkStop(ctx context.Context, id string) error {
	w, found, err := s.workStore.Get(id)
	if err != nil {
		return fmt.Errorf("get work: %w", err)
	}
	if !found {
		return work.ErrWorkNotFound
	}

	if err := s.workStore.Stop(ctx, id); err != nil {
		return err
	}

	// Terminate the agent process if running.
	// Best-effort: the work is already stopped, so we log but don't fail
	// if the process can't be reached (e.g. worktree already closed).
	if w.SessionID != "" {
		wt, err := s.worktreeManager.Get(w.Worktree)
		if err != nil {
			slog.Warn("could not get worktree to terminate process", "workId", id, "worktree", w.Worktree, "sessionId", w.SessionID, "error", err)
		} else {
			wt.ProcessManager.Close(w.SessionID)
			s.worktreeManager.Release(wt)
		}
	}

	return nil
}
