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

func (s *NeedsInputSyncer) SyncNeedsInput(sessionID string, needsInput bool) {
	w, found, err := s.store.FindBySessionID(sessionID)
	if err != nil {
		slog.Warn("failed to find work by session for needs_input sync", "sessionId", sessionID, "error", err)
		return
	}
	if !found {
		return
	}

	var targetStatus WorkStatus
	if needsInput {
		if w.Status != StatusInProgress {
			return
		}
		targetStatus = StatusNeedsInput
	} else {
		if w.Status != StatusNeedsInput {
			return
		}
		targetStatus = StatusInProgress
	}

	if err := s.store.Update(context.Background(), w.ID, UpdateFields{Status: &targetStatus}); err != nil {
		slog.Warn("failed to auto-transition work needs_input",
			"workId", w.ID, "from", w.Status, "to", targetStatus, "error", err)
	} else {
		slog.Info("auto-transitioned work needs_input",
			"workId", w.ID, "from", w.Status, "to", targetStatus, "sessionId", sessionID)
	}
}
