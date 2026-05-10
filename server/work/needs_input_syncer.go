package work

import (
	"context"
	"log/slog"
)

// NeedsInputSyncer auto-transitions work status in response to session
// needs_input changes. When a session enters needs_input, the associated
// in_progress work transitions to needs_input. When the session resumes
// (running), the work transitions back to in_progress.
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
		if w.Status == StatusNeedsInput {
			if err := s.store.Resume(ctx, w.ID); err != nil {
				slog.Warn("failed to auto-transition work from needs_input",
					"workId", w.ID, "from", w.Status, "error", err)
			} else {
				slog.Info("auto-transitioned work from needs_input",
					"workId", w.ID, "from", w.Status, "sessionId", sessionID)
			}
		} else if w.Status == StatusWaiting {
			if err := s.store.ResumeFromWaiting(ctx, w.ID); err != nil {
				slog.Warn("failed to auto-transition work from waiting",
					"workId", w.ID, "from", w.Status, "error", err)
			} else {
				slog.Info("auto-transitioned work from waiting",
					"workId", w.ID, "from", w.Status, "sessionId", sessionID)
			}
		}
	}
}
