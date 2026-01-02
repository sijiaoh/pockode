package main

import (
	"context"
	"embed"
	"flag"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
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

var version = "dev"

//go:embed static/*
var staticFS embed.FS

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

	authedMux := middleware.Auth(token)(mux)

	if !devMode {
		return newSPAHandler(authedMux)
	}

	return authedMux
}

// newSPAHandler wraps an API handler with embedded SPA static file serving.
func newSPAHandler(apiHandler http.Handler) http.Handler {
	subFS, err := fs.Sub(staticFS, "static")
	if err != nil {
		slog.Error("failed to create sub filesystem", "error", err)
		return apiHandler
	}
	fileServer := http.FileServer(http.FS(subFS))

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path

		if strings.HasPrefix(path, "/api") || path == "/ws" || path == "/health" {
			apiHandler.ServeHTTP(w, r)
			return
		}

		cleanPath := strings.TrimPrefix(path, "/")
		if f, err := subFS.Open(cleanPath); err == nil {
			f.Close()
			fileServer.ServeHTTP(w, r)
			return
		}

		// SPA fallback: serve index.html for client-side routing
		r.URL.Path = "/"
		fileServer.ServeHTTP(w, r)
	})
}

func main() {
	portFlag := flag.Int("port", 0, "server port (default 8080)")
	tokenFlag := flag.String("auth-token", "", "authentication token (required)")
	devModeFlag := flag.Bool("dev", false, "enable development mode")
	relayFlag := flag.Bool("relay", false, "enable relay for remote access")
	versionFlag := flag.Bool("version", false, "print version and exit")
	flag.Parse()

	if *versionFlag {
		fmt.Printf("pockode %s\n", version)
		os.Exit(0)
	}

	port := "8080"
	if *portFlag != 0 {
		port = strconv.Itoa(*portFlag)
	} else if envPort := os.Getenv("SERVER_PORT"); envPort != "" {
		port = envPort
	}

	token := *tokenFlag
	if token == "" {
		token = os.Getenv("AUTH_TOKEN")
	}
	if token == "" {
		slog.Error("AUTH_TOKEN is required (use --auth-token flag or AUTH_TOKEN env)")
		os.Exit(1)
	}

	workDir := "."
	if envWorkDir := os.Getenv("WORK_DIR"); envWorkDir != "" {
		workDir = envWorkDir
	}
	absWorkDir, err := filepath.Abs(workDir)
	if err != nil {
		slog.Error("failed to resolve work directory", "error", err)
		os.Exit(1)
	}
	workDir = absWorkDir

	devMode := *devModeFlag || os.Getenv("DEV_MODE") == "true"

	dataDir := filepath.Join(workDir, ".pockode")
	if envDataDir := os.Getenv("DATA_DIR"); envDataDir != "" {
		dataDir = envDataDir
	}
	absDataDir, err := filepath.Abs(dataDir)
	if err != nil {
		slog.Error("failed to resolve data directory", "error", err)
		os.Exit(1)
	}
	dataDir = absDataDir

	logger.Init(logger.Config{
		DataDir: dataDir,
		DevMode: devMode,
	})

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
	relayEnabled := *relayFlag || os.Getenv("RELAY_ENABLED") == "true"
	if relayEnabled {
		relayPort := os.Getenv("RELAY_PORT")
		if relayPort == "" {
			relayPort = port
		}
		portInt, err := strconv.Atoi(relayPort)
		if err != nil {
			slog.Error("invalid RELAY_PORT", "port", relayPort, "error", err)
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

		fmt.Println()
		fmt.Println("Remote Access URL:")
		fmt.Printf("  %s\n", remoteURL)
		fmt.Println()
		relay.PrintQRCode(remoteURL)
		fmt.Println()
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

	fmt.Printf("Pockode %s\n", version)
	fmt.Printf("Server running at http://localhost:%s\n", port)
	fmt.Println("Press Ctrl+C to stop")
	fmt.Println()
	slog.Info("server starting", "port", port, "workDir", workDir, "dataDir", dataDir, "devMode", devMode, "idleTimeout", idleTimeout)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		slog.Error("server error", "error", err)
		os.Exit(1)
	}
	<-shutdownDone
	slog.Info("server stopped")
}
