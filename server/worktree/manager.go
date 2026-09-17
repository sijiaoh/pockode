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

	workEngine *work.Engine
	// workStore is read by every worktree's session list: a row names the work
	// item its session runs, and that relation lives on the work item.
	workStore work.Store
	// sessionChangeListeners are registered on every worktree's session store,
	// the ones already built and the ones built later.
	sessionChangeListeners []session.OnChangeListener

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

// SetWorkEngine installs what drives work items. Every worktree built after
// this call reports its settled turn endings to it — the engine's main input.
func (m *Manager) SetWorkEngine(e *work.Engine) {
	m.workEngine = e
}

// SetWorkStore installs where a session's work item is looked up. Every worktree
// built after this call resolves its rows' work ids through it.
func (m *Manager) SetWorkStore(s work.Store) {
	m.workStore = s
}

// OnWorkChange implements work.OnChangeListener: a session names the work item
// it runs — on its list row and on its detail — and nothing about the session
// moves when that relation does.
//
// Routed through the manager rather than each worktree's watcher registering on
// the work store itself, because that store is global and keeps its listeners
// for the life of the process, while worktrees are built and dropped as clients
// come and go — a watcher registered there would outlive its worktree and hold
// it alive.
//
// Only loaded worktrees are looked at: an unloaded one has no subscribers, so
// there is nobody to notify, and building it here would defeat the cleanup that
// unloaded it.
func (m *Manager) OnWorkChange(event work.ChangeEvent) {
	if wt, ok := m.loaded(event.Work.Worktree); ok {
		wt.SessionListWatcher.HandleWorkChange(event)
		wt.SessionDetailWatcher.HandleWorkChange(event)
	}
}

// StopSession implements work.SessionTerminator: a work that stopped has no
// lease left, so its process goes now.
//
// Only worktrees that are already loaded are looked at, and that is exact rather
// than best-effort: a worktree holding a live process is never cleaned up (see
// shouldCleanupLocked), so an unloaded worktree provably has no process to
// stop. Building one here would mean starting watchers and a process manager
// for every work a restart stops.
func (m *Manager) StopSession(worktree, sessionID string) {
	if wt, ok := m.loaded(worktree); ok {
		wt.ProcessManager.Close(sessionID)
	}
}

// RetireSession implements work.SessionTerminator: a closed work's session may
// finish what it was saying and then ends. See process.Manager.RetireSession.
func (m *Manager) RetireSession(worktree, sessionID string) {
	if wt, ok := m.loaded(worktree); ok {
		wt.ProcessManager.RetireSession(sessionID)
	}
}

// DeleteSessions implements work.SessionDeleter: the sessions of a deleted work
// go with it, processes first.
//
// Unlike StopSession and RetireSession this one loads the worktree it is given,
// because the records to remove are on disk whether or not anybody has the
// worktree open — and a session left behind is unreachable, its work being the
// only way into it.
func (m *Manager) DeleteSessions(ctx context.Context, worktree string, sessionIDs []string) {
	if len(sessionIDs) == 0 {
		return
	}

	wt, err := m.Get(worktree)
	if err != nil {
		slog.Warn("could not get worktree for session cleanup", "worktree", worktree, "error", err)
		return
	}
	defer m.Release(wt)

	for _, sid := range sessionIDs {
		wt.ProcessManager.Close(sid)
		if err := wt.SessionStore.Delete(ctx, sid); err != nil {
			slog.Warn("failed to delete session during work cleanup", "sessionId", sid, "error", err)
		}
	}
}

// SessionTurns implements work.TurnSource, so a work's activity can be derived
// for a worktree nobody has opened.
//
// Loaded worktrees are answered from their store, which is the live value;
// everything else is read off the index on disk, for the reason SessionUsages
// gives — a row in a list must not build a worktree.
func (m *Manager) SessionTurns(name string) (map[string]session.TurnState, error) {
	if wt, ok := m.loaded(name); ok {
		metas, err := wt.SessionStore.List()
		if err != nil {
			return nil, err
		}
		turns := make(map[string]session.TurnState, len(metas))
		for _, meta := range metas {
			turns[meta.ID] = meta.Turn
		}
		return turns, nil
	}

	// The name comes from a stored work item rather than from the registry, so
	// it is checked before it becomes a path — see SessionUsages.
	if name != "" && !filepath.IsLocal(name) {
		return nil, fmt.Errorf("worktree name %q is not a directory name", name)
	}
	return session.ReadTurns(m.dataDirFor(name))
}

// loaded reports the worktree of that name only if it already exists, without
// creating one or taking a reference.
func (m *Manager) loaded(name string) (*Worktree, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	wt, ok := m.worktrees[name]
	return wt, ok
}

// ResolveSender returns the named worktree's ChatClient as a message sender for
// the work engine's follow-ups, plus a release func that drops the worktree
// reference once the send completes. Implements work.SenderResolver so each work's
// automatic messages route to the worktree the work runs in.
func (m *Manager) ResolveSender(name string) (work.MessageSender, func(), error) {
	wt, err := m.Get(name)
	if err != nil {
		return nil, nil, fmt.Errorf("get worktree %q for message sender: %w", name, err)
	}
	return wt.ChatClient, func() { m.Release(wt) }, nil
}

// AddSessionChangeListener registers a listener on every worktree's session
// store — the ones already built and the ones built later. For state that is
// keyed by session but owned elsewhere: the work detail's usage aggregation and
// the work list's activity, which have to be told when a session they read
// changed, and the work engine, which stops a work whose session was deleted.
//
// The already-built ones are not a formality. Worktrees are created lazily by
// whoever needs one first, and the engine resolves senders for work it restarts
// while the server is still wiring itself up — so the main worktree can exist
// before this call. Skipping it would leave that worktree's usage frozen for the
// whole process, with nothing to show that it happened.
//
// Each listener is added once, while the server wires itself up: a listener
// registered twice would see every session change twice.
func (m *Manager) AddSessionChangeListener(l session.OnChangeListener) {
	// One lock covers both halves, and Get registers a new worktree inside the
	// same critical section that inserts it into the map. Otherwise a worktree
	// being created right now would be missed by both halves or taken by both.
	m.mu.Lock()
	defer m.mu.Unlock()

	m.sessionChangeListeners = append(m.sessionChangeListeners, l)
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
	// AddSessionChangeListener gives: the two halves must not overlap.
	for _, l := range m.sessionChangeListeners {
		wt.SessionStore.AddOnChangeListener(l)
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
	sessionListWatcher := watch.NewSessionListWatcher(sessionStore, m.workStore)
	sessionDetailWatcher := watch.NewSessionDetailWatcher(sessionStore, m.workStore)
	chatMessagesWatcher := watch.NewChatMessagesWatcher(sessionStore)
	// The process manager's data dir is this worktree's own (wtDataDir), so agent
	// session state lands next to the session store. MCP discovery still points at
	// the main data dir (m.dataDir), the only place server.json is written.
	processManager := process.NewManager(m.agents, workDir, wtDataDir, m.dataDir, sessionStore, m.leaseBudgets)
	processManager.SetMessageListener(chatMessagesWatcher)
	sessionListWatcher.SetViewingChecker(chatMessagesWatcher)
	processManager.SetOnStateChange(sessionListWatcher.HandleProcessStateChange)
	if m.workEngine != nil {
		// The engine hears a turn *ending*, not every state change: a settled
		// ending is the only thing about a session it acts on, and the settling
		// is the session layer's job (session.TurnSettler).
		engine := m.workEngine
		processManager.SetOnTurnEnded(func(end session.TurnEnd) {
			engine.HandleTurnEnded(end.SessionID, end.Outcome)
		})
	}

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
