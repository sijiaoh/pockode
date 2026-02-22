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

	if w.Status != work.StatusInProgress && w.Status != work.StatusNeedsInput {
		return fmt.Errorf("%w: can only stop in_progress or needs_input work, got %s", work.ErrInvalidWork, w.Status)
	}

	stoppedStatus := work.StatusStopped
	if err := s.workStore.Update(ctx, id, work.UpdateFields{Status: &stoppedStatus}); err != nil {
		return fmt.Errorf("transition to stopped: %w", err)
	}

	// Terminate the agent process if running.
	// Best-effort: the work is already stopped, so we log but don't fail
	// if the process can't be reached (e.g. worktree already closed).
	if w.SessionID != "" {
		mainWt, err := s.worktreeManager.Get("")
		if err != nil {
			slog.Warn("could not get worktree to terminate process", "workId", id, "sessionId", w.SessionID, "error", err)
		} else {
			mainWt.ProcessManager.Close(w.SessionID)
			s.worktreeManager.Release(mainWt)
		}
	}

	return nil
}
