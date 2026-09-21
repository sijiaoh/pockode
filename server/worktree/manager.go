package worktree

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
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
	// questions is the project-wide index of request ids still waiting for an
	// answer. It is one of the manager's own session listeners rather than
	// something main wires up: it is what makes LocateQuestions answerable, and
	// a manager whose index nobody registered would answer "no such question"
	// about every question there is.
	questions *questionIndex

	mu        sync.Mutex
	worktrees map[string]*Worktree
}

func NewManager(registry *Registry, agents *agent.Registry, dataDir string, budgets session.LeaseBudgets) *Manager {
	m := &Manager{
		registry:        registry,
		agents:          agents,
		dataDir:         dataDir,
		leaseBudgets:    budgets,
		WorktreeWatcher: watch.NewWorktreeWatcher(registry.MainDir()),
		worktrees:       make(map[string]*Worktree),
		questions:       newQuestionIndex(),
	}
	m.sessionChangeListeners = append(m.sessionChangeListeners, m.questions)
	return m
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
//
// The process half only touches a worktree that is already loaded, for the
// reason StopSession gives; the questions half cannot work that way, for the
// reason WithdrawQuestions gives. A question on a closed work is one the user
// can never clear, because the surfaces that offer it are gone with the work.
func (m *Manager) RetireSession(worktree, sessionID string) {
	if wt, ok := m.loaded(worktree); ok {
		wt.ProcessManager.RetireSession(sessionID)
	}
	m.WithdrawQuestions(worktree, sessionID, agent.ReasonWorkClosed)
}

// WithdrawQuestions implements work.QuestionWithdrawer: it takes back every
// question the session is still waiting on, saying why.
//
// A worktree that is not loaded is loaded for this, and only for this — but only
// when the index on disk already says there is something to withdraw, so the
// ordinary case still costs one file read. That is the opposite of StopSession's
// rule and has to be: a process cannot exist in an unloaded worktree, while a
// posted question outlives every process and is just as likely to be sitting in
// one nobody has opened.
func (m *Manager) WithdrawQuestions(worktree, sessionID string, reason agent.CancelReason) {
	turns, err := m.SessionTurns(worktree)
	if err != nil {
		slog.Warn("could not read sessions to withdraw a session's questions",
			"worktree", worktree, "sessionId", sessionID, "reason", reason, "error", err)
		return
	}
	if len(turns[sessionID].Unanswered) == 0 {
		return
	}

	wt, err := m.Get(worktree)
	if err != nil {
		slog.Warn("could not get worktree to withdraw a session's questions",
			"worktree", worktree, "sessionId", sessionID, "reason", reason, "error", err)
		return
	}
	defer m.Release(wt)

	wt.ChatClient.WithdrawQuestions(context.Background(), sessionID, reason)
}

// ResolveQuestions returns the named worktree's question service plus the
// release func that drops the worktree reference once the call completes. It is
// how the MCP executor reaches the session a tool call came from: an agent's
// caller identity names a worktree, and the sessions live per worktree.
func (m *Manager) ResolveQuestions(name string) (chat.Questions, func(), error) {
	wt, err := m.Get(name)
	if err != nil {
		return nil, nil, fmt.Errorf("get worktree %q for questions: %w", name, err)
	}
	return wt.ChatClient, func() { m.Release(wt) }, nil
}

// DeleteSessions implements work.SessionDeleter: the sessions of a deleted work
// go with it, processes first.
//
// Unlike StopSession and RetireSession this one reaches sessions nobody has
// open, because the records to remove are on disk whether or not anybody has
// the worktree open — and a session left behind is unreachable, its work being
// the only way into it. That includes a worktree that no longer exists: its
// sessions are deliberately kept (ForceShutdown), so this is one of the two
// outlets that keep what is kept from being everything.
func (m *Manager) DeleteSessions(ctx context.Context, worktree string, sessionIDs []string) {
	if len(sessionIDs) == 0 {
		return
	}

	deleteOne, done, err := m.sessionDeleter(worktree)
	if err != nil {
		slog.Warn("could not reach a worktree's sessions for cleanup", "worktree", worktree, "error", err)
		return
	}
	defer done()

	for _, sid := range sessionIDs {
		if err := deleteOne(ctx, sid); err != nil {
			slog.Warn("failed to delete session during work cleanup", "sessionId", sid, "error", err)
		}
	}
}

// DeleteSession removes one session's stored data, whatever became of the
// worktree it belongs to. It is how a session is deleted by hand, including one
// whose worktree is gone: what cannot be continued must still be discardable,
// or the data a deletion keeps is kept forever.
func (m *Manager) DeleteSession(ctx context.Context, worktree, sessionID string) error {
	deleteOne, done, err := m.sessionDeleter(worktree)
	if err != nil {
		return err
	}
	defer done()

	return deleteOne(ctx, sessionID)
}

// sessionDeleter resolves how the named worktree's sessions are deleted, and
// what has to happen once the caller is finished.
//
// A worktree that still exists is loaded and deleted through, because a session
// there may have a live process to close, and its store owns the directory —
// writing underneath it would be undone by its next write. One that is gone has
// neither, so its index is rewritten on disk directly, and the directory itself
// is then dropped if that was its last session.
func (m *Manager) sessionDeleter(name string) (func(context.Context, string) error, func(), error) {
	wt, err := m.Get(name)
	if err == nil {
		return func(ctx context.Context, sessionID string) error {
				wt.ProcessManager.Close(sessionID)
				return wt.SessionStore.Delete(ctx, sessionID)
			}, func() {
				m.Release(wt)
			}, nil
	}
	if !errors.Is(err, ErrWorktreeNotFound) {
		// Anything else — a directory that is no longer a git repository, a
		// worktree that exists but could not be built — is not "it was deleted",
		// and deleting its sessions from under a store that may yet open is not
		// the way to handle it.
		return nil, nil, fmt.Errorf("get worktree %q to delete a session: %w", name, err)
	}

	dir, dirErr := m.SessionDataDir(name)
	if dirErr != nil {
		return nil, nil, dirErr
	}
	// Nothing is notified along this branch, and there is nobody to notify: the
	// worktree's watchers stopped with it, and the work engine's interest in a
	// deleted session is to stop the work that was waiting in it — which a
	// worktree with unclosed work cannot be deleted while.
	return func(ctx context.Context, sessionID string) error {
			if err := ctx.Err(); err != nil {
				return err
			}
			return session.DeleteInDir(dir, sessionID)
		}, func() {
			m.pruneEmptySessionData(name, dir)
		}, nil
}

// pruneEmptySessionData removes a deleted worktree's data directory once the
// last session in it is gone.
//
// SessionSources already stops offering a worktree with no sessions, so this is
// not what makes it disappear from the list — it is what keeps the deletion
// from leaving an empty directory per worktree that ever existed, growing with
// nothing in it.
//
// Only for a worktree that is gone, which is why it asks the registry rather
// than trusting its caller: an existing worktree's directory holds live state
// beyond the sessions (agent session state, history) and may have a store open
// on it. The main worktree's directory is the project's own and is never
// touched.
func (m *Manager) pruneEmptySessionData(name, dir string) {
	if name == "" {
		return
	}

	// Before the registry, which may have to ask git: a worktree that still has
	// sessions is the ordinary case and is answered by one file read.
	sessions, err := session.NewDirReader(dir).List()
	if err != nil {
		slog.Warn("could not check whether a deleted worktree still has sessions",
			"worktree", name, "error", err)
		return
	}
	if len(sessions) > 0 {
		return
	}

	if _, err := m.registry.Resolve(name); err == nil {
		return
	}

	if err := os.RemoveAll(dir); err != nil {
		slog.Warn("failed to remove the data directory of a deleted worktree",
			"worktree", name, "error", err)
		return
	}
	slog.Info("removed the data directory of a deleted worktree with no sessions left", "worktree", name)
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

	return readTurns(m.dataDir, name)
}

// readTurns reads one worktree's session index straight off disk.
//
// The name comes from a stored work item rather than from the registry, so it
// is checked before it becomes a path — see SessionUsages.
func readTurns(dataDir, name string) (map[string]session.TurnState, error) {
	if name != "" && !filepath.IsLocal(name) {
		return nil, fmt.Errorf("worktree name %q is not a directory name", name)
	}
	return session.ReadTurns(dataDirFor(dataDir, name))
}

// StartupTurns is a work.TurnSource that answers only from disk, for the one
// caller that needs one before a Manager exists: work.Engine.RecoverStartup
// runs before the worktree manager is built, deliberately (see main.go).
//
// Reading the file is not a compromise there, it is the whole truth: no process
// survived the restart, so nothing holds a turn state newer than what was
// written.
type StartupTurns struct{ DataDir string }

func (t StartupTurns) SessionTurns(name string) (map[string]session.TurnState, error) {
	return readTurns(t.DataDir, name)
}

// ErrSessionNotFound reports that no worktree owns the given session.
var ErrSessionNotFound = errors.New("session not found in any worktree")

// ResolveSessionWorktree answers which worktree a session lives in. Sessions are
// stored per worktree and nothing else maps one to the other, so anything holding
// a bare session id — a caller identity reported over MCP, a record keyed by
// session — needs this to reach the store that owns it.
//
// It goes through SessionTurns, so a loaded worktree answers from its live store
// and the rest are read off their index on disk: resolving a session must not
// build every worktree in the project. The scan is over worktrees, not sessions,
// and only runs when something arrives without a worktree name.
func (m *Manager) ResolveSessionWorktree(sessionID string) (string, error) {
	if sessionID == "" {
		return "", ErrSessionNotFound
	}
	for _, info := range m.registry.List() {
		turns, err := m.SessionTurns(info.Name)
		if err != nil {
			// One unreadable worktree must not hide a session another one has.
			slog.Warn("could not read sessions while resolving worktree", "worktree", info.Name, "error", err)
			continue
		}
		if _, ok := turns[sessionID]; ok {
			return info.Name, nil
		}
	}
	return "", fmt.Errorf("%w: %s", ErrSessionNotFound, sessionID)
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
	// Before the watcher, so that the first thing anything can ask about a
	// question is answered from disk rather than from an empty map.
	m.rebuildQuestionIndex()
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

// ForceShutdown immediately shuts down a worktree and notifies all subscribers.
//
// The worktree's data directory is deliberately left in place. A work usually
// runs in a worktree of its own and the worktree is cleaned up once the work is
// done — so removing the data here destroyed the conversation that produced the
// result, with no way back. What is left is readable from anywhere else in the
// project (see SessionReader) and never writable: the worktree is marked
// deleted, which is what refuses everything a connection still bound to it
// might send.
//
// It is not meant to accumulate forever either: a session's data goes when the
// work item that owns it is deleted, or when the session itself is deleted.
// Both outlets go on working afterwards (see DeleteSession), and the directory
// itself goes with the last session in it (pruneEmptySessionData).
func (m *Manager) ForceShutdown(name string) {
	m.mu.Lock()
	wt, exists := m.worktrees[name]
	if exists {
		delete(m.worktrees, name)
	}
	m.mu.Unlock()

	if exists {
		wt.MarkDeleted()
		wt.NotifyAll(context.Background(), "worktree.deleted", rpc.WorktreeDeletedParams{Name: name})
		wt.Stop()
		slog.Info("worktree force shutdown", "name", name)
	}

	// The directory is kept for the sessions in it, so a worktree whose sessions
	// were all deleted before it was has nothing to keep. Outside the branch
	// above: a worktree nobody had open is just as likely to be the empty one.
	m.pruneEmptySessionData(name, m.dataDirFor(name))
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
	return dataDirFor(m.dataDir, name)
}

func dataDirFor(dataDir, name string) string {
	if name == "" {
		return dataDir
	}
	return filepath.Join(dataDir, "worktrees", name)
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
	dir, err := m.SessionDataDir(name)
	if err != nil {
		return nil, err
	}
	return session.ReadUsages(dir)
}

// SessionDataDir is where the named worktree's sessions are stored, whether or
// not that worktree still exists.
//
// The name may come from a stored work item or straight off the wire rather
// than from the registry — Get/Resolve is what normally vouches for it, and the
// cross-worktree read paths deliberately skip both, so that a worktree nobody
// is using (or one that is gone) still answers. So the name is checked here
// before it becomes a path: filepath.IsLocal rejects both `..` escapes and
// Windows device names (see server/AGENTS.md).
func (m *Manager) SessionDataDir(name string) (string, error) {
	if name != "" && !filepath.IsLocal(name) {
		return "", fmt.Errorf("worktree name %q is not a directory name", name)
	}
	return m.dataDirFor(name), nil
}

// SessionReader is how one worktree reads another's sessions: the live store
// when that worktree is loaded, the index on disk when it is not — which
// includes every worktree that has been deleted.
//
// A Reader and not a Store, and that is the whole design. Sessions belonging to
// a worktree other than the one the client is in are shown, never continued:
// there is no execution environment to continue them in, and for a worktree
// that still exists the client is expected to switch to it rather than talk to
// it from outside. Refusing that is structural here rather than a rule every
// handler has to remember.
//
// Reading through the live store when there is one matters for the same reason
// SessionTurns does it: the store is the current value, and a second FileStore
// over a directory that already has one is exactly what FileStore forbids.
func (m *Manager) SessionReader(name string) (session.Reader, error) {
	if wt, ok := m.loaded(name); ok {
		return wt.SessionStore, nil
	}
	dir, err := m.SessionDataDir(name)
	if err != nil {
		return nil, err
	}
	return session.NewDirReader(dir), nil
}

// SessionSource is one worktree that still has sessions stored under it.
type SessionSource struct {
	// Name is the worktree's name; "" is the main worktree.
	Name string
	// Exists reports whether the worktree itself is still there. A source that
	// does not exist can only be read; one that does can be switched to and
	// used normally.
	//
	// A worktree recreated under the name of a deleted one exists again, and
	// inherits the stored sessions by doing so — the data is keyed by name and
	// nothing moves it. That is deliberate: the alternative is renaming
	// somebody's data behind their back to keep two eras apart, and the two
	// eras are the same branch under the same name.
	Exists bool
	// SessionCount is how many sessions are stored. A source with none is not
	// reported at all, so an emptied directory stops offering itself as a place
	// to look.
	SessionCount int
}

// SessionSources lists every worktree that still has session data, existing or
// deleted, so a client can offer them as places to read from.
func (m *Manager) SessionSources() ([]SessionSource, error) {
	existing := make(map[string]bool)
	for _, info := range m.registry.List() {
		existing[info.Name] = true
	}

	names := []string{""}
	entries, err := os.ReadDir(filepath.Join(m.dataDir, "worktrees"))
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, fmt.Errorf("read worktree data directories: %w", err)
	}
	for _, entry := range entries {
		if entry.IsDir() {
			names = append(names, entry.Name())
		}
	}

	sources := make([]SessionSource, 0, len(names))
	for _, name := range names {
		reader, err := m.SessionReader(name)
		if err != nil {
			// A directory whose name is not a worktree name cannot have been
			// written by us; it says nothing about the worktrees that are.
			slog.Warn("skipping an unreadable session source", "worktree", name, "error", err)
			continue
		}
		sessions, err := reader.List()
		if err != nil {
			// One unreadable worktree must not hide the sessions another has.
			slog.Warn("could not read a worktree's sessions", "worktree", name, "error", err)
			continue
		}
		if len(sessions) == 0 {
			continue
		}
		sources = append(sources, SessionSource{
			Name:         name,
			Exists:       existing[name],
			SessionCount: len(sessions),
		})
	}

	sort.Slice(sources, func(i, j int) bool { return sources[i].Name < sources[j].Name })
	return sources, nil
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
	processManager := process.NewManager(m.agents, name, workDir, wtDataDir, m.dataDir, sessionStore, m.leaseBudgets)
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
	chatClient.SetBroadcaster(func(sessionID string, record agent.EventRecord, seq session.HistorySeq, exclude any) {
		var n watch.Notifier
		if exclude != nil {
			n = exclude.(watch.Notifier)
		}
		chatMessagesWatcher.NotifyRecord(sessionID, record, seq, n)
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
