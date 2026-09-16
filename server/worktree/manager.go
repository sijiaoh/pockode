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
	"github.com/pockode/server/chat"
	"github.com/pockode/server/process"
	"github.com/pockode/server/rpc"
	"github.com/pockode/server/session"
	"github.com/pockode/server/watch"
	"github.com/pockode/server/work"
)

const idleReleaseDelay = 30 * time.Second

// Manager manages the lifecycle of worktrees with lazy creation and reference-counted cleanup.
type Manager struct {
	registry        *Registry
	agents          *agent.Registry
	dataDir         string
	leaseBudgets    session.LeaseBudgets
	WorktreeWatcher *watch.WorktreeWatcher

	workAutoResumer       *work.AutoResumer
	workStatusSyncer      *work.StatusSyncer
	sessionChangeListener session.OnChangeListener

	mu        sync.Mutex
	worktrees map[string]*Worktree
}

func NewManager(registry *Registry, agents *agent.Registry, dataDir string, budgets session.LeaseBudgets) *Manager {
	return &Manager{
		registry:        registry,
		agents:          agents,
		dataDir:         dataDir,
		leaseBudgets:    budgets,
		WorktreeWatcher: watch.NewWorktreeWatcher(registry.MainDir()),
		worktrees:       make(map[string]*Worktree),
	}
}

// AgentForkSupports returns what every registered agent declares about being
// forked. Agents are registered once per process, so the answer is the same for
// every worktree.
func (m *Manager) AgentForkSupports() map[session.AgentType]agent.ForkSupport {
	return m.agents.ForkSupports()
}

func (m *Manager) Registry() *Registry {
	return m.registry
}

func (m *Manager) SetWorkAutoResumer(ar *work.AutoResumer) {
	m.workAutoResumer = ar
}

// ResolveSender returns the named worktree's ChatClient as a message sender for
// AutoResumer follow-ups, plus a release func that drops the worktree reference
// once the send completes. Implements work.SenderResolver so each work's
// automatic messages route to the worktree the work runs in.
func (m *Manager) ResolveSender(name string) (work.MessageSender, func(), error) {
	wt, err := m.Get(name)
	if err != nil {
		return nil, nil, fmt.Errorf("get worktree %q for message sender: %w", name, err)
	}
	return wt.ChatClient, func() { m.Release(wt) }, nil
}

func (m *Manager) SetWorkStatusSyncer(s *work.StatusSyncer) {
	m.workStatusSyncer = s
}

// SetSessionChangeListener registers a listener on every worktree's session
// store — the ones already built and the ones built later. For state that is
// keyed by session but owned elsewhere: the work detail's usage aggregation,
// which has to be told when a session it sums over changed.
//
// The already-built ones are not a formality. Worktrees are created lazily by
// whoever needs one first, and AutoResumer resolves senders for work it restarts
// while the server is still wiring itself up — so the main worktree can exist
// before this call. Skipping it would leave that worktree's usage frozen for the
// whole process, with nothing to show that it happened.
//
// One listener, set once while the server wires itself up. Calling it again would
// leave the worktrees that already exist holding both.
func (m *Manager) SetSessionChangeListener(l session.OnChangeListener) {
	// One lock covers both halves, and Get registers a new worktree inside the
	// same critical section that inserts it into the map. Otherwise a worktree
	// being created right now would be missed by both halves or taken by both.
	m.mu.Lock()
	defer m.mu.Unlock()

	m.sessionChangeListener = l
	for _, wt := range m.worktrees {
		wt.SessionStore.AddOnChangeListener(l)
	}
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

	// Another goroutine may have created it while we were creating
	if existing, ok := m.worktrees[name]; ok {
		existing.refCount++
		slog.Debug("worktree ref incremented (race)", "name", name, "refCount", existing.refCount)
		m.mu.Unlock()
		// Discarded outside the lock for the same reason it was created outside
		// it: Stop waits for the worktree's goroutines, and no other caller of
		// this manager should have to queue behind that.
		wt.Stop()
		return existing, nil
	}

	m.worktrees[name] = wt
	wt.refCount = 1
	// In the same critical section as the insertion, for the reason
	// SetSessionChangeListener gives: the two halves must not overlap.
	if m.sessionChangeListener != nil {
		wt.SessionStore.AddOnChangeListener(m.sessionChangeListener)
	}
	slog.Info("worktree created", "name", name, "workDir", workDir)
	m.mu.Unlock()

	return wt, nil
}

// RefCount reports how many holders wt currently has. The counter is the only
// record that a Get was matched by a Release, so without an accessor a leaked
// reference is invisible from outside this package.
func (m *Manager) RefCount(wt *Worktree) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return wt.refCount
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

// dataDirFor is where a worktree's own state lives: its session index, its
// agent session state, its history. The main worktree ("") keeps it directly in
// the data dir; the others get a subdirectory each.
func (m *Manager) dataDirFor(name string) string {
	if name == "" {
		return m.dataDir
	}
	return filepath.Join(m.dataDir, "worktrees", name)
}

// SessionUsages implements work.SessionUsageSource, so a work item's detail can
// add up what its subtree consumed even when part of that subtree lives in a
// worktree nothing is currently using.
//
// It reads the index from disk instead of going through the worktree's session
// store, which is what makes that possible: Get would build the whole worktree —
// watchers, process manager, git watches — and hold it alive on a reference,
// because someone opened a page showing numbers.
func (m *Manager) SessionUsages(name string) (map[string]session.Usage, error) {
	// The name comes from a stored work item rather than from the registry —
	// Get/Resolve is what normally vouches for it, and this path deliberately
	// skips both so that a worktree nobody is using still answers. So the name is
	// checked here before it becomes a path: filepath.IsLocal rejects both `..`
	// escapes and Windows device names (see server/AGENTS.md).
	if name != "" && !filepath.IsLocal(name) {
		return nil, fmt.Errorf("worktree name %q is not a directory name", name)
	}
	return session.ReadUsages(m.dataDirFor(name))
}

func (m *Manager) create(name, workDir string) (*Worktree, error) {
	wtDataDir := m.dataDirFor(name)

	sessionStore, err := session.NewFileStore(wtDataDir)
	if err != nil {
		return nil, fmt.Errorf("create session store: %w", err)
	}

	fsWatcher := watch.NewFSWatcher(workDir)
	gitWatcher := watch.NewGitWatcher(workDir)
	gitDiffWatcher := watch.NewGitDiffWatcher(workDir)
	sessionListWatcher := watch.NewSessionListWatcher(sessionStore)
	sessionDetailWatcher := watch.NewSessionDetailWatcher(sessionStore)
	chatMessagesWatcher := watch.NewChatMessagesWatcher(sessionStore)
	// The process manager's data dir is this worktree's own (wtDataDir), so agent
	// session state lands next to the session store. MCP discovery still points at
	// the main data dir (m.dataDir), the only place server.json is written.
	processManager := process.NewManager(m.agents, workDir, wtDataDir, m.dataDir, sessionStore, m.leaseBudgets)
	processManager.SetMessageListener(chatMessagesWatcher)
	sessionListWatcher.SetProcessStateGetter(processManager)
	sessionListWatcher.SetViewingChecker(chatMessagesWatcher)
	if m.workStatusSyncer != nil {
		sessionListWatcher.SetWorkStatusSyncer(m.workStatusSyncer)
	}
	processManager.SetOnStateChange(func(e process.StateChangeEvent) {
		sessionListWatcher.HandleProcessStateChange(e)
		if m.workAutoResumer != nil {
			m.workAutoResumer.HandleProcessStateChange(e.SessionID, string(e.State), e.NeedsInput, e.IsInitial, e.Interrupted)
		}
	})

	chatClient := chat.NewClient(sessionStore, processManager)
	chatClient.SetBroadcaster(func(sessionID string, event agent.MessageEvent, seq session.HistorySeq, exclude any) {
		var n watch.Notifier
		if exclude != nil {
			n = exclude.(watch.Notifier)
		}
		chatMessagesWatcher.NotifyMessage(sessionID, event, seq, n)
	})

	wt := &Worktree{
		Name:                 name,
		WorkDir:              workDir,
		DataDir:              wtDataDir,
		SessionStore:         sessionStore,
		FSWatcher:            fsWatcher,
		GitWatcher:           gitWatcher,
		GitDiffWatcher:       gitDiffWatcher,
		SessionListWatcher:   sessionListWatcher,
		SessionDetailWatcher: sessionDetailWatcher,
		ChatMessagesWatcher:  chatMessagesWatcher,
		ProcessManager:       processManager,
		ChatClient:           chatClient,
		watchers:             []watch.Watcher{fsWatcher, gitWatcher, gitDiffWatcher, sessionListWatcher, sessionDetailWatcher, chatMessagesWatcher},
		subscribers:          make(map[watch.Notifier]struct{}),
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
