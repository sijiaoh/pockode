package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/pockode/server/agent/claude"
	"github.com/pockode/server/api"
	"github.com/pockode/server/git"
	"github.com/pockode/server/logger"
	"github.com/pockode/server/middleware"
	"github.com/pockode/server/process"
	"github.com/pockode/server/relay"
	"github.com/pockode/server/session"
	"github.com/pockode/server/ws"
)

func newHandler(token string, manager *process.Manager, devMode bool, sessionStore session.Store, workDir string) http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	})

	mux.HandleFunc("GET /api/ping", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"message":"pong"}`))
	})

	// Session REST API
	sessionHandler := api.NewSessionHandler(sessionStore)
	sessionHandler.Register(mux)

	// Git REST API
	gitHandler := api.NewGitHandler(workDir)
	gitHandler.Register(mux)

	// WebSocket endpoint (handles its own auth via query param)
	wsHandler := ws.NewHandler(token, manager, devMode, sessionStore)
	mux.Handle("GET /ws", wsHandler)

	return middleware.Auth(token)(mux)
}

func main() {
	logger.Init()

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	token := os.Getenv("AUTH_TOKEN")
	if token == "" {
		slog.Error("AUTH_TOKEN environment variable is required")
		os.Exit(1)
	}

	workDir := os.Getenv("WORK_DIR")
	if workDir == "" {
		workDir = "/workspace"
	}

	devMode := os.Getenv("DEV_MODE") == "true"

	dataDir := os.Getenv("DATA_DIR")
	if dataDir == "" {
		dataDir = ".pockode"
	}

	if os.Getenv("GIT_ENABLED") == "true" {
		gitCfg := git.Config{
			RepoURL:   os.Getenv("REPOSITORY_URL"),
			RepoToken: os.Getenv("REPOSITORY_TOKEN"),
			UserName:  os.Getenv("GIT_USER_NAME"),
			UserEmail: os.Getenv("GIT_USER_EMAIL"),
			WorkDir:   workDir,
		}
		if gitCfg.RepoURL == "" || gitCfg.RepoToken == "" || gitCfg.UserName == "" || gitCfg.UserEmail == "" {
			slog.Error("GIT_ENABLED=true requires REPOSITORY_URL, REPOSITORY_TOKEN, GIT_USER_NAME, GIT_USER_EMAIL")
			os.Exit(1)
		}
		if err := git.Init(gitCfg); err != nil {
			slog.Error("failed to initialize git", "error", err)
			os.Exit(1)
		}
	}

	// Initialize session store
	sessionStore, err := session.NewFileStore(dataDir)
	if err != nil {
		slog.Error("failed to initialize session store", "error", err)
		os.Exit(1)
	}

	// Initialize process manager with idle timeout
	idleTimeout := 10 * time.Minute
	if env := os.Getenv("IDLE_TIMEOUT"); env != "" {
		if d, err := time.ParseDuration(env); err == nil {
			idleTimeout = d
		} else {
			slog.Warn("invalid IDLE_TIMEOUT, using default", "value", env, "default", idleTimeout)
		}
	}

	claudeAgent := claude.New()
	manager := process.NewManager(claudeAgent, workDir, sessionStore, idleTimeout)

	handler := newHandler(token, manager, devMode, sessionStore, workDir)

	srv := &http.Server{
		Addr:    ":" + port,
		Handler: handler,
	}

	// Initialize relay if enabled
	var relayManager *relay.Manager
	if os.Getenv("RELAY_ENABLED") == "true" {
		portInt, err := strconv.Atoi(port)
		if err != nil {
			slog.Error("invalid PORT for relay", "port", port, "error", err)
			os.Exit(1)
		}
		cloudURL := os.Getenv("RELAY_CLOUD_URL")
		if cloudURL == "" {
			cloudURL = "https://cloud.pockode.com"
		}

		relayCfg := relay.Config{
			CloudURL:  cloudURL,
			DataDir:   dataDir,
			LocalPort: portInt,
		}

		relayManager = relay.NewManager(relayCfg, slog.Default())

		remoteURL, err := relayManager.Start(context.Background())
		if err != nil {
			slog.Error("failed to start relay", "error", err)
			os.Exit(1)
		}

		slog.Info("remote access enabled", "url", remoteURL)
	}

	// Graceful shutdown
	shutdownDone := make(chan struct{})
	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh

		slog.Info("shutting down server")
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := srv.Shutdown(ctx); err != nil {
			slog.Error("server shutdown error", "error", err)
		}
		if relayManager != nil {
			relayManager.Stop()
		}
		manager.Shutdown()
		close(shutdownDone)
	}()

	slog.Info("server starting", "port", port, "workDir", workDir, "dataDir", dataDir, "devMode", devMode, "idleTimeout", idleTimeout)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		slog.Error("server error", "error", err)
		os.Exit(1)
	}
	<-shutdownDone
	slog.Info("server stopped")
}
