package worktree

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/process"
	"github.com/pockode/server/rpc"
	"github.com/pockode/server/session"
	"github.com/pockode/server/watch"
	"github.com/sourcegraph/jsonrpc2"
)

const idleReleaseDelay = 30 * time.Second

// Manager manages the lifecycle of worktrees with lazy creation and reference-counted cleanup.
type Manager struct {
	registry        *Registry
	agent           agent.Agent
	dataDir         string
	idleTimeout     time.Duration
	WorktreeWatcher *watch.WorktreeWatcher

	mu        sync.Mutex
	worktrees map[string]*Worktree
}

func NewManager(registry *Registry, ag agent.Agent, dataDir string, idleTimeout time.Duration) *Manager {
	return &Manager{
		registry:        registry,
		agent:           ag,
		dataDir:         dataDir,
		idleTimeout:     idleTimeout,
		WorktreeWatcher: watch.NewWorktreeWatcher(registry.MainDir()),
		worktrees:       make(map[string]*Worktree),
	}
}

func (m *Manager) Registry() *Registry {
	return m.registry
}

func (m *Manager) Start() error {
	return m.WorktreeWatcher.Start()
}

// Get returns (or creates) the worktree for the given name and increments the reference count.
func (m *Manager) Get(name string) (*Worktree, error) {
	workDir, err := m.registry.Resolve(name)
	if err != nil {
		return nil, err
	}

	m.mu.Lock()
	if existing, ok := m.worktrees[name]; ok {
		existing.refCount++
		slog.Debug("worktree ref incremented", "name", name, "refCount", existing.refCount)
		m.mu.Unlock()
		return existing, nil
	}
	m.mu.Unlock()

	// Create outside the lock to avoid blocking other goroutines
	wt, err := m.create(name, workDir)
	if err != nil {
		return nil, err
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	// Another goroutine may have created it while we were creating
	if existing, ok := m.worktrees[name]; ok {
		wt.Stop()
		existing.refCount++
		slog.Debug("worktree ref incremented (race)", "name", name, "refCount", existing.refCount)
		return existing, nil
	}

	m.worktrees[name] = wt
	wt.refCount = 1
	slog.Info("worktree created", "name", name, "workDir", workDir)

	return wt, nil
}

// Release decrements the reference count and schedules cleanup after idleReleaseDelay.
func (m *Manager) Release(wt *Worktree) {
	m.mu.Lock()
	wt.refCount--
	refCount := wt.refCount
	slog.Debug("worktree ref decremented", "name", wt.Name, "refCount", refCount)
	m.mu.Unlock()

	if refCount == 0 {
		go func() {
			time.Sleep(idleReleaseDelay)
			m.maybeCleanup(wt)
		}()
	}
}

// ForceShutdown immediately shuts down a worktree, notifies all subscribers,
// and removes the worktree's data directory from .pockode.
func (m *Manager) ForceShutdown(name string) {
	m.mu.Lock()
	wt, exists := m.worktrees[name]
	if exists {
		delete(m.worktrees, name)
	}
	m.mu.Unlock()

	if exists {
		wt.NotifyAll(context.Background(), "worktree.deleted", rpc.WorktreeDeletedParams{Name: name})
		wt.Stop()
		slog.Info("worktree force shutdown", "name", name)
	}

	wtDataDir := filepath.Join(m.dataDir, "worktrees", name)
	if err := os.RemoveAll(wtDataDir); err != nil {
		slog.Warn("failed to remove worktree data directory", "path", wtDataDir, "error", err)
	}
}

func (m *Manager) Shutdown() {
	m.WorktreeWatcher.Stop()

	m.mu.Lock()
	worktrees := make([]*Worktree, 0, len(m.worktrees))
	for _, wt := range m.worktrees {
		worktrees = append(worktrees, wt)
	}
	m.worktrees = make(map[string]*Worktree)
	m.mu.Unlock()

	for _, wt := range worktrees {
		wt.Stop()
	}

	slog.Info("manager shutdown complete", "worktreesClosed", len(worktrees))
}

func (m *Manager) create(name, workDir string) (*Worktree, error) {
	var wtDataDir string
	if name == "" {
		wtDataDir = m.dataDir
	} else {
		wtDataDir = filepath.Join(m.dataDir, "worktrees", name)
	}

	sessionStore, err := session.NewFileStore(wtDataDir)
	if err != nil {
		return nil, fmt.Errorf("create session store: %w", err)
	}

	fsWatcher := watch.NewFSWatcher(workDir)
	gitWatcher := watch.NewGitWatcher(workDir)
	gitDiffWatcher := watch.NewGitDiffWatcher(workDir)
	sessionListWatcher := watch.NewSessionListWatcher(sessionStore)
	chatMessagesWatcher := watch.NewChatMessagesWatcher(sessionStore)
	processManager := process.NewManager(m.agent, workDir, sessionStore, m.idleTimeout)
	processManager.SetMessageListener(chatMessagesWatcher)
	sessionListWatcher.SetProcessStateGetter(processManager)
	processManager.SetOnStateChange(func(e process.StateChangeEvent) {
		sessionListWatcher.NotifyProcessStateChange(e.SessionID, string(e.State))
	})

	wt := &Worktree{
		Name:                name,
		WorkDir:             workDir,
		SessionStore:        sessionStore,
		FSWatcher:           fsWatcher,
		GitWatcher:          gitWatcher,
		GitDiffWatcher:      gitDiffWatcher,
		SessionListWatcher:  sessionListWatcher,
		ChatMessagesWatcher: chatMessagesWatcher,
		ProcessManager:      processManager,
		watchers:            []watch.Watcher{fsWatcher, gitWatcher, gitDiffWatcher, sessionListWatcher, chatMessagesWatcher},
		subscribers:         make(map[*jsonrpc2.Conn]struct{}),
	}

	processManager.SetOnProcessEnd(func() {
		m.maybeCleanup(wt)
	})

	if err := wt.Start(); err != nil {
		return nil, fmt.Errorf("start worktree: %w", err)
	}

	return wt, nil
}

// maybeCleanup cleans up the worktree if it's idle and matches the given pointer.
func (m *Manager) maybeCleanup(target *Worktree) {
	m.mu.Lock()
	shouldStop := m.shouldCleanupLocked(target)
	m.mu.Unlock()

	if shouldStop {
		target.Stop()
		slog.Info("worktree idle cleanup", "name", target.Name)
	}
}

// shouldCleanupLocked checks if the worktree should be cleaned up and removes it from the map if so.
// Returns true if the caller should call wt.Stop().
// Must be called with m.mu held.
func (m *Manager) shouldCleanupLocked(wt *Worktree) bool {
	current, exists := m.worktrees[wt.Name]
	if !exists || current != wt {
		return false
	}

	if wt.refCount > 0 || wt.ProcessManager.ProcessCount() > 0 {
		slog.Debug("worktree cleanup skipped",
			"name", wt.Name,
			"refCount", wt.refCount,
			"processCount", wt.ProcessManager.ProcessCount())
		return false
	}

	delete(m.worktrees, wt.Name)
	return true
}
