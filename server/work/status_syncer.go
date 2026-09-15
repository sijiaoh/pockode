package work

import (
	"context"
	"log/slog"
)

// StatusSyncer moves a work item's status in response to things that happen to
// the session it is running in. Each method is one such event, named after it:
// the two are not a flag being set and unset, they guard different statuses and
// nothing but the session lookup is shared.
type StatusSyncer struct {
	store Store
}

func NewStatusSyncer(store Store) *StatusSyncer {
	return &StatusSyncer{store: store}
}

// HandlePromptRaised records that the session put a question to the user. Only
// in_progress work is paused by it: a work already parked on something else is
// not waiting on this prompt.
func (s *StatusSyncer) HandlePromptRaised(ctx context.Context, sessionID string) {
	w, found := s.findWork(sessionID)
	if !found || w.Status != StatusInProgress {
		return
	}

	if err := s.store.MarkNeedsInput(ctx, w.ID); err != nil {
		slog.Warn("failed to auto-transition work to needs_input",
			"workId", w.ID, "from", w.Status, "error", err)
		return
	}
	slog.Info("auto-transitioned work to needs_input",
		"workId", w.ID, "from", w.Status, "sessionId", sessionID)
}

// HandleUserAction records that the user acted on the session.
//
// It resumes more than HandlePromptRaised paused, and deliberately: a user is
// acting right now, and that is the one thing both paused statuses are defined
// to be woken by. A message arriving during a child wait means "stop waiting and
// listen to me", so waiting is resumed as well.
//
// stopped is left out: it means the process died, and the AutoResumer's
// process-running branch owns that one so the retry bookkeeping is reset along
// with it.
func (s *StatusSyncer) HandleUserAction(ctx context.Context, sessionID string) {
	w, found := s.findWork(sessionID)
	if !found || (w.Status != StatusNeedsInput && w.Status != StatusWaiting) {
		return
	}

	if err := s.store.MarkRunning(ctx, w.ID); err != nil {
		slog.Warn("failed to auto-transition work to in_progress",
			"workId", w.ID, "from", w.Status, "error", err)
		return
	}
	slog.Info("auto-transitioned work to in_progress",
		"workId", w.ID, "from", w.Status, "sessionId", sessionID)
}

func (s *StatusSyncer) findWork(sessionID string) (Work, bool) {
	w, found, err := s.store.FindBySessionID(sessionID)
	if err != nil {
		slog.Warn("failed to find work by session for status sync", "sessionId", sessionID, "error", err)
		return Work{}, false
	}
	return w, found
}
