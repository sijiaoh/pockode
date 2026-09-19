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
	"github.com/pockode/server/authsession"
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
// returns it with the work directory it serves and the session store it
// authenticates against.
func newTestServer(t *testing.T, serverPassword, mcpToken string) (http.Handler, string, *authsession.Store) {
	t.Helper()
	dataDir := t.TempDir()
	workDir := t.TempDir()
	cmdStore, _ := command.NewStore(dataDir)
	settingsStore, _ := settings.NewStore(dataDir)
	workStore, _ := work.NewFileStore(dataDir)
	agentRoleStore, _ := agentrole.NewFileStore(dataDir)
	sessions, err := authsession.NewStore(dataDir, serverPassword)
	if err != nil {
		t.Fatalf("failed to create session store: %v", err)
	}
	registry := worktree.NewRegistry(workDir, dataDir)
	scopeManager := worktree.NewManager(registry, newAgentRegistry(), dataDir, session.LeaseBudgets{Idle: 10 * time.Minute})
	t.Cleanup(scopeManager.Shutdown)

	workStarter := worktree.NewWorkStarter(scopeManager, agentRoleStore, settingsStore)
	workOps := work.NewOperations(workStore, workStarter, nil, nil)
	workOps.SetSessionDeleter(scopeManager)
	wsHandler := ws.NewRPCHandler(serverPassword, sessions, "test", true, cmdStore, scopeManager, settingsStore, workStore, workOps, work.NewEngine(workStore, work.DefaultMaxNudges), agentRoleStore)
	mcpHandler := mcp.NewAPIHandler(mcp.NewExecutor(workStore, agentRoleStore, workOps, settingsStore, registry), mcpToken)
	transferHandler := filetransfer.NewHandler(registry, slog.Default())

	return newHandler(serverPassword, sessions, true, wsHandler, mcpHandler, transferHandler), workDir, sessions
}

func TestHealthEndpoint(t *testing.T) {
	handler, _, _ := newTestServer(t, "test-password", "mcp-token")
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
	const serverPassword = "test-password"
	handler, _, _ := newTestServer(t, serverPassword, "mcp-token")

	t.Run("returns pong with a valid credential", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/ping", nil)
		req.Header.Set("Authorization", "Bearer "+serverPassword)
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

	t.Run("rejects without a credential", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/ping", nil)
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusUnauthorized {
			t.Errorf("got status %d, want %d", rec.Code, http.StatusUnauthorized)
		}
	})
}

// The browser never sends the password to an HTTP route — it exchanges it for a
// session token over the WebSocket and sends that. Both must therefore open the
// same doors, and nothing else may.
func TestHTTPAcceptsSessionToken(t *testing.T) {
	const serverPassword = "test-password"
	handler, _, sessions := newTestServer(t, serverPassword, "mcp-token")

	token, err := sessions.Issue()
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}

	tests := []struct {
		name       string
		credential string
		wantStatus int
	}{
		{name: "session token", credential: token, wantStatus: http.StatusOK},
		{name: "password", credential: serverPassword, wantStatus: http.StatusOK},
		{name: "neither", credential: token + "-tampered", wantStatus: http.StatusUnauthorized},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/api/ping", nil)
			req.Header.Set("Authorization", "Bearer "+tt.credential)
			rec := httptest.NewRecorder()

			handler.ServeHTTP(rec, req)

			if rec.Code != tt.wantStatus {
				t.Errorf("got status %d, want %d", rec.Code, tt.wantStatus)
			}
		})
	}
}

// TestFileTransferEndpoints verifies the wiring of the file transfer routes:
// they are mounted where the frontend expects them, and — unlike /ws and the
// MCP API — they carry no auth of their own, so the middleware must be what
// keeps the workspace off the open network.
func TestFileTransferEndpoints(t *testing.T) {
	const serverPassword = "test-password"
	handler, workDir, _ := newTestServer(t, serverPassword, "mcp-token")
	if err := os.WriteFile(filepath.Join(workDir, "a.txt"), []byte("hello"), 0644); err != nil {
		t.Fatalf("failed to create file: %v", err)
	}

	t.Run("downloads with a valid credential", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/files/download?path=a.txt", nil)
		req.Header.Set("Authorization", "Bearer "+serverPassword)
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("got status %d, want %d (body %q)", rec.Code, http.StatusOK, rec.Body.String())
		}
		if rec.Body.String() != "hello" {
			t.Errorf("got body %q, want %q", rec.Body.String(), "hello")
		}
	})

	t.Run("rejects transfers without a credential", func(t *testing.T) {
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
// MCP token, and is NOT accessible with the user password or no credential. This
// guards the auth-bypass + separate-token design end to end.
func TestMCPEndpoint(t *testing.T) {
	const userPassword = "test-password"
	const mcpToken = "mcp-token"
	handler, _, _ := newTestServer(t, userPassword, mcpToken)

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

	t.Run("rejects the user password", func(t *testing.T) {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, newReq(userPassword))
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("got status %d, want %d", rec.Code, http.StatusUnauthorized)
		}
	})

	t.Run("rejects without a credential", func(t *testing.T) {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, newReq(""))
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("got status %d, want %d", rec.Code, http.StatusUnauthorized)
		}
	})
}
