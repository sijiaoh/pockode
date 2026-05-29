package manager

import (
	"net/http"
	"strings"
)

// Router routes requests to the appropriate workspace worker.
// URL structure: /w/:id/...
type Router struct {
	manager  *Manager
	notFound http.Handler
}

// RouterConfig holds configuration for creating a Router.
type RouterConfig struct {
	Manager  *Manager
	NotFound http.Handler
}

// NewRouter creates a new workspace router.
func NewRouter(cfg RouterConfig) *Router {
	notFound := cfg.NotFound
	if notFound == nil {
		notFound = http.NotFoundHandler()
	}
	return &Router{
		manager:  cfg.Manager,
		notFound: notFound,
	}
}

// parseWorkspacePath extracts workspace ID and remaining path from URL.
// Returns (workspaceID, remainingPath, ok).
// Example: "/w/abc123/ws" -> ("abc123", "/ws", true)
func parseWorkspacePath(path string) (string, string, bool) {
	if !strings.HasPrefix(path, "/w/") {
		return "", "", false
	}

	rest := path[3:]
	if rest == "" {
		return "", "", false
	}

	slashIdx := strings.Index(rest, "/")
	if slashIdx == -1 {
		return rest, "/", true
	}

	workspaceID := rest[:slashIdx]
	remainingPath := rest[slashIdx:]
	if workspaceID == "" {
		return "", "", false
	}

	return workspaceID, remainingPath, true
}

// ServeHTTP implements http.Handler.
func (r *Router) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	workspaceID, remainingPath, ok := parseWorkspacePath(req.URL.Path)
	if !ok {
		r.notFound.ServeHTTP(w, req)
		return
	}

	// Start worker if not running (lazy start)
	if err := r.manager.StartWorker(workspaceID); err != nil {
		http.Error(w, "workspace not found", http.StatusNotFound)
		return
	}

	worker := r.manager.GetWorker(workspaceID)
	if worker == nil || worker.State() != WorkerStateRunning {
		http.Error(w, "workspace not ready", http.StatusServiceUnavailable)
		return
	}

	switch {
	case remainingPath == "/ws":
		r.handleWebSocket(w, req, worker)
	case strings.HasPrefix(remainingPath, "/api/"):
		r.handleAPI(w, req, worker, remainingPath)
	case remainingPath == "/health":
		r.handleHealth(w, req, worker)
	default:
		r.handleStatic(w, req, worker, remainingPath)
	}
}

func (r *Router) handleWebSocket(w http.ResponseWriter, req *http.Request, worker *Worker) {
	handler := worker.RPCHandler()
	if handler == nil {
		http.Error(w, "worker not initialized", http.StatusServiceUnavailable)
		return
	}
	handler.ServeHTTP(w, req)
}

func (r *Router) handleAPI(w http.ResponseWriter, req *http.Request, worker *Worker, path string) {
	apiPath := strings.TrimPrefix(path, "/api")

	switch {
	case apiPath == "/ping":
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"message":"pong"}`))
	default:
		http.NotFound(w, req)
	}
}

func (r *Router) handleHealth(w http.ResponseWriter, req *http.Request, worker *Worker) {
	w.WriteHeader(http.StatusOK)
	w.Write([]byte("ok"))
}

func (r *Router) handleStatic(w http.ResponseWriter, req *http.Request, worker *Worker, path string) {
	http.Redirect(w, req, "/?workspace="+worker.ID(), http.StatusTemporaryRedirect)
}
