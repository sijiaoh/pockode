package main

import (
	"context"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/pockode/server/agent/claude"
	"github.com/pockode/server/git"
	"github.com/pockode/server/logger"
	"github.com/pockode/server/middleware"
	"github.com/pockode/server/ws"
)

func newHandler(token, workDir string, devMode bool) http.Handler {
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
	wsHandler := ws.NewHandler(token, claude.New(), workDir, devMode)
	mux.Handle("GET /ws", wsHandler)

	return middleware.Auth(token)(mux)
}

// requireEnv returns the value of an environment variable or exits if not set.
func requireEnv(key string) string {
	value := os.Getenv(key)
	if value == "" {
		logger.Error("%s environment variable is required when GIT_ENABLED=true", key)
		os.Exit(1)
	}
	return value
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	token := os.Getenv("AUTH_TOKEN")
	if token == "" {
		logger.Error("AUTH_TOKEN environment variable is required")
		os.Exit(1)
	}

	workDir := os.Getenv("WORK_DIR")
	if workDir == "" {
		workDir = "/workspace"
	}

	devMode := os.Getenv("DEV_MODE") == "true"

	// Git initialization (optional, controlled by GIT_ENABLED)
	if os.Getenv("GIT_ENABLED") == "true" {
		cfg := git.Config{
			RepoURL:   requireEnv("REPOSITORY_URL"),
			RepoToken: requireEnv("REPOSITORY_TOKEN"),
			UserName:  requireEnv("GIT_USER_NAME"),
			UserEmail: requireEnv("GIT_USER_EMAIL"),
			WorkDir:   workDir,
		}
		if err := git.Init(cfg); err != nil {
			logger.Error("Failed to initialize git: %v", err)
			os.Exit(1)
		}
	}

	handler := newHandler(token, workDir, devMode)

	srv := &http.Server{
		Addr:    ":" + port,
		Handler: handler,
	}

	// Graceful shutdown
	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh

		logger.Info("Shutting down server...")
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := srv.Shutdown(ctx); err != nil {
			logger.Error("Server shutdown error: %v", err)
		}
	}()

	logger.Info("Server starting on :%s (workDir: %s, devMode: %v)", port, workDir, devMode)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		logger.Error("Server error: %v", err)
		os.Exit(1)
	}
	logger.Info("Server stopped")
}
