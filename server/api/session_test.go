package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/pockode/server/session"
)

func TestSessionHandler_List(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	store.Create("session-1")
	store.Create("session-2")

	handler := NewSessionHandler(store)
	req := httptest.NewRequest(http.MethodGet, "/api/sessions", nil)
	rec := httptest.NewRecorder()

	handler.HandleList(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", rec.Code)
	}

	var resp struct {
		Sessions []session.SessionMeta `json:"sessions"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}
	if len(resp.Sessions) != 2 {
		t.Errorf("expected 2 sessions, got %d", len(resp.Sessions))
	}
}

func TestSessionHandler_Create(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	handler := NewSessionHandler(store)

	req := httptest.NewRequest(http.MethodPost, "/api/sessions", nil)
	rec := httptest.NewRecorder()

	handler.HandleCreate(rec, req)

	if rec.Code != http.StatusCreated {
		t.Errorf("expected status 201, got %d", rec.Code)
	}

	var sess session.SessionMeta
	if err := json.NewDecoder(rec.Body).Decode(&sess); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	// Verify ID is a valid UUID
	if _, err := uuid.Parse(sess.ID); err != nil {
		t.Errorf("expected valid UUID, got %q: %v", sess.ID, err)
	}
	if sess.Title != "New Chat" {
		t.Errorf("expected title 'New Chat', got %q", sess.Title)
	}
	// Verify session is not activated yet
	if sess.Activated {
		t.Error("expected session to not be activated")
	}

	// Verify session is persisted in store
	sessions, _ := store.List()
	if len(sessions) != 1 {
		t.Fatalf("expected 1 session in store, got %d", len(sessions))
	}
	if sessions[0].ID != sess.ID {
		t.Errorf("expected stored session ID to match response, got %q vs %q", sessions[0].ID, sess.ID)
	}
}

func TestSessionHandler_Delete(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	sess, _ := store.Create("session-to-delete")

	handler := NewSessionHandler(store)
	mux := http.NewServeMux()
	handler.Register(mux)

	req := httptest.NewRequest(http.MethodDelete, "/api/sessions/"+sess.ID, nil)
	rec := httptest.NewRecorder()

	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Errorf("expected status 204, got %d", rec.Code)
	}

	// Verify deleted
	sessions, _ := store.List()
	if len(sessions) != 0 {
		t.Errorf("expected 0 sessions after delete, got %d", len(sessions))
	}
}

func TestSessionHandler_Update(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	sess, _ := store.Create("session-to-update")

	handler := NewSessionHandler(store)
	mux := http.NewServeMux()
	handler.Register(mux)

	body := strings.NewReader(`{"title":"Updated Title"}`)
	req := httptest.NewRequest(http.MethodPatch, "/api/sessions/"+sess.ID, body)
	rec := httptest.NewRecorder()

	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Errorf("expected status 204, got %d", rec.Code)
	}

	// Verify updated
	sessions, _ := store.List()
	if sessions[0].Title != "Updated Title" {
		t.Errorf("expected title 'Updated Title', got %q", sessions[0].Title)
	}
}

func TestSessionHandler_Update_EmptyTitle(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	sess, _ := store.Create("session-for-empty-title")

	handler := NewSessionHandler(store)
	mux := http.NewServeMux()
	handler.Register(mux)

	body := strings.NewReader(`{"title":""}`)
	req := httptest.NewRequest(http.MethodPatch, "/api/sessions/"+sess.ID, body)
	rec := httptest.NewRecorder()

	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected status 400, got %d", rec.Code)
	}
}

func TestSessionHandler_Update_NotFound(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())

	handler := NewSessionHandler(store)
	mux := http.NewServeMux()
	handler.Register(mux)

	body := strings.NewReader(`{"title":"Some Title"}`)
	req := httptest.NewRequest(http.MethodPatch, "/api/sessions/non-existent-id", body)
	rec := httptest.NewRecorder()

	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Errorf("expected status 404, got %d", rec.Code)
	}
}

func TestSessionHandler_GetHistory(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	sess, _ := store.Create("session-with-history")

	// Add history records
	store.AppendToHistory(sess.ID, map[string]string{"type": "message", "content": "hello"})
	store.AppendToHistory(sess.ID, map[string]string{"type": "text", "content": "world"})

	handler := NewSessionHandler(store)
	mux := http.NewServeMux()
	handler.Register(mux)

	req := httptest.NewRequest(http.MethodGet, "/api/sessions/"+sess.ID+"/history", nil)
	rec := httptest.NewRecorder()

	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", rec.Code)
	}

	var resp struct {
		History []json.RawMessage `json:"history"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}
	if len(resp.History) != 2 {
		t.Errorf("expected 2 records, got %d", len(resp.History))
	}
}
