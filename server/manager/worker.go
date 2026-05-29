// Package manager provides multi-workspace management for Pockode's manager mode.
package manager

import (
	"fmt"
	"log/slog"
	"path/filepath"
	"sync"
	"time"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/agent/claude"
	"github.com/pockode/server/agent/codex"
	"github.com/pockode/server/agentrole"
	"github.com/pockode/server/command"
	"github.com/pockode/server/globalconfig"
	"github.com/pockode/server/logger"
	"github.com/pockode/server/session"
	"github.com/pockode/server/settings"
	"github.com/pockode/server/work"
	"github.com/pockode/server/worktree"
	"github.com/pockode/server/ws"
)

// WorkerState represents the current state of a worker.
type WorkerState string

const (
	WorkerStateStarting WorkerState = "starting"
	WorkerStateRunning  WorkerState = "running"
	WorkerStateStopping WorkerState = "stopping"
	WorkerStateStopped  WorkerState = "stopped"
	WorkerStateError    WorkerState = "error"
)

// WorkerConfig holds configuration for a worker.
type WorkerConfig struct {
	// Workspace is the registered workspace info.
	Workspace globalconfig.Workspace

	// IdleTimeout is the idle timeout for processes.
	IdleTimeout time.Duration

	// Auth/version config for RPC handler
	Token   string
	Version string
	DevMode bool
}

// Worker manages all resources for a single workspace.
type Worker struct {
	config WorkerConfig

	workDir string
	dataDir string

	commandStore   *command.Store
	settingsStore  *settings.Store
	workStore      *work.FileStore
	agentRoleStore *agentrole.FileStore

	agents *agent.Registry

	worktreeManager *worktree.Manager
	workAutoResumer *work.AutoResumer
	workStarter     *worktree.WorkStarter
	workStopper     *worktree.WorkStopper
	rpcHandler      *ws.RPCHandler

	mu       sync.RWMutex
	state    WorkerState
	stateErr error
}

// NewWorker creates a new worker for the given workspace.
func NewWorker(cfg WorkerConfig) *Worker {
	return &Worker{
		config:  cfg,
		workDir: cfg.Workspace.Path,
		dataDir: filepath.Join(cfg.Workspace.Path, ".pockode"),
		state:   WorkerStateStopped,
	}
}

func (w *Worker) ID() string           { return w.config.Workspace.ID }
func (w *Worker) Name() string         { return w.config.Workspace.Name }
func (w *Worker) Path() string         { return w.workDir }
func (w *Worker) DataDir() string      { return w.dataDir }

func (w *Worker) State() WorkerState {
	w.mu.RLock()
	defer w.mu.RUnlock()
	return w.state
}

func (w *Worker) StateError() error {
	w.mu.RLock()
	defer w.mu.RUnlock()
	return w.stateErr
}

// Start initializes and starts all worker components.
func (w *Worker) Start() error {
	w.mu.Lock()
	if w.state == WorkerStateRunning || w.state == WorkerStateStarting {
		w.mu.Unlock()
		return nil
	}
	w.state = WorkerStateStarting
	w.stateErr = nil
	w.mu.Unlock()

	if err := w.initialize(); err != nil {
		w.mu.Lock()
		w.state = WorkerStateError
		w.stateErr = err
		w.mu.Unlock()
		return err
	}

	w.mu.Lock()
	w.state = WorkerStateRunning
	w.mu.Unlock()

	slog.Info("worker started",
		"id", w.ID(),
		"name", w.Name(),
		"workDir", w.workDir,
		"dataDir", w.dataDir)

	return nil
}

// Stop gracefully shuts down all worker components.
func (w *Worker) Stop() {
	w.mu.Lock()
	if w.state == WorkerStateStopped || w.state == WorkerStateStopping {
		w.mu.Unlock()
		return
	}
	w.state = WorkerStateStopping
	w.mu.Unlock()

	w.shutdown()

	w.mu.Lock()
	w.state = WorkerStateStopped
	w.mu.Unlock()

	slog.Info("worker stopped", "id", w.ID(), "name", w.Name())
}

func (w *Worker) WorktreeManager() *worktree.Manager   { return w.worktreeManager }
func (w *Worker) SettingsStore() *settings.Store       { return w.settingsStore }
func (w *Worker) WorkStore() *work.FileStore           { return w.workStore }
func (w *Worker) AgentRoleStore() *agentrole.FileStore { return w.agentRoleStore }
func (w *Worker) CommandStore() *command.Store         { return w.commandStore }
func (w *Worker) WorkStarter() *worktree.WorkStarter   { return w.workStarter }
func (w *Worker) WorkStopper() *worktree.WorkStopper   { return w.workStopper }

// RPCHandler returns the RPC handler for this worker.
// Creates the handler on first call (lazy initialization).
func (w *Worker) RPCHandler() *ws.RPCHandler {
	w.mu.Lock()
	defer w.mu.Unlock()

	if w.rpcHandler == nil && w.state == WorkerStateRunning {
		w.rpcHandler = ws.NewRPCHandler(
			w.config.Token,
			w.config.Version,
			w.config.DevMode,
			w.commandStore,
			w.worktreeManager,
			w.settingsStore,
			w.workStore,
			w.workStarter,
			w.workStopper,
			w.agentRoleStore,
		)
	}
	return w.rpcHandler
}

// initialize sets up all worker components.
func (w *Worker) initialize() error {
	logger.Init(logger.Config{
		DataDir: w.dataDir,
		DevMode: false,
	})

	var err error

	w.commandStore, err = command.NewStore(w.dataDir)
	if err != nil {
		return fmt.Errorf("initialize command store: %w", err)
	}

	w.settingsStore, err = settings.NewStore(w.dataDir)
	if err != nil {
		return fmt.Errorf("initialize settings store: %w", err)
	}
	if err := w.settingsStore.StartWatching(); err != nil {
		slog.Warn("failed to start settings store watcher", "error", err)
	}

	if err := worktree.InitSetupHook(w.dataDir); err != nil {
		return fmt.Errorf("initialize worktree setup hook: %w", err)
	}

	w.workStore, err = work.NewFileStore(w.dataDir)
	if err != nil {
		return fmt.Errorf("initialize work store: %w", err)
	}

	w.agentRoleStore, err = agentrole.NewFileStore(w.dataDir)
	if err != nil {
		return fmt.Errorf("initialize agent role store: %w", err)
	}

	w.workAutoResumer = work.NewAutoResumer(w.workStore, 3)
	w.workAutoResumer.StopOrphanedWork()
	w.workAutoResumer.SetStepProvider(&agentRoleStepAdapter{store: w.agentRoleStore})
	session.ClearOrphanedNeedsInput(w.dataDir)
	w.workStore.AddOnChangeListener(w.workAutoResumer)

	if err := w.workStore.StartWatching(); err != nil {
		slog.Warn("failed to start work store watcher", "error", err)
	}
	if err := w.agentRoleStore.StartWatching(); err != nil {
		slog.Warn("failed to start agent role store watcher", "error", err)
	}

	// Set PM as default agent role on first launch
	if pmID := w.agentRoleStore.SeededPMRoleID(); pmID != "" {
		cfg := w.settingsStore.Get()
		cfg.DefaultAgentRoleID = pmID
		if err := w.settingsStore.Update(cfg); err != nil {
			slog.Error("failed to set default agent role", "error", err)
		}
	}

	w.agents = agent.NewRegistry()
	w.agents.Register(session.AgentTypeClaude, claude.New())
	w.agents.Register(session.AgentTypeCodex, codex.New())

	registry := worktree.NewRegistry(w.workDir, w.dataDir)
	w.worktreeManager = worktree.NewManager(registry, w.agents, w.dataDir, w.config.IdleTimeout)
	w.worktreeManager.SetWorkAutoResumer(w.workAutoResumer)
	w.worktreeManager.SetWorkNeedsInputSyncer(work.NewNeedsInputSyncer(w.workStore))

	w.workStarter = worktree.NewWorkStarter(w.worktreeManager, w.agentRoleStore, w.settingsStore)
	w.workStopper = worktree.NewWorkStopper(w.worktreeManager, w.workStore)
	w.workAutoResumer.SetStartHandler(w.workStarter)

	if err := w.worktreeManager.Start(); err != nil {
		slog.Warn("failed to start worktree manager", "error", err)
	}

	return nil
}

// shutdown cleans up all worker resources.
func (w *Worker) shutdown() {
	w.mu.Lock()
	rpcHandler := w.rpcHandler
	w.rpcHandler = nil
	w.mu.Unlock()

	if rpcHandler != nil {
		rpcHandler.Stop()
	}
	if w.workAutoResumer != nil {
		w.workAutoResumer.Stop()
	}
	if w.worktreeManager != nil {
		w.worktreeManager.Shutdown()
	}
	if w.settingsStore != nil {
		w.settingsStore.StopWatching()
	}
	if w.workStore != nil {
		w.workStore.StopWatching()
	}
	if w.agentRoleStore != nil {
		w.agentRoleStore.StopWatching()
	}
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
