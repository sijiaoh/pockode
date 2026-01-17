package main

import (
	"context"
	"embed"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/pockode/server/agent/claude"
	"github.com/pockode/server/command"
	"github.com/pockode/server/git"
	"github.com/pockode/server/logger"
	"github.com/pockode/server/middleware"
	"github.com/pockode/server/relay"
	"github.com/pockode/server/startup"
	"github.com/pockode/server/worktree"
	"github.com/pockode/server/ws"
)

var version = "dev"

//go:embed static/*
var staticFS embed.FS

func newHandler(token string, devMode bool, wsHandler *ws.RPCHandler) http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	})

	mux.HandleFunc("GET /api/ping", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"message":"pong"}`))
	})

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

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path

		if strings.HasPrefix(path, "/api") || path == "/ws" || path == "/health" {
			apiHandler.ServeHTTP(w, r)
			return
		}

		cleanPath := strings.TrimPrefix(path, "/")
		if cleanPath == "" {
			cleanPath = "index.html"
		}

		// Check if file exists (including .br version), otherwise fall back to index.html for SPA routing
		if !fileExists(subFS, cleanPath) && !fileExists(subFS, cleanPath+".br") {
			cleanPath = "index.html"
		}

		serveFileWithBrotli(w, r, subFS, cleanPath)
	})
}

func fileExists(fsys fs.FS, path string) bool {
	f, err := fsys.Open(path)
	if err != nil {
		return false
	}
	f.Close()
	return true
}

// serveFileWithBrotli serves a file, using pre-compressed .br version if available and client accepts brotli.
func serveFileWithBrotli(w http.ResponseWriter, r *http.Request, fsys fs.FS, filePath string) {
	// Hashed assets (in /assets/) can be cached indefinitely
	if strings.HasPrefix(filePath, "assets/") {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	}

	w.Header().Set("Vary", "Accept-Encoding")

	acceptsBr := strings.Contains(r.Header.Get("Accept-Encoding"), "br")
	if acceptsBr {
		brPath := filePath + ".br"
		if brFile, err := fsys.Open(brPath); err == nil {
			defer brFile.Close()

			w.Header().Set("Content-Encoding", "br")
			w.Header().Set("Content-Type", getContentType(filePath))
			http.ServeContent(w, r, filePath, time.Time{}, brFile.(io.ReadSeeker))
			return
		}
	}

	// Serve uncompressed file
	file, err := fsys.Open(filePath)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer file.Close()

	w.Header().Set("Content-Type", getContentType(filePath))
	http.ServeContent(w, r, filePath, time.Time{}, file.(io.ReadSeeker))
}

func getContentType(filePath string) string {
	ext := filepath.Ext(filePath)
	if mimeType := mime.TypeByExtension(ext); mimeType != "" {
		return mimeType
	}
	return "application/octet-stream"
}

const defaultPort = 9870

func findAvailablePort(startPort int) int {
	const maxAttempts = 100
	for port := startPort; port < startPort+maxAttempts; port++ {
		ln, err := net.Listen("tcp", fmt.Sprintf(":%d", port))
		if err == nil {
			ln.Close()
			return port
		}
	}
	return startPort
}

func main() {
	portFlag := flag.Int("port", 0, fmt.Sprintf("server port (default %d)", defaultPort))
	tokenFlag := flag.String("auth-token", "", "authentication token (required)")
	devModeFlag := flag.Bool("dev", false, "enable development mode")
	relayFlag := flag.Bool("relay", true, "relay for remote access (use -relay=false to disable)")
	versionFlag := flag.Bool("version", false, "print version and exit")
	flag.Parse()

	if *versionFlag {
		fmt.Printf("pockode %s\n", version)
		os.Exit(0)
	}

	port := defaultPort
	if *portFlag != 0 {
		port = *portFlag
	} else if envPort := os.Getenv("SERVER_PORT"); envPort != "" {
		if p, err := strconv.Atoi(envPort); err == nil {
			port = p
		}
	}
	port = findAvailablePort(port)

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

	// Initialize command store
	commandStore, err := command.NewStore(dataDir)
	if err != nil {
		slog.Error("failed to initialize command store", "error", err)
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

	// Initialize worktree registry and manager
	claudeAgent := claude.New()
	registry := worktree.NewRegistry(workDir)
	worktreeManager := worktree.NewManager(registry, claudeAgent, dataDir, idleTimeout)
	if err := worktreeManager.Start(); err != nil {
		slog.Warn("failed to start worktree manager", "error", err)
	}

	wsHandler := ws.NewRPCHandler(token, version, devMode, commandStore, worktreeManager)
	handler := newHandler(token, devMode, wsHandler)

	portStr := strconv.Itoa(port)
	srv := &http.Server{
		Addr:    ":" + portStr,
		Handler: handler,
	}

	cloudURL := os.Getenv("CLOUD_URL")
	if cloudURL == "" {
		cloudURL = "https://cloud.pockode.com"
	}

	// Initialize relay if enabled
	var relayManager *relay.Manager
	var cancelRelayStreams context.CancelFunc
	var remoteURL string
	relayEnabled := *relayFlag && os.Getenv("RELAY_ENABLED") != "false"
	if relayEnabled {
		relayCfg := relay.Config{
			CloudURL:      cloudURL,
			DataDir:       dataDir,
			ClientVersion: version,
		}

		frontendPort := port
		if envFrontendPort := os.Getenv("RELAY_FRONTEND_PORT"); envFrontendPort != "" {
			frontendPort, _ = strconv.Atoi(envFrontendPort)
		}
		relayManager = relay.NewManager(relayCfg, port, frontendPort, slog.Default())

		var err error
		remoteURL, err = relayManager.Start(context.Background())
		if err != nil {
			slog.Error("failed to start relay", "error", err)
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}

		slog.Info("remote access enabled", "url", remoteURL)

		var relayStreamCtx context.Context
		relayStreamCtx, cancelRelayStreams = context.WithCancel(context.Background())
		go func() {
			for stream := range relayManager.NewStreams() {
				go wsHandler.HandleStream(relayStreamCtx, stream, stream.ConnectionID())
			}
		}()
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
			cancelRelayStreams()
			relayManager.Stop()
		}
		worktreeManager.Shutdown()
		close(shutdownDone)
	}()

	// Fetch announcement from cloud
	announcement := relay.NewClient(cloudURL).GetAnnouncement(context.Background())

	// Display startup banner
	startup.PrintBanner(startup.BannerOptions{
		Version:      version,
		LocalURL:     "http://localhost:" + portStr,
		RemoteURL:    remoteURL,
		Announcement: announcement,
	})

	// Print QR code if relay is enabled
	if remoteURL != "" {
		startup.PrintQRCode(remoteURL)
		fmt.Println()
	}

	startup.PrintFooter()

	slog.Info("server starting", "port", port, "workDir", workDir, "dataDir", dataDir, "devMode", devMode, "idleTimeout", idleTimeout)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		slog.Error("server error", "error", err)
		os.Exit(1)
	}
	<-shutdownDone
	slog.Info("server stopped")
}
