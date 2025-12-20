package main

import (
	"log"
	"net/http"
	"os"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/middleware"
	"github.com/pockode/server/ws"
)

func newHandler(token, workDir string) http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	})

	mux.HandleFunc("GET /api/ping", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"message":"pong"}`))
	})

	// WebSocket endpoint (handles its own auth via query param)
	wsHandler := ws.NewHandler(token, agent.NewClaudeAgent(), workDir)
	mux.Handle("GET /ws", wsHandler)

	return middleware.Auth(token)(mux)
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	token := os.Getenv("AUTH_TOKEN")
	if token == "" {
		log.Fatal("AUTH_TOKEN environment variable is required")
	}

	workDir := os.Getenv("WORK_DIR")
	if workDir == "" {
		workDir = "/workspace"
	}

	handler := newHandler(token, workDir)

	log.Printf("Server starting on :%s (workDir: %s)", port, workDir)
	if err := http.ListenAndServe(":"+port, handler); err != nil {
		log.Fatal(err)
	}
}
