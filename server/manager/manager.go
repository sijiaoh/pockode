package manager

import (
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/pockode/server/globalconfig"
)

// ManagerConfig holds configuration for the manager.
type ManagerConfig struct {
	// IdleTimeout is the default idle timeout for worker processes.
	IdleTimeout time.Duration

	// Auth/version config passed to workers
	Token   string
	Version string
	DevMode bool
}

// Manager manages multiple workers, one per workspace.
type Manager struct {
	config         ManagerConfig
	workspaceStore *globalconfig.WorkspaceStore

	mu      sync.RWMutex
	workers map[string]*Worker // keyed by workspace ID
}

// NewManager creates a new multi-workspace manager.
func NewManager(cfg ManagerConfig) (*Manager, error) {
	wsStore, err := globalconfig.NewWorkspaceStore()
	if err != nil {
		return nil, fmt.Errorf("create workspace store: %w", err)
	}

	return &Manager{
		config:         cfg,
		workspaceStore: wsStore,
		workers:        make(map[string]*Worker),
	}, nil
}

// StartWorker starts a worker for the given workspace ID.
// If the worker is already running, this is a no-op.
func (m *Manager) StartWorker(workspaceID string) error {
	m.mu.Lock()
	existing, hasExisting := m.workers[workspaceID]
	m.mu.Unlock()

	if hasExisting {
		if existing.State() == WorkerStateRunning {
			return nil
		}
		existing.Stop()
		m.mu.Lock()
		delete(m.workers, workspaceID)
		m.mu.Unlock()
	}

	ws, err := m.workspaceStore.Get(workspaceID)
	if err != nil {
		return fmt.Errorf("get workspace: %w", err)
	}
	if ws == nil {
		return fmt.Errorf("workspace not found: %s", workspaceID)
	}

	worker := NewWorker(WorkerConfig{
		Workspace:   *ws,
		IdleTimeout: m.config.IdleTimeout,
		Token:       m.config.Token,
		Version:     m.config.Version,
		DevMode:     m.config.DevMode,
	})

	if err := worker.Start(); err != nil {
		return fmt.Errorf("start worker: %w", err)
	}

	m.mu.Lock()
	m.workers[workspaceID] = worker
	m.mu.Unlock()

	return nil
}

// StopWorker stops the worker for the given workspace ID.
func (m *Manager) StopWorker(workspaceID string) {
	m.mu.Lock()
	worker, ok := m.workers[workspaceID]
	if ok {
		delete(m.workers, workspaceID)
	}
	m.mu.Unlock()

	if ok {
		worker.Stop()
	}
}

func (m *Manager) GetWorker(workspaceID string) *Worker {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.workers[workspaceID]
}

func (m *Manager) GetWorkerByPath(path string) *Worker {
	m.mu.RLock()
	defer m.mu.RUnlock()

	for _, worker := range m.workers {
		if worker.Path() == path {
			return worker
		}
	}
	return nil
}

func (m *Manager) ListWorkers() []*Worker {
	m.mu.RLock()
	defer m.mu.RUnlock()

	workers := make([]*Worker, 0, len(m.workers))
	for _, worker := range m.workers {
		workers = append(workers, worker)
	}
	return workers
}

// WorkerStatus represents the status of a worker.
type WorkerStatus struct {
	WorkspaceID   string
	WorkspaceName string
	WorkspacePath string
	State         WorkerState
	Error         error
}

func (m *Manager) ListWorkerStatuses() []WorkerStatus {
	m.mu.RLock()
	defer m.mu.RUnlock()

	statuses := make([]WorkerStatus, 0, len(m.workers))
	for _, worker := range m.workers {
		statuses = append(statuses, WorkerStatus{
			WorkspaceID:   worker.ID(),
			WorkspaceName: worker.Name(),
			WorkspacePath: worker.Path(),
			State:         worker.State(),
			Error:         worker.StateError(),
		})
	}
	return statuses
}

func (m *Manager) WorkspaceStore() *globalconfig.WorkspaceStore { return m.workspaceStore }

// Shutdown stops all workers gracefully.
func (m *Manager) Shutdown() {
	m.mu.Lock()
	workers := make([]*Worker, 0, len(m.workers))
	for _, worker := range m.workers {
		workers = append(workers, worker)
	}
	m.workers = make(map[string]*Worker)
	m.mu.Unlock()

	var wg sync.WaitGroup
	for _, worker := range workers {
		wg.Add(1)
		go func(w *Worker) {
			defer wg.Done()
			w.Stop()
		}(worker)
	}
	wg.Wait()

	slog.Info("manager shutdown complete", "workersStopped", len(workers))
}
