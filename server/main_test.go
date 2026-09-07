package main

import (
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/agent/claude"
	"github.com/pockode/server/agentrole"
	"github.com/pockode/server/command"
	"github.com/pockode/server/filetransfer"
	"github.com/pockode/server/mcp"
	"github.com/pockode/server/session"
	"github.com/pockode/server/settings"
	"github.com/pockode/server/work"
	"github.com/pockode/server/worktree"
	"github.com/pockode/server/ws"
)

func newAgentRegistry() *agent.Registry {
	r := agent.NewRegistry()
	r.Register(session.AgentTypeClaude, claude.New())
	return r
}

// newTestServer builds the production handler over throwaway directories and
// returns it with the work directory it serves.
func newTestServer(t *testing.T, userToken, mcpToken string) (http.Handler, string) {
	t.Helper()
	dataDir := t.TempDir()
	workDir := t.TempDir()
	cmdStore, _ := command.NewStore(dataDir)
	settingsStore, _ := settings.NewStore(dataDir)
	workStore, _ := work.NewFileStore(dataDir)
	agentRoleStore, _ := agentrole.NewFileStore(dataDir)
	registry := worktree.NewRegistry(workDir, dataDir)
	scopeManager := worktree.NewManager(registry, newAgentRegistry(), dataDir, 10*time.Minute)
	t.Cleanup(scopeManager.Shutdown)

	workStarter := worktree.NewWorkStarter(scopeManager, agentRoleStore, settingsStore)
	workStopper := worktree.NewWorkStopper(scopeManager, workStore)
	workOps := work.NewOperations(workStore, workStarter, nil)
	wsHandler := ws.NewRPCHandler(userToken, "test", true, cmdStore, scopeManager, settingsStore, workStore, workOps, workStopper, agentRoleStore)
	mcpHandler := mcp.NewAPIHandler(mcp.NewExecutor(workStore, agentRoleStore, workOps, nil, settingsStore), mcpToken)
	transferHandler := filetransfer.NewHandler(registry, slog.Default())

	return newHandler(userToken, true, wsHandler, mcpHandler, transferHandler), workDir
}

func TestHealthEndpoint(t *testing.T) {
	handler, _ := newTestServer(t, "test-token", "mcp-token")
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
	handler, _ := newTestServer(t, token, "mcp-token")

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

// TestFileTransferEndpoints verifies the wiring of the file transfer routes:
// they are mounted where the frontend expects them, and — unlike /ws and the
// MCP API — they carry no auth of their own, so the middleware must be what
// keeps the workspace off the open network.
func TestFileTransferEndpoints(t *testing.T) {
	const token = "test-token"
	handler, workDir := newTestServer(t, token, "mcp-token")
	if err := os.WriteFile(filepath.Join(workDir, "a.txt"), []byte("hello"), 0644); err != nil {
		t.Fatalf("failed to create file: %v", err)
	}

	t.Run("downloads with a valid token", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/files/download?path=a.txt", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("got status %d, want %d (body %q)", rec.Code, http.StatusOK, rec.Body.String())
		}
		if rec.Body.String() != "hello" {
			t.Errorf("got body %q, want %q", rec.Body.String(), "hello")
		}
	})

	t.Run("rejects transfers without a token", func(t *testing.T) {
		for _, req := range []*http.Request{
			httptest.NewRequest(http.MethodGet, "/api/files/download?path=a.txt", nil),
			httptest.NewRequest(http.MethodPost, "/api/files/upload", strings.NewReader("")),
		} {
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)
			if rec.Code != http.StatusUnauthorized {
				t.Errorf("%s %s: got status %d, want %d", req.Method, req.URL.Path, rec.Code, http.StatusUnauthorized)
			}
		}
	})
}

// TestMCPEndpoint verifies the local MCP API wiring: it is reachable with the
// MCP token, and is NOT accessible with the user --auth-token or no token. This
// guards the auth-bypass + separate-token design end to end.
func TestMCPEndpoint(t *testing.T) {
	const userToken = "test-token"
	const mcpToken = "mcp-token"
	handler, _ := newTestServer(t, userToken, mcpToken)

	const path = "/api/mcp/tools/call"
	body := `{"name":"agent_role_list","arguments":{}}`

	newReq := func(auth string) *http.Request {
		req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
		if auth != "" {
			req.Header.Set("Authorization", "Bearer "+auth)
		}
		return req
	}

	t.Run("accepts MCP token", func(t *testing.T) {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, newReq(mcpToken))
		if rec.Code != http.StatusOK {
			t.Fatalf("got status %d, want %d (body: %s)", rec.Code, http.StatusOK, rec.Body.String())
		}
	})

	t.Run("rejects user --auth-token", func(t *testing.T) {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, newReq(userToken))
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("got status %d, want %d", rec.Code, http.StatusUnauthorized)
		}
	})

	t.Run("rejects without token", func(t *testing.T) {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, newReq(""))
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("got status %d, want %d", rec.Code, http.StatusUnauthorized)
		}
	})
}
