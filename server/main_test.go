package main

import (
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/pockode/server/agent/claude"
	"github.com/pockode/server/command"
	"github.com/pockode/server/settings"
	"github.com/pockode/server/ticket"
	"github.com/pockode/server/worktree"
	"github.com/pockode/server/ws"
)

func TestFindAvailablePort(t *testing.T) {
	t.Run("returns requested port when available", func(t *testing.T) {
		port := findAvailablePort(19870)
		if port != 19870 {
			t.Errorf("got port %d, want 19870", port)
		}
	})

	t.Run("increments when port is occupied", func(t *testing.T) {
		ln, err := net.Listen("tcp", ":19871")
		if err != nil {
			t.Fatalf("failed to occupy port: %v", err)
		}
		defer ln.Close()

		port := findAvailablePort(19871)
		if port != 19872 {
			t.Errorf("got port %d, want 19872", port)
		}
	})
}

func TestHealthEndpoint(t *testing.T) {
	dataDir := t.TempDir()
	workDir := t.TempDir()
	cmdStore, _ := command.NewStore(dataDir)
	settingsStore, _ := settings.NewStore(dataDir)
	ticketStore, _ := ticket.NewFileStore(dataDir)
	roleStore, _ := ticket.NewFileRoleStore(dataDir)
	registry := worktree.NewRegistry(workDir, dataDir)
	scopeManager := worktree.NewManager(registry, claude.New(), dataDir, 10*time.Minute, ticketStore, roleStore)
	defer scopeManager.Shutdown()

	wsHandler := ws.NewRPCHandler("test-token", "test", true, cmdStore, scopeManager, settingsStore)
	handler := newHandler("test-token", true, wsHandler)
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
	dataDir := t.TempDir()
	workDir := t.TempDir()
	cmdStore, _ := command.NewStore(dataDir)
	settingsStore, _ := settings.NewStore(dataDir)
	ticketStore, _ := ticket.NewFileStore(dataDir)
	roleStore, _ := ticket.NewFileRoleStore(dataDir)
	registry := worktree.NewRegistry(workDir, dataDir)
	scopeManager := worktree.NewManager(registry, claude.New(), dataDir, 10*time.Minute, ticketStore, roleStore)
	defer scopeManager.Shutdown()

	wsHandler := ws.NewRPCHandler(token, "test", true, cmdStore, scopeManager, settingsStore)
	handler := newHandler(token, true, wsHandler)

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
