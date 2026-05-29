package manager

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/pockode/server/globalconfig"
)

func TestParseWorkspacePath(t *testing.T) {
	tests := []struct {
		name          string
		path          string
		wantID        string
		wantRemaining string
		wantOK        bool
	}{
		{
			name:          "workspace WebSocket",
			path:          "/w/abc123/ws",
			wantID:        "abc123",
			wantRemaining: "/ws",
			wantOK:        true,
		},
		{
			name:          "workspace API",
			path:          "/w/abc123/api/ping",
			wantID:        "abc123",
			wantRemaining: "/api/ping",
			wantOK:        true,
		},
		{
			name:          "workspace root",
			path:          "/w/abc123/",
			wantID:        "abc123",
			wantRemaining: "/",
			wantOK:        true,
		},
		{
			name:          "workspace no trailing slash",
			path:          "/w/abc123",
			wantID:        "abc123",
			wantRemaining: "/",
			wantOK:        true,
		},
		{
			name:          "workspace nested path",
			path:          "/w/workspace-id/api/v1/data",
			wantID:        "workspace-id",
			wantRemaining: "/api/v1/data",
			wantOK:        true,
		},
		{
			name:          "not workspace path",
			path:          "/api/ping",
			wantID:        "",
			wantRemaining: "",
			wantOK:        false,
		},
		{
			name:          "empty after w",
			path:          "/w/",
			wantID:        "",
			wantRemaining: "",
			wantOK:        false,
		},
		{
			name:          "just w",
			path:          "/w",
			wantID:        "",
			wantRemaining: "",
			wantOK:        false,
		},
		{
			name:          "wrong prefix",
			path:          "/workspace/abc",
			wantID:        "",
			wantRemaining: "",
			wantOK:        false,
		},
		{
			name:          "root path",
			path:          "/",
			wantID:        "",
			wantRemaining: "",
			wantOK:        false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotID, gotRemaining, gotOK := parseWorkspacePath(tt.path)
			if gotID != tt.wantID {
				t.Errorf("parseWorkspacePath(%q) ID = %q, want %q", tt.path, gotID, tt.wantID)
			}
			if gotRemaining != tt.wantRemaining {
				t.Errorf("parseWorkspacePath(%q) remaining = %q, want %q", tt.path, gotRemaining, tt.wantRemaining)
			}
			if gotOK != tt.wantOK {
				t.Errorf("parseWorkspacePath(%q) ok = %v, want %v", tt.path, gotOK, tt.wantOK)
			}
		})
	}
}

func TestRouterNotFoundForNonWorkspacePaths(t *testing.T) {
	tmpDir := t.TempDir()
	t.Setenv("POCKODE_HOME", tmpDir)
	globalconfig.ResetDir()

	manager, err := NewManager(ManagerConfig{})
	if err != nil {
		t.Fatalf("NewManager() error = %v", err)
	}

	notFoundCalled := false
	notFoundHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		notFoundCalled = true
		w.WriteHeader(http.StatusNotFound)
	})

	router := NewRouter(RouterConfig{
		Manager:  manager,
		NotFound: notFoundHandler,
	})

	tests := []string{"/", "/api/ping", "/ws", "/health"}
	for _, path := range tests {
		notFoundCalled = false
		req := httptest.NewRequest("GET", path, nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		if !notFoundCalled {
			t.Errorf("path %q should call notFound handler", path)
		}
	}
}

func TestRouterWorkspaceNotFound(t *testing.T) {
	tmpDir := t.TempDir()
	t.Setenv("POCKODE_HOME", tmpDir)
	globalconfig.ResetDir()

	manager, err := NewManager(ManagerConfig{})
	if err != nil {
		t.Fatalf("NewManager() error = %v", err)
	}

	router := NewRouter(RouterConfig{
		Manager: manager,
	})

	req := httptest.NewRequest("GET", "/w/nonexistent/ws", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusNotFound {
		t.Errorf("expected status 404, got %d", w.Code)
	}
}

func TestRouterStartsWorkerAndRoutes(t *testing.T) {
	tmpDir := t.TempDir()
	t.Setenv("POCKODE_HOME", tmpDir)
	globalconfig.ResetDir()

	// Create a workspace directory
	wsDir := filepath.Join(tmpDir, "my-workspace")
	if err := os.MkdirAll(wsDir, 0755); err != nil {
		t.Fatalf("failed to create workspace dir: %v", err)
	}

	manager, err := NewManager(ManagerConfig{
		Token:   "test-token",
		Version: "test",
	})
	if err != nil {
		t.Fatalf("NewManager() error = %v", err)
	}

	// Register workspace
	ws, err := manager.WorkspaceStore().Register(wsDir, "My Workspace")
	if err != nil {
		t.Fatalf("Register() error = %v", err)
	}

	router := NewRouter(RouterConfig{
		Manager: manager,
	})

	// Request API endpoint
	req := httptest.NewRequest("GET", "/w/"+ws.ID+"/api/ping", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d: %s", w.Code, w.Body.String())
	}

	// Verify worker was started
	worker := manager.GetWorker(ws.ID)
	if worker == nil {
		t.Error("expected worker to be started")
	} else if worker.State() != WorkerStateRunning {
		t.Errorf("expected worker state running, got %s", worker.State())
	}

	// Cleanup
	manager.Shutdown()
}

func TestRouterStaticRedirect(t *testing.T) {
	tmpDir := t.TempDir()
	t.Setenv("POCKODE_HOME", tmpDir)
	globalconfig.ResetDir()

	wsDir := filepath.Join(tmpDir, "my-workspace")
	if err := os.MkdirAll(wsDir, 0755); err != nil {
		t.Fatalf("failed to create workspace dir: %v", err)
	}

	manager, err := NewManager(ManagerConfig{
		Token:   "test-token",
		Version: "test",
	})
	if err != nil {
		t.Fatalf("NewManager() error = %v", err)
	}
	defer manager.Shutdown()

	ws, err := manager.WorkspaceStore().Register(wsDir, "My Workspace")
	if err != nil {
		t.Fatalf("Register() error = %v", err)
	}

	router := NewRouter(RouterConfig{
		Manager: manager,
	})

	req := httptest.NewRequest("GET", "/w/"+ws.ID+"/", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	// Should redirect to shared SPA with workspace query param
	if w.Code != http.StatusTemporaryRedirect {
		t.Errorf("expected redirect (307), got %d", w.Code)
	}

	location := w.Header().Get("Location")
	expected := "/?workspace=" + ws.ID
	if location != expected {
		t.Errorf("expected redirect to %q, got %q", expected, location)
	}
}

func TestRouterHealthEndpoint(t *testing.T) {
	tmpDir := t.TempDir()
	t.Setenv("POCKODE_HOME", tmpDir)
	globalconfig.ResetDir()

	wsDir := filepath.Join(tmpDir, "my-workspace")
	if err := os.MkdirAll(wsDir, 0755); err != nil {
		t.Fatalf("failed to create workspace dir: %v", err)
	}

	manager, err := NewManager(ManagerConfig{
		Token:   "test-token",
		Version: "test",
	})
	if err != nil {
		t.Fatalf("NewManager() error = %v", err)
	}
	defer manager.Shutdown()

	ws, err := manager.WorkspaceStore().Register(wsDir, "My Workspace")
	if err != nil {
		t.Fatalf("Register() error = %v", err)
	}

	router := NewRouter(RouterConfig{
		Manager: manager,
	})

	req := httptest.NewRequest("GET", "/w/"+ws.ID+"/health", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", w.Code)
	}
	if w.Body.String() != "ok" {
		t.Errorf("expected body 'ok', got %q", w.Body.String())
	}
}

func TestRouterAPIUnknownEndpoint(t *testing.T) {
	tmpDir := t.TempDir()
	t.Setenv("POCKODE_HOME", tmpDir)
	globalconfig.ResetDir()

	wsDir := filepath.Join(tmpDir, "my-workspace")
	if err := os.MkdirAll(wsDir, 0755); err != nil {
		t.Fatalf("failed to create workspace dir: %v", err)
	}

	manager, err := NewManager(ManagerConfig{
		Token:   "test-token",
		Version: "test",
	})
	if err != nil {
		t.Fatalf("NewManager() error = %v", err)
	}
	defer manager.Shutdown()

	ws, err := manager.WorkspaceStore().Register(wsDir, "My Workspace")
	if err != nil {
		t.Fatalf("Register() error = %v", err)
	}

	router := NewRouter(RouterConfig{
		Manager: manager,
	})

	req := httptest.NewRequest("GET", "/w/"+ws.ID+"/api/unknown", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusNotFound {
		t.Errorf("expected status 404, got %d", w.Code)
	}
}

func TestRouterAPIPingResponse(t *testing.T) {
	tmpDir := t.TempDir()
	t.Setenv("POCKODE_HOME", tmpDir)
	globalconfig.ResetDir()

	wsDir := filepath.Join(tmpDir, "my-workspace")
	if err := os.MkdirAll(wsDir, 0755); err != nil {
		t.Fatalf("failed to create workspace dir: %v", err)
	}

	manager, err := NewManager(ManagerConfig{
		Token:   "test-token",
		Version: "test",
	})
	if err != nil {
		t.Fatalf("NewManager() error = %v", err)
	}
	defer manager.Shutdown()

	ws, err := manager.WorkspaceStore().Register(wsDir, "My Workspace")
	if err != nil {
		t.Fatalf("Register() error = %v", err)
	}

	router := NewRouter(RouterConfig{
		Manager: manager,
	})

	req := httptest.NewRequest("GET", "/w/"+ws.ID+"/api/ping", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("expected Content-Type 'application/json', got %q", ct)
	}
	if body := w.Body.String(); body != `{"message":"pong"}` {
		t.Errorf("expected body '{\"message\":\"pong\"}', got %q", body)
	}
}

func TestRouterDefaultNotFoundHandler(t *testing.T) {
	tmpDir := t.TempDir()
	t.Setenv("POCKODE_HOME", tmpDir)
	globalconfig.ResetDir()

	manager, err := NewManager(ManagerConfig{})
	if err != nil {
		t.Fatalf("NewManager() error = %v", err)
	}

	router := NewRouter(RouterConfig{
		Manager: manager,
	})

	req := httptest.NewRequest("GET", "/not-workspace", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusNotFound {
		t.Errorf("expected status 404 from default handler, got %d", w.Code)
	}
}
