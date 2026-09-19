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
	"path/filepath"
	"strconv"
	"time"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/agent/claude"
	"github.com/pockode/server/agent/codex"
	"github.com/pockode/server/agentrole"
	"github.com/pockode/server/apiroute"
	"github.com/pockode/server/authsession"
	"github.com/pockode/server/cluster"
	"github.com/pockode/server/command"
	"github.com/pockode/server/filetransfer"
	"github.com/pockode/server/git"
	"github.com/pockode/server/internal/fsperm"
	"github.com/pockode/server/internal/netutil"
	"github.com/pockode/server/internal/pathutil"
	"github.com/pockode/server/internal/shutdown"
	"github.com/pockode/server/logger"
	"github.com/pockode/server/mcp"
	"github.com/pockode/server/middleware"
	"github.com/pockode/server/password"
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

func newHandler(serverPassword string, sessions middleware.SessionValidator, devMode bool, wsHandler *ws.RPCHandler, mcpHandler http.Handler, transferHandler *filetransfer.Handler) http.Handler {
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

	// Whole-file transfer stays off the WebSocket connection; see the
	// filetransfer package for why.
	mux.HandleFunc("GET /api/files/download", transferHandler.Download)
	mux.HandleFunc("POST /api/files/upload", transferHandler.Upload)

	// Local MCP API. middleware.Auth bypasses this exact route; mcpHandler
	// self-auths with the locally-generated MCP token instead of the user
	// password. The relay also refuses to forward it (loopback-only).
	mux.Handle("POST "+mcp.APIPath, mcpHandler)

	authedMux := middleware.Auth(serverPassword, sessions)(mux)

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

		if apiroute.IsAPI(path) {
			apiHandler.ServeHTTP(w, r)
			return
		}

		cleanPath, ok := spa.ResolvePath(subFS, path)
		if !ok {
			http.NotFound(w, r)
			return
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
	passwordFlag := flag.String("password", "", "password for the web UI (required; or set "+password.EnvVar+")")
	legacyPasswordFlag := flag.String("auth-token", "", "deprecated alias for --password (removed in "+password.RemovalVersion+")")
	workDirFlag := flag.String("work", ".", "working directory")
	dataDirFlag := flag.String("data", "", "data directory (default: <work>/.pockode)")
	devModeFlag := flag.Bool("dev", false, "enable development mode")
	// The four process lease budgets. Every value defaults to the one place they
	// are written down (session.DefaultLeaseBudgets), and 0 means "no budget" for
	// each of them — see session.Lease for what each wait costs while it is held.
	leaseDefaults := session.DefaultLeaseBudgets()
	idleTimeoutFlag := flag.Duration("idle-timeout", leaseDefaults.Idle,
		"how long an idle session's process is kept alive for the next message (0 disables collecting it)")
	turnTimeoutFlag := flag.Duration("turn-timeout", leaseDefaults.Turn,
		"how long a turn may run before it is interrupted (0 for no limit)")
	answerTimeoutFlag := flag.Duration("answer-timeout", leaseDefaults.Answer,
		"how long a question or permission request waits for an answer before it is withdrawn (0 for no limit)")
	backgroundTimeoutFlag := flag.Duration("background-timeout", leaseDefaults.Background,
		"how long a turn parked on background work waits for the CLI to resume before it is ended (0 for no limit)")
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
	flag.Usage = func() {
		out := flag.CommandLine.Output()
		fmt.Fprint(out, `Pockode — your dev machine in your pocket.

Usage:
  pockode [flags]           Start the server (default)
  pockode cluster [flags]   Orchestrator for multiple project nodes (see docs/cluster.md)
  pockode mcp [flags]       MCP stdio proxy (spawned internally by AI CLIs)

Run "pockode cluster -help" for cluster-mode flags.

Flags:
`)
		flag.PrintDefaults()
	}
	flag.Parse()

	if *versionFlag {
		fmt.Printf("pockode %s\n", version)
		os.Exit(0)
	}

	port := netutil.FindAvailablePort(*portFlag)

	cred, err := password.Load(*passwordFlag, *legacyPasswordFlag)
	if err != nil {
		slog.Error(err.Error())
		os.Exit(1)
	}
	if cred.Password == "" {
		slog.Error("a password is required: pass --password <password>, or set the " + password.EnvVar + " environment variable (which keeps it out of the process argv)")
		os.Exit(1)
	}

	// Path flags are expanded here because no shell does it for us on Windows:
	// `--work ~\projects` arrives verbatim there and would otherwise create a
	// directory literally named `~` next to the current one.
	absWorkDir, err := filepath.Abs(pathutil.ExpandTilde(*workDirFlag))
	if err != nil {
		slog.Error("failed to resolve work directory", "error", err)
		os.Exit(1)
	}
	workDir := absWorkDir

	devMode := *devModeFlag

	dataDirStr := pathutil.ExpandTilde(*dataDirFlag)
	if dataDirStr == "" {
		dataDirStr = filepath.Join(workDir, ".pockode")
	}
	absDataDir, err := filepath.Abs(dataDirStr)
	if err != nil {
		slog.Error("failed to resolve data directory", "error", err)
		os.Exit(1)
	}
	dataDir := absDataDir

	// Restrict the data directory before anything writes into it, so every file
	// it ends up holding — the MCP local token, the relay token, session
	// transcripts, the log — inherits the restriction instead of being fixed up
	// afterwards. See internal/fsperm for why this is a property of the
	// directory rather than of each file.
	if err := fsperm.RestrictDir(dataDir); err != nil {
		slog.Error("failed to secure data directory", "path", dataDir, "error", err)
		os.Exit(1)
	}

	logger.Init(logger.Config{
		DataDir:   dataDir,
		DevMode:   devMode,
		LogLevel:  *logLevelFlag,
		LogFormat: *logFormatFlag,
		LogFile:   pathutil.ExpandTilde(*logFileFlag),
	})

	if cred.DeprecationWarning != "" {
		slog.Warn(cred.DeprecationWarning)
	}

	// Sessions are loaded before anything can authenticate. This is also where a
	// changed password takes effect: every session issued under the old one is
	// dropped here.
	sessions, err := authsession.NewStore(dataDir, cred.Password)
	if err != nil {
		slog.Error("failed to initialize session store", "error", err)
		os.Exit(1)
	}

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

	leaseBudgets := session.LeaseBudgets{
		Turn:       *turnTimeoutFlag,
		Answer:     *answerTimeoutFlag,
		Background: *backgroundTimeoutFlag,
		Idle:       *idleTimeoutFlag,
	}

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
	if err := agentRoleStore.StartWatching(); err != nil {
		slog.Warn("failed to start agent role store file watcher", "error", err)
	}

	steps := agentrole.Steps{Store: agentRoleStore}
	workEngine := work.NewEngine(workStore, work.DefaultMaxNudges)
	workEngine.SetStepProvider(steps)
	// Before anything can create a session: work the last run left active is
	// dealt with by what it was waiting for, not by what its dead process was
	// doing.
	//
	// It runs before the engine is a listener on the work store, and that order
	// is deliberate — nothing here should be reacting to its own recovery, and
	// the worktree manager that its follow-ups would need does not exist yet.
	// The price is that the stops it makes are heard by nobody, so RecoverStartup
	// re-examines the waits those stops emptied out itself rather than trusting
	// an event to arrive.
	workEngine.RecoverStartup()

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
	agentStatuses := agent.CheckBinaries(slog.Default(), claude.Binary, codex.Binary)

	// Initialize worktree registry and manager
	registry := worktree.NewRegistry(workDir, dataDir)
	registry.SetBaseDirProvider(func() string {
		return settingsStore.Get().WorktreeBaseDir
	})
	worktreeManager := worktree.NewManager(registry, agents, dataDir, leaseBudgets)
	worktreeManager.SetWorkEngine(workEngine)
	// A session list row names the work item its session runs: the store is where
	// that is read, and the listener is what keeps a row up with it.
	worktreeManager.SetWorkStore(workStore)
	workStore.AddOnChangeListener(worktreeManager)
	// Route the engine's follow-up messages to each work's own worktree, and its
	// terminations to the process manager of that worktree.
	workEngine.SetSenderResolver(worktreeManager)
	workEngine.SetSessionTerminator(worktreeManager)
	// Listening starts only now, once the engine can act on what it hears. The
	// other order would drop every change that arrived in between, and a dropped
	// change is a wait nothing comes back to.
	workStore.AddOnChangeListener(workEngine)
	// A deleted session takes away the place every answer would have gone, which
	// is one of the engine's five inputs.
	worktreeManager.AddSessionChangeListener(workEngine)
	workStarter := worktree.NewWorkStarter(worktreeManager, agentRoleStore, settingsStore)
	// Single implementation of every work command, shared by the WebSocket
	// handler (user actions) and the MCP Executor (AI actions).
	workOps := work.NewOperations(workStore, workStarter, workEngine, steps)
	// Deleting a work deletes the sessions under it, on both entry points.
	workOps.SetSessionDeleter(worktreeManager)
	if err := worktreeManager.Start(); err != nil {
		slog.Warn("failed to start worktree manager", "error", err)
	}

	// Local API token for the MCP subprocess. Randomly generated per startup and
	// published to server.json, so it never outlives the process and is distinct
	// from the user-facing password.
	mcpToken, err := generateToken()
	if err != nil {
		slog.Error("failed to generate MCP token", "error", err)
		os.Exit(1)
	}
	mcpHandler := mcp.NewAPIHandler(mcp.NewExecutor(workStore, agentRoleStore, workOps, settingsStore, registry), mcpToken)

	wsHandler := ws.NewRPCHandler(cred.Password, sessions, version, devMode, commandStore, worktreeManager, settingsStore, workStore, workOps, workEngine, agentRoleStore)
	transferHandler := filetransfer.NewHandler(registry, slog.Default())
	handler := newHandler(cred.Password, sessions, devMode, wsHandler, mcpHandler, transferHandler)

	portStr := strconv.Itoa(port)
	srv := &http.Server{
		Addr:    ":" + portStr,
		Handler: handler,
	}

	cloudURL := *cloudURLFlag

	// Initialize relay if enabled
	var relayManager *relay.Manager
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
	}

	// Start listening for exit requests before publishing server.json: that file
	// is how a cluster finds this process, and it may ask us to stop the moment
	// the file appears.
	exitRequests := shutdown.Listen()

	// Write server.json for orchestration programs to discover the running server
	localURL := "http://localhost:" + portStr
	if err := serverinfo.Write(dataDir, port, localURL, remoteURL, mcpToken); err != nil {
		slog.Error("failed to write server.json", "error", err)
		os.Exit(1)
	}

	// Graceful shutdown
	shutdownDone := make(chan struct{})
	go func() {
		<-exitRequests.Done()
		// Restore the default handling, so a second Ctrl+C aborts a shutdown
		// that is taking too long.
		exitRequests.Stop()

		slog.Info("shutting down server")
		// Close the relay before draining srv, not after: every relayed request
		// is served by srv, so a tunnel still delivering traffic into a server
		// that has stopped accepting would turn those requests into errors, and
		// long-lived relayed WebSockets would hold Shutdown until its deadline.
		if relayManager != nil {
			relayManager.Stop()
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := srv.Shutdown(ctx); err != nil {
			slog.Error("server shutdown error", "error", err)
		}
		wsHandler.Stop()
		if err := sessions.Flush(); err != nil {
			slog.Error("failed to persist sessions", "error", err)
		}
		workEngine.Stop()
		worktreeManager.Shutdown()
		settingsStore.StopWatching()
		agentRoleStore.StopWatching()
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
		Agents:       agentStatuses,
	})

	// Print QR code if relay is enabled
	if remoteURL != "" {
		startup.PrintQRCode(remoteURL)
		fmt.Println()
	}

	startup.PrintFooter()

	slog.Info("server starting", "port", port, "workDir", workDir, "dataDir", dataDir, "devMode", devMode, "leaseBudgets", leaseBudgets)
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
	passwordFlag := clusterFlags.String("password", "", "password for the web UI (required; or set "+password.EnvVar+")")
	legacyPasswordFlag := clusterFlags.String("auth-token", "", "deprecated alias for --password (removed in "+password.RemovalVersion+")")
	dataDirFlag := clusterFlags.String("data", "", "data directory (default: ~/.pockode-cluster)")
	relayFlag := clusterFlags.Bool("relay", true, "relay for remote access (use -relay=false to disable)")
	relayFrontendPortFlag := clusterFlags.Int("relay-frontend-port", 0, "relay frontend port (default: same as server port)")
	cloudURLFlag := clusterFlags.String("cloud-url", "https://cloud.pockode.com", "cloud server URL")
	devModeFlag := clusterFlags.Bool("dev", false, "enable development mode")
	clusterFlags.Parse(os.Args[2:])

	cred, err := password.Load(*passwordFlag, *legacyPasswordFlag)
	if err != nil {
		fmt.Fprintln(os.Stderr, "Error: "+err.Error())
		os.Exit(1)
	}
	if cred.Password == "" {
		fmt.Fprintln(os.Stderr, "Error: a password is required: pass --password <password>, or set the "+password.EnvVar+" environment variable (which keeps it out of the process argv)")
		os.Exit(1)
	}

	dataDir := pathutil.ExpandTilde(*dataDirFlag)
	if dataDir == "" {
		homeDir, err := os.UserHomeDir()
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: failed to get home directory: %v\n", err)
			os.Exit(1)
		}
		dataDir = filepath.Join(homeDir, ".pockode-cluster")
	}
	if err := fsperm.RestrictDir(dataDir); err != nil {
		fmt.Fprintf(os.Stderr, "Error: failed to create data directory: %v\n", err)
		os.Exit(1)
	}

	cfg := cluster.Config{
		Port:     *portFlag,
		Password: cred.Password,
		// Logging is not configured until cluster.Run initializes it, so the
		// warning is handed over rather than emitted here.
		PasswordDeprecationWarning: cred.DeprecationWarning,
		DataDir:                    dataDir,
		RelayEnabled:               *relayFlag,
		RelayFrontendPort:          *relayFrontendPortFlag,
		CloudURL:                   *cloudURLFlag,
		Version:                    version,
		DevMode:                    *devModeFlag,
	}

	if err := cluster.Run(cfg); err != nil {
		fmt.Fprintf(os.Stderr, "Error: cluster mode failed: %v\n", err)
		os.Exit(1)
	}
}
