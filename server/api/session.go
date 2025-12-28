package api

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/google/uuid"
	"github.com/pockode/server/logger"
	"github.com/pockode/server/session"
)

// SessionHandler handles session-related REST endpoints.
type SessionHandler struct {
	store session.Store
}

// NewSessionHandler creates a new session handler.
func NewSessionHandler(store session.Store) *SessionHandler {
	return &SessionHandler{store: store}
}

// HandleList handles GET /api/sessions
func (h *SessionHandler) HandleList(w http.ResponseWriter, r *http.Request) {
	sessions, err := h.store.List()
	if err != nil {
		logger.Error("Failed to list sessions: %v", err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"sessions": sessions,
	})
}

// HandleCreate handles POST /api/sessions
func (h *SessionHandler) HandleCreate(w http.ResponseWriter, r *http.Request) {
	sessionID := uuid.Must(uuid.NewV7()).String()

	sess, err := h.store.Create(r.Context(), sessionID)
	if err != nil {
		logger.Error("Failed to create session: %v", err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(sess)
}

// HandleDelete handles DELETE /api/sessions/{id}
func (h *SessionHandler) HandleDelete(w http.ResponseWriter, r *http.Request) {
	sessionID := r.PathValue("id")
	if sessionID == "" {
		http.Error(w, "Session ID required", http.StatusBadRequest)
		return
	}

	if err := h.store.Delete(r.Context(), sessionID); err != nil {
		logger.Error("Failed to delete session: %v", err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// HandleGetHistory handles GET /api/sessions/{id}/history
func (h *SessionHandler) HandleGetHistory(w http.ResponseWriter, r *http.Request) {
	sessionID := r.PathValue("id")
	if sessionID == "" {
		http.Error(w, "Session ID required", http.StatusBadRequest)
		return
	}

	history, err := h.store.GetHistory(r.Context(), sessionID)
	if err != nil {
		logger.Error("Failed to get history: %v", err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"history": history,
	})
}

// HandleUpdate handles PATCH /api/sessions/{id}
func (h *SessionHandler) HandleUpdate(w http.ResponseWriter, r *http.Request) {
	sessionID := r.PathValue("id")
	if sessionID == "" {
		http.Error(w, "Session ID required", http.StatusBadRequest)
		return
	}

	var req struct {
		Title string `json:"title"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	if req.Title == "" {
		http.Error(w, "Title required", http.StatusBadRequest)
		return
	}

	if err := h.store.Update(r.Context(), sessionID, req.Title); err != nil {
		if errors.Is(err, session.ErrSessionNotFound) {
			http.Error(w, "Session not found", http.StatusNotFound)
			return
		}
		logger.Error("Failed to update session: %v", err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// Register registers session handlers to the given mux.
func (h *SessionHandler) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/sessions", h.HandleList)
	mux.HandleFunc("POST /api/sessions", h.HandleCreate)
	mux.HandleFunc("DELETE /api/sessions/{id}", h.HandleDelete)
	mux.HandleFunc("PATCH /api/sessions/{id}", h.HandleUpdate)
	mux.HandleFunc("GET /api/sessions/{id}/history", h.HandleGetHistory)
}
