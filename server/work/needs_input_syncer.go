package work

import (
	"context"
	"log/slog"
)

// NeedsInputSyncer auto-transitions work status alongside a session's
// needs_input flag. A session entering needs_input pauses its in_progress work.
// The other direction is not the mirror image it looks like: it is driven by a
// user acting, never by the session going quiet or dying — see SyncNeedsInput.
type NeedsInputSyncer struct {
	store Store
}

func NewNeedsInputSyncer(store Store) *NeedsInputSyncer {
	return &NeedsInputSyncer{store: store}
}

func (s *NeedsInputSyncer) SyncNeedsInput(ctx context.Context, sessionID string, needsInput bool) {
	w, found, err := s.store.FindBySessionID(sessionID)
	if err != nil {
		slog.Warn("failed to find work by session for needs_input sync", "sessionId", sessionID, "error", err)
		return
	}
	if !found {
		return
	}

	if needsInput {
		if w.Status != StatusInProgress {
			return
		}
		if err := s.store.MarkNeedsInput(ctx, w.ID); err != nil {
			slog.Warn("failed to auto-transition work to needs_input",
				"workId", w.ID, "from", w.Status, "error", err)
		} else {
			slog.Info("auto-transitioned work to needs_input",
				"workId", w.ID, "from", w.Status, "sessionId", sessionID)
		}
	} else {
		// Resumes more than it paused, and deliberately. The only caller in this
		// direction is SessionListWatcher.HandleUserAction, which is the single
		// entry point for "the user acted on this session" — so a user is acting
		// right now, and that is the one thing both paused statuses are defined
		// to be woken by. A message arriving during a child wait means "stop
		// waiting and listen to me", so waiting is resumed as well.
		//
		// stopped is left out: it means the process died, and the AutoResumer's
		// process-running branch owns that one so the retry bookkeeping is reset
		// along with it.
		if w.Status != StatusNeedsInput && w.Status != StatusWaiting {
			return
		}
		if err := s.store.MarkRunning(ctx, w.ID); err != nil {
			slog.Warn("failed to auto-transition work to in_progress",
				"workId", w.ID, "from", w.Status, "error", err)
		} else {
			slog.Info("auto-transitioned work to in_progress",
				"workId", w.ID, "from", w.Status, "sessionId", sessionID)
		}
	}
}
