package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/pockode/server/agent/claude"
	"github.com/pockode/server/command"
	"github.com/pockode/server/process"
	"github.com/pockode/server/session"
	"github.com/pockode/server/ws"
)

func TestHealthEndpoint(t *testing.T) {
	tempDir := t.TempDir()
	store, _ := session.NewFileStore(tempDir)
	cmdStore, _ := command.NewStore(tempDir)
	manager := process.NewManager(claude.New(), "/tmp", store, 10*time.Minute)
	defer manager.Shutdown()

	wsHandler := ws.NewRPCHandler("test-token", manager, true, store, cmdStore, "/tmp")
	handler := newHandler("test-token", manager, true, store, "/tmp", wsHandler)
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("got status %d, want %d", rec.Code, http.StatusOK)
	}
	if rec.Body.String() != "ok" {
		t.Errorf("got body %q, want %q", rec.Body.String(), "ok")
	}
}

func TestPingEndpoint(t *testing.T) {
	const token = "test-token"
	tempDir := t.TempDir()
	store, _ := session.NewFileStore(tempDir)
	cmdStore, _ := command.NewStore(tempDir)
	manager := process.NewManager(claude.New(), "/tmp", store, 10*time.Minute)
	defer manager.Shutdown()

	wsHandler := ws.NewRPCHandler(token, manager, true, store, cmdStore, "/tmp")
	handler := newHandler(token, manager, true, store, "/tmp", wsHandler)

	t.Run("returns pong with valid token", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/ping", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Errorf("got status %d, want %d", rec.Code, http.StatusOK)
		}
		if rec.Header().Get("Content-Type") != "application/json" {
			t.Errorf("got content-type %q, want %q", rec.Header().Get("Content-Type"), "application/json")
		}
		want := `{"message":"pong"}`
		if rec.Body.String() != want {
			t.Errorf("got body %q, want %q", rec.Body.String(), want)
		}
	})

	t.Run("rejects without token", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/ping", nil)
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusUnauthorized {
			t.Errorf("got status %d, want %d", rec.Code, http.StatusUnauthorized)
		}
	})
}
