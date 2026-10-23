package main

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/pockode/server/agent"
	"github.com/pockode/server/agent/claude"
	"github.com/pockode/server/agentrole"
	"github.com/pockode/server/authguard"
	"github.com/pockode/server/authsession"
	"github.com/pockode/server/cliauth"
	"github.com/pockode/server/cliupdate"
	"github.com/pockode/server/command"
	"github.com/pockode/server/filetransfer"
	"github.com/pockode/server/mcp"
	"github.com/pockode/server/rpc"
	"github.com/pockode/server/schedule"
	"github.com/pockode/server/session"
	"github.com/pockode/server/settings"
	"github.com/pockode/server/work"
	"github.com/pockode/server/worktree"
	"github.com/pockode/server/ws"
	"github.com/sourcegraph/jsonrpc2"
)

func newAgentRegistry() *agent.Registry {
	r := agent.NewRegistry()
	r.Register(session.AgentTypeClaude, claude.New())
	return r
}

// newTestServer builds the production handler over throwaway directories and
// returns it with the work directory it serves, the session store it
// authenticates against, and the raw handler that issues capabilities.
func newTestServer(t *testing.T, serverPassword, mcpToken string) (http.Handler, string, *authsession.Store, *filetransfer.RawHandler) {
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
	scheduleStore, _ := schedule.NewFileStore(dataDir, agentRoleStore)
	scheduler := schedule.NewScheduler(scheduleStore, workOps)
	workOps.SetRunRecorder(scheduler)
	transferHandler := filetransfer.NewHandler(registry, slog.Default())
	attachmentHandler := filetransfer.NewAttachmentHandler(scopeManager, worktree.ErrWorktreeNotFound, worktree.ErrSessionNotFound, slog.Default())
	rawHandler := filetransfer.NewRawHandler(sessions, transferHandler, attachmentHandler, dataDir)
	wsHandler := ws.NewRPCHandler(serverPassword, authguard.New(), sessions, "test", func() string { return "" }, authsession.NewTickets(), rawHandler, true, cmdStore, scopeManager, settingsStore, workStore, workOps, work.NewEngine(workStore, work.DefaultMaxNudges), agentRoleStore, scheduleStore, scheduler, cliauth.NewService(slog.Default()), cliupdate.NewService(slog.Default(), nil, nil))
	mcpHandler := mcp.NewAPIHandler(mcp.NewExecutor(workStore, agentRoleStore, workOps, settingsStore, registry, scopeManager), mcpToken)
	return newHandler(serverPassword, authguard.New(), sessions, true, wsHandler, mcpHandler, transferHandler, attachmentHandler, rawHandler), workDir, sessions, rawHandler
}

func TestHealthEndpoint(t *testing.T) {
	handler, _, _, _ := newTestServer(t, "test-password", "mcp-token")
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
	handler, _, _, _ := newTestServer(t, serverPassword, "mcp-token")

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
	handler, _, sessions, _ := newTestServer(t, serverPassword, "mcp-token")

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
	handler, workDir, _, _ := newTestServer(t, serverPassword, "mcp-token")
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

	// The image routes are fetched by the client rather than saved, and answer
	// for content that is not in the workspace — so they are checked for being
	// mounted (a JSON refusal from the handler, not the mux's 404 or 405) as
	// well as for being behind the middleware.
	imageRoutes := []string{
		"/api/chat/attachments?session_id=none&id=none",
		"/api/git/show/file?hash=0000000&path=a.png",
	}

	t.Run("mounts the image routes", func(t *testing.T) {
		for _, target := range imageRoutes {
			req := httptest.NewRequest(http.MethodGet, target, nil)
			req.Header.Set("Authorization", "Bearer "+serverPassword)
			rec := httptest.NewRecorder()

			handler.ServeHTTP(rec, req)

			if got := rec.Header().Get("Content-Type"); got != "application/json" {
				t.Errorf("GET %s: got status %d, Content-Type %q, want the handler's JSON error (body %q)", target, rec.Code, got, rec.Body.String())
			}
		}
	})

	t.Run("rejects transfers without a credential", func(t *testing.T) {
		reqs := []*http.Request{
			httptest.NewRequest(http.MethodGet, "/api/files/download?path=a.txt", nil),
			httptest.NewRequest(http.MethodPost, "/api/files/upload", strings.NewReader("")),
			httptest.NewRequest(http.MethodPost, "/api/chat/attachments", strings.NewReader("")),
		}
		for _, target := range imageRoutes {
			reqs = append(reqs, httptest.NewRequest(http.MethodGet, target, nil))
		}
		for _, req := range reqs {
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)
			if rec.Code != http.StatusUnauthorized {
				t.Errorf("%s %s: got status %d, want %d", req.Method, req.URL.Path, rec.Code, http.StatusUnauthorized)
			}
		}
	})
}

// The raw endpoint is the one /api route that takes no Authorization header —
// its capability is the credential — and the one whose every response must
// carry its sandbox, which only holds if it answers before the mux can.
func TestRawEndpoint(t *testing.T) {
	handler, workDir, sessions, rawHandler := newTestServer(t, "test-password", "mcp-token")
	if err := os.WriteFile(filepath.Join(workDir, "a.txt"), []byte("hello"), 0644); err != nil {
		t.Fatalf("failed to create file: %v", err)
	}
	session, err := sessions.Issue()
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	capability, _, err := rawHandler.Issue(session, filetransfer.RawGrant{
		Origin: filetransfer.RawOriginFile, Scope: filetransfer.RawScopeFile, Path: "a.txt",
	})
	if err != nil {
		t.Fatalf("Issue capability: %v", err)
	}

	// Outside dev mode the SPA handler is in front, and it must hand the route
	// on rather than answer with index.html.
	for mode, handler := range map[string]http.Handler{"dev": handler, "production": newSPAHandler(handler)} {
		t.Run(mode, func(t *testing.T) { checkRawEndpoint(t, handler, capability) })
	}
}

func checkRawEndpoint(t *testing.T, handler http.Handler, capability string) {
	t.Helper()
	for _, tc := range []struct {
		target string
		status int
	}{
		{filetransfer.RawPath(capability, "a.txt"), http.StatusOK},
		// The mux would answer these with a redirect and a 404 of its own.
		{filetransfer.RawPathPrefix + capability + "/../a.txt", http.StatusBadRequest},
		{filetransfer.RawPathPrefix + capability, http.StatusBadRequest},
		{"/api/raw", http.StatusNotFound},
		// Not the middleware's 401: there is no Authorization to check.
		{filetransfer.RawPath("forged", "a.txt"), http.StatusNotFound},
	} {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, tc.target, nil))
		if rec.Code != tc.status {
			t.Errorf("GET %s: got status %d, want %d (body %q)", tc.target, rec.Code, tc.status, rec.Body.String())
		}
		if got := rec.Header().Get("Content-Security-Policy"); got == "" {
			t.Errorf("GET %s: no Content-Security-Policy", tc.target)
		}
	}
}

// TestRawCapabilityRPC holds the wiring end to end: what the WebSocket issues
// is what /api/raw resolves, so the two must share one RawHandler — and the
// path handed back is one a browser can load as it stands.
func TestRawCapabilityRPC(t *testing.T) {
	const serverPassword = "test-password"
	handler, workDir, _, _ := newTestServer(t, serverPassword, "mcp-token")
	if err := os.MkdirAll(filepath.Join(workDir, "site"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workDir, "site", "style.css"), []byte("p{}"), 0644); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/ws", nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	call := func(id int, method string, params any) (json.RawMessage, *jsonrpc2.Error) {
		t.Helper()
		if err := wsjson.Write(ctx, conn, map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params}); err != nil {
			t.Fatalf("write %s: %v", method, err)
		}
		var resp struct {
			Result json.RawMessage `json:"result"`
			Error  *jsonrpc2.Error `json:"error"`
		}
		if err := wsjson.Read(ctx, conn, &resp); err != nil {
			t.Fatalf("read %s: %v", method, err)
		}
		return resp.Result, resp.Error
	}

	if _, rpcErr := call(1, "auth", rpc.AuthParams{Password: serverPassword}); rpcErr != nil {
		t.Fatalf("auth: %v", rpcErr)
	}

	// A root scope with a path is refused by the RawHandler itself, so this
	// also shows the RPC reached the real one.
	if _, rpcErr := call(2, "raw.capability", rpc.RawCapabilityParams{Origin: "file", Scope: "root", Path: "site"}); rpcErr == nil || rpcErr.Code != jsonrpc2.CodeInvalidParams {
		t.Errorf("root capability with a path: error = %v, want invalid params", rpcErr)
	}

	raw, rpcErr := call(3, "raw.capability", rpc.RawCapabilityParams{Origin: "file", Scope: "root"})
	if rpcErr != nil {
		t.Fatalf("raw.capability: %v", rpcErr)
	}
	var result rpc.RawCapabilityResult
	if err := json.Unmarshal(raw, &result); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	resp, err := http.Get(server.URL + result.Path + "site/style.css")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK || string(body) != "p{}" {
		t.Errorf("GET %ssite/style.css = %d %q, want 200 \"p{}\"", result.Path, resp.StatusCode, body)
	}
	// Over a real connection the body goes out through ReadFrom rather than
	// Write, which must not lose the sandbox either.
	if got := resp.Header.Get("Content-Security-Policy"); got == "" {
		t.Error("GET over the wire: no Content-Security-Policy")
	}
}

// TestMCPEndpoint verifies the local MCP API wiring: it is reachable with the
// MCP token, and is NOT accessible with the user password or no credential. This
// guards the auth-bypass + separate-token design end to end.
func TestMCPEndpoint(t *testing.T) {
	const userPassword = "test-password"
	const mcpToken = "mcp-token"
	handler, _, _, _ := newTestServer(t, userPassword, mcpToken)

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
