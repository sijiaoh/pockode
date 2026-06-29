package main

import (
	"context"
	"crypto/rand"
	"embed"
	"encoding/hex"
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

	"github.com/pockode/server/agent"
	"github.com/pockode/server/agent/claude"
	"github.com/pockode/server/agent/codex"
	"github.com/pockode/server/agentrole"
	"github.com/pockode/server/cluster"
	"github.com/pockode/server/command"
	"github.com/pockode/server/git"
	"github.com/pockode/server/internal/netutil"
	"github.com/pockode/server/logger"
	"github.com/pockode/server/mcp"
	"github.com/pockode/server/middleware"
	"github.com/pockode/server/relay"
	"github.com/pockode/server/serverinfo"
	"github.com/pockode/server/session"
	"github.com/pockode/server/settings"
	"github.com/pockode/server/spa"
	"github.com/pockode/server/startup"
	"github.com/pockode/server/work"
	"github.com/pockode/server/worktree"
	"github.com/pockode/server/ws"
)

var version = "dev"

//go:embed static/*
var staticFS embed.FS

func newHandler(token string, devMode bool, wsHandler *ws.RPCHandler, mcpHandler http.Handler) http.Handler {
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

	// Local MCP API. middleware.Auth bypasses this exact route; mcpHandler
	// self-auths with the locally-generated MCP token instead of the user
	// --auth-token. The relay also refuses to forward it (loopback-only).
	mux.Handle("POST "+mcp.APIPath, mcpHandler)

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
		if !spa.FileExists(subFS, cleanPath) && !spa.FileExists(subFS, cleanPath+".br") {
			cleanPath = "index.html"
		}

		spa.ServeFileWithBrotli(w, r, subFS, cleanPath)
	})
}

const defaultPort = 9870

// generateToken returns a random 256-bit token as a hex string.
func generateToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func main() {
	// Handle subcommands before flag.Parse()
	if len(os.Args) > 1 && os.Args[0] != "-" {
		switch os.Args[1] {
		case "mcp":
			runMCP()
			return
		case "cluster":
			runCluster()
			return
		}
	}

	portFlag := flag.Int("port", defaultPort, "server port")
	tokenFlag := flag.String("auth-token", "", "authentication token (required)")
	workDirFlag := flag.String("work", ".", "working directory")
	dataDirFlag := flag.String("data", "", "data directory (default: <work>/.pockode)")
	devModeFlag := flag.Bool("dev", false, "enable development mode")
	idleTimeoutFlag := flag.Duration("idle-timeout", 8*time.Hour, "idle timeout before stopping")
	relayFlag := flag.Bool("relay", true, "relay for remote access (use -relay=false to disable)")
	relayFrontendPortFlag := flag.Int("relay-frontend-port", 0, "relay frontend port (default: same as server port)")
	cloudURLFlag := flag.String("cloud-url", "https://cloud.pockode.com", "cloud server URL")
	gitEnabledFlag := flag.Bool("git", false, "enable git integration")
	gitRepoURLFlag := flag.String("git-repo-url", "", "git repository URL")
	gitRepoTokenFlag := flag.String("git-repo-token", "", "git repository token")
	gitUserNameFlag := flag.String("git-user-name", "", "git user name")
	gitUserEmailFlag := flag.String("git-user-email", "", "git user email")
	logLevelFlag := flag.String("log-level", "", "log level: debug, info, warn, error (default info)")
	logFormatFlag := flag.String("log-format", "", "log format: text, json (default text)")
	logFileFlag := flag.String("log-file", "", "log file path (default: dataDir/server.log in production)")
	versionFlag := flag.Bool("version", false, "print version and exit")
	flag.Parse()

	if *versionFlag {
		fmt.Printf("pockode %s\n", version)
		os.Exit(0)
	}

	port := netutil.FindAvailablePort(*portFlag)

	token := *tokenFlag
	if token == "" {
		slog.Error("--auth-token flag is required")
		os.Exit(1)
	}

	absWorkDir, err := filepath.Abs(*workDirFlag)
	if err != nil {
		slog.Error("failed to resolve work directory", "error", err)
		os.Exit(1)
	}
	workDir := absWorkDir

	devMode := *devModeFlag

	dataDirStr := *dataDirFlag
	if dataDirStr == "" {
		dataDirStr = filepath.Join(workDir, ".pockode")
	}
	absDataDir, err := filepath.Abs(dataDirStr)
	if err != nil {
		slog.Error("failed to resolve data directory", "error", err)
		os.Exit(1)
	}
	dataDir := absDataDir

	logger.Init(logger.Config{
		DataDir:   dataDir,
		DevMode:   devMode,
		LogLevel:  *logLevelFlag,
		LogFormat: *logFormatFlag,
		LogFile:   *logFileFlag,
	})

	if *gitEnabledFlag {
		gitCfg := git.Config{
			RepoURL:   *gitRepoURLFlag,
			RepoToken: *gitRepoTokenFlag,
			UserName:  *gitUserNameFlag,
			UserEmail: *gitUserEmailFlag,
			WorkDir:   workDir,
		}
		if gitCfg.RepoURL == "" || gitCfg.RepoToken == "" || gitCfg.UserName == "" || gitCfg.UserEmail == "" {
			slog.Error("-git flag requires -git-repo-url, -git-repo-token, -git-user-name, -git-user-email")
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

	idleTimeout := *idleTimeoutFlag

	// Initialize settings store
	settingsStore, err := settings.NewStore(dataDir)
	if err != nil {
		slog.Error("failed to initialize settings store", "error", err)
		os.Exit(1)
	}
	if err := settingsStore.StartWatching(); err != nil {
		slog.Warn("failed to start settings store file watcher", "error", err)
	}

	// Initialize worktree setup hook
	if err := worktree.InitSetupHook(dataDir); err != nil {
		slog.Error("failed to initialize worktree setup hook", "error", err)
		os.Exit(1)
	}

	// Initialize work and agent role stores
	s, err := initStores(dataDir)
	if err != nil {
		slog.Error("failed to initialize stores", "error", err)
		os.Exit(1)
	}
	workStore := s.work
	agentRoleStore := s.agentRole

	workAutoResumer := work.NewAutoResumer(workStore, 3)
	workAutoResumer.StopOrphanedWork()
	workAutoResumer.SetStepProvider(&agentRoleStepAdapter{store: agentRoleStore})
	session.ClearOrphanedNeedsInput(dataDir)
	workStore.AddOnChangeListener(workAutoResumer)

	// Set PM as default agent role on first launch
	if pmID := agentRoleStore.SeededPMRoleID(); pmID != "" {
		cfg := settingsStore.Get()
		cfg.DefaultAgentRoleID = pmID
		if err := settingsStore.Update(cfg); err != nil {
			slog.Error("failed to set default agent role", "error", err)
		}
	}

	// Initialize agent registry
	agents := agent.NewRegistry()
	agents.Register(session.AgentTypeClaude, claude.New())
	agents.Register(session.AgentTypeCodex, codex.New())

	// Initialize worktree registry and manager
	registry := worktree.NewRegistry(workDir, dataDir)
	worktreeManager := worktree.NewManager(registry, agents, dataDir, idleTimeout)
	worktreeManager.SetWorkAutoResumer(workAutoResumer)
	worktreeManager.SetWorkNeedsInputSyncer(work.NewNeedsInputSyncer(workStore))
	workStarter := worktree.NewWorkStarter(worktreeManager, agentRoleStore, settingsStore)
	workStopper := worktree.NewWorkStopper(worktreeManager, workStore)
	// Single implementation of the start/reopen transitions, shared by both the
	// WebSocket handler (user actions) and the MCP Executor (AI actions).
	workOps := work.NewOperations(workStore, workStarter, workAutoResumer)
	if err := worktreeManager.Start(); err != nil {
		slog.Warn("failed to start worktree manager", "error", err)
	}

	// Local API token for the MCP subprocess. Randomly generated per startup and
	// published to server.json, so it never outlives the process and is distinct
	// from the user-facing --auth-token.
	mcpToken, err := generateToken()
	if err != nil {
		slog.Error("failed to generate MCP token", "error", err)
		os.Exit(1)
	}
	mcpHandler := mcp.NewAPIHandler(mcp.NewExecutor(workStore, agentRoleStore, workOps, workAutoResumer, settingsStore), mcpToken)

	wsHandler := ws.NewRPCHandler(token, version, devMode, commandStore, worktreeManager, settingsStore, workStore, workOps, workStopper, agentRoleStore)
	handler := newHandler(token, devMode, wsHandler, mcpHandler)

	portStr := strconv.Itoa(port)
	srv := &http.Server{
		Addr:    ":" + portStr,
		Handler: handler,
	}

	cloudURL := *cloudURLFlag

	// Initialize relay if enabled
	var relayManager *relay.Manager
	var cancelRelayStreams context.CancelFunc
	var remoteURL string
	relayEnabled := *relayFlag
	if relayEnabled {
		relayCfg := relay.Config{
			CloudURL:      cloudURL,
			DataDir:       dataDir,
			ClientVersion: version,
		}

		frontendPort := *relayFrontendPortFlag
		if frontendPort == 0 {
			frontendPort = port
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

	// Write server.json for orchestration programs to discover the running server
	localURL := "http://localhost:" + portStr
	if err := serverinfo.Write(dataDir, port, localURL, remoteURL, mcpToken); err != nil {
		slog.Error("failed to write server.json", "error", err)
		os.Exit(1)
	}

	// Graceful shutdown
	shutdownDone := make(chan struct{})
	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh
		signal.Stop(sigCh)

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
		wsHandler.Stop()
		workAutoResumer.Stop()
		worktreeManager.Shutdown()
		settingsStore.StopWatching()
		if err := serverinfo.Delete(dataDir); err != nil {
			slog.Error("failed to delete server.json", "error", err)
		}
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

// stores holds the shared data stores used by both the main server and MCP subcommand.
type stores struct {
	work      *work.FileStore
	agentRole *agentrole.FileStore
}

// initStores creates work and agent-role stores from the given data directory.
func initStores(dataDir string) (*stores, error) {
	workStore, err := work.NewFileStore(dataDir)
	if err != nil {
		return nil, fmt.Errorf("failed to initialize work store: %w", err)
	}

	agentRoleStore, err := agentrole.NewFileStore(dataDir)
	if err != nil {
		return nil, fmt.Errorf("failed to initialize agent role store: %w", err)
	}

	return &stores{work: workStore, agentRole: agentRoleStore}, nil
}

// agentRoleStepAdapter adapts agentrole.Store to work.StepProvider.
type agentRoleStepAdapter struct {
	store agentrole.Store
}

func (a *agentRoleStepAdapter) GetSteps(agentRoleID string) ([]string, error) {
	role, found, err := a.store.Get(agentRoleID)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, nil
	}
	return role.Steps, nil
}

func runMCP() {
	mcpFlags := flag.NewFlagSet("mcp", flag.ExitOnError)
	dataDirFlag := mcpFlags.String("data-dir", "", "data directory (required)")
	mcpFlags.Parse(os.Args[2:])

	dataDir := *dataDirFlag
	if dataDir == "" {
		fmt.Fprintln(os.Stderr, "Error: --data-dir is required")
		os.Exit(1)
	}

	// Client mode: discover the running server from server.json and forward tool
	// calls over its local API. The MCP process owns no stores and no watcher.
	client, err := mcp.NewClientFromServerInfo(dataDir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	server := mcp.NewServer(client, version)
	if err := server.Run(context.Background()); err != nil {
		fmt.Fprintf(os.Stderr, "Error: MCP server failed: %v\n", err)
		os.Exit(1)
	}
}

func runCluster() {
	clusterFlags := flag.NewFlagSet("cluster", flag.ExitOnError)
	portFlag := clusterFlags.Int("port", cluster.DefaultPort, "server port")
	tokenFlag := clusterFlags.String("auth-token", "", "authentication token (required)")
	dataDirFlag := clusterFlags.String("data", "", "data directory (default: ~/.pockode-cluster)")
	relayFlag := clusterFlags.Bool("relay", true, "relay for remote access (use -relay=false to disable)")
	relayFrontendPortFlag := clusterFlags.Int("relay-frontend-port", 0, "relay frontend port (default: same as server port)")
	cloudURLFlag := clusterFlags.String("cloud-url", "https://cloud.pockode.com", "cloud server URL")
	devModeFlag := clusterFlags.Bool("dev", false, "enable development mode")
	clusterFlags.Parse(os.Args[2:])

	token := *tokenFlag
	if token == "" {
		fmt.Fprintln(os.Stderr, "Error: --auth-token flag is required")
		os.Exit(1)
	}

	dataDir := *dataDirFlag
	if dataDir == "" {
		homeDir, err := os.UserHomeDir()
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: failed to get home directory: %v\n", err)
			os.Exit(1)
		}
		dataDir = filepath.Join(homeDir, ".pockode-cluster")
	}
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		fmt.Fprintf(os.Stderr, "Error: failed to create data directory: %v\n", err)
		os.Exit(1)
	}

	cfg := cluster.Config{
		Port:              *portFlag,
		AuthToken:         token,
		DataDir:           dataDir,
		RelayEnabled:      *relayFlag,
		RelayFrontendPort: *relayFrontendPortFlag,
		CloudURL:          *cloudURLFlag,
		Version:           version,
		DevMode:           *devModeFlag,
	}

	if err := cluster.Run(cfg); err != nil {
		fmt.Fprintf(os.Stderr, "Error: cluster mode failed: %v\n", err)
		os.Exit(1)
	}
}
