package git

import (
	"fmt"
	"log/slog"
	"sync"
	"time"
)

// BusyError reports an operation refused because one it shares a lock with is
// already running in the same worktree. Not any other operation: a fetch never
// turns a stage away. Callers turn it into a distinct wire error; see
// rpc.CodeGitBusy.
type BusyError struct {
	// Running is the operation holding the lock that was wanted, named with the
	// vocabulary below. It is the whole point of the error: "busy" alone tells
	// the user nothing about what to wait for.
	Running string
}

func (e *BusyError) Error() string {
	return fmt.Sprintf("another git operation is running in this worktree: %s", e.Running)
}

// need says which of a worktree's locks an operation has to hold, as a set.
type need uint8

const (
	// needIndex is for anything that writes .git/index or the working tree —
	// the things that race for index.lock.
	needIndex need = 1 << iota
	// needRefs is for anything that writes refs, FETCH_HEAD or remote config,
	// which race for their own lock files and for packed-refs.
	needRefs
)

// operation is a git operation the panel can start: the name a client renders
// it by, and what that operation actually writes.
//
// The two travel together so that adding an operation cannot mean adding a name
// without saying what it locks — the mistake would not fail, it would either
// let a real conflict through or block something that never conflicted.
type operation struct {
	// name is a contract: a client renders BusyError from it, so these nine
	// strings are not log text and do not change.
	name  string
	locks need
}

// The nine writing operations, and why each one locks what it does.
//
// Reads take no lock at all; see the note at the bottom of this file.
var (
	// Staging, unstaging and discarding are index and working tree only. None
	// of them names a ref.
	opStage   = operation{"stage", needIndex}
	opUnstage = operation{"unstage", needIndex}
	opDiscard = operation{"discard", needIndex}

	// A commit reads the index and moves the current branch, but it never
	// changes which branch that is, so it does not have to exclude the
	// operations that only read refs. Everything that does move HEAD takes the
	// index lock too, which is what keeps a commit and a checkout apart.
	opCommit = operation{"commit", needIndex}

	// Switching branches rewrites the working tree and moves HEAD, so these
	// take both: splitting the locks must not cost the exclusion between a
	// checkout and a fetch, which write the same refs.
	opCheckout     = operation{"checkout", needIndex | needRefs}
	opBranchCreate = operation{"branch-create", needIndex | needRefs}

	// Fetch writes remote-tracking refs and FETCH_HEAD; push reads refs and may
	// write the branch's upstream into config. Neither goes near the index, so
	// neither may stop the user from staging a file — a fetch of a large
	// repository takes minutes, and git itself allows staging throughout. They
	// still exclude each other: two clients fetching at once collide on
	// FETCH_HEAD.lock, and a client-side guard cannot see the other client.
	opFetch = operation{"fetch", needRefs}
	opPush  = operation{"push", needRefs}

	// Pull is the only network operation that fast-forwards the working tree
	// and the index, so it is the only one that takes both.
	opPull = operation{"pull", needIndex | needRefs}
)

// lockWait is how long an operation waits for a busy worktree before refusing:
// long enough that two fast local operations overlapping is nobody's problem,
// short enough that nothing queues behind a network operation or a hook. The
// reasoning for both halves is in docs/git.md#serialising-writes.
const lockWait = 2 * time.Second

// worktreeLocks holds each worktree's pair of locks, keyed by the directory
// every operation in this package is already given.
//
// The key is that directory rather than the worktree name because this package
// is the narrowest place every git command passes through — the RPC handlers
// are not: two connections reach the same worktree, and worktree setup and the
// watchers run git without going near them. A name would have to be threaded
// down here from a layer that has one, and that is the second identity worth
// avoiding; the directory is derived from the name once, by the registry, and
// is what identifies a worktree to git itself.
//
// Entries are never removed. One is a pointer and a small struct per worktree
// the process has ever touched, and removing one safely would mean knowing that
// nobody is about to take it — a lifecycle this package has no way to observe.
var worktreeLocks sync.Map // dir -> *lockPair

// lockPair is one worktree's two locks, split by what git commands actually
// contend for. Two locks rather than one because the panel is expected to stay
// usable while a sync runs: the staging half of it conflicts with a fetch in no
// way at all.
type lockPair struct {
	index *worktreeLock
	refs  *worktreeLock
}

// worktreeLock admits one operation at a time, remembers which one that is, and
// gives the next caller a deadline instead of an unbounded wait.
type worktreeLock struct {
	// which this lock is ("index" or "refs"), for the log line below — the one
	// place the split is visible while debugging.
	which string

	// free carries the single token that ownership is. A channel rather than a
	// Mutex because the wait has to be able to time out, which Mutex.Lock
	// cannot do, and because goroutines blocked on a receive are handed the
	// token in the order they arrived.
	free chan struct{}

	stateMu sync.Mutex
	running string // what holds the token; empty when free
	// waiting counts the callers queued behind it. Nothing in the lock reads
	// it: it is here so that a test can wait for the state "somebody is queued"
	// rather than assume a schedule (see docs/testing.md).
	waiting int
}

func newWorktreeLock(which string) *worktreeLock {
	l := &worktreeLock{which: which, free: make(chan struct{}, 1)}
	l.free <- struct{}{}
	return l
}

func locksFor(dir string) *lockPair {
	if l, ok := worktreeLocks.Load(dir); ok {
		return l.(*lockPair)
	}
	fresh := &lockPair{index: newWorktreeLock("index"), refs: newWorktreeLock("refs")}
	l, _ := worktreeLocks.LoadOrStore(dir, fresh)
	return l.(*lockPair)
}

// withLock runs fn holding the locks op needs, waiting briefly for one that is
// taken and refusing an op whose locks stay taken. The locks op does not need
// are not looked at, so what it can be refused by is only what it conflicts
// with.
//
// Refusing rather than queueing indefinitely is deliberate; docs/git.md
// #serialising-writes says why, and why the refusal names what is running.
//
// The locks span the whole of fn, not one exec: Discard and Pull each run
// several git commands that must not be interleaved with another operation, and
// execGitNetworkTimeout builds its own root context, so nothing outside this
// function knows when its command has actually stopped.
func withLock(dir string, op operation, fn func() error) error {
	return withLockTimeout(dir, op, lockWait, fn)
}

// withLockTimeout is withLock with the wait spelled out, so a test can exercise
// both sides of the deadline without spending it or racing it.
func withLockTimeout(dir string, op operation, wait time.Duration, fn func() error) error {
	locks := locksFor(dir)

	// The lock order, and the only one there is: index before refs, never the
	// other way. Two locks taken in two orders is a deadlock — here a mutual
	// refusal rather than a hang, since every wait has a deadline, but the
	// panel would turn away both callers for no reason at all. Nothing below
	// takes the index after the refs, so no caller can ever hold one while
	// another holds the other and each wants the second.
	//
	// One deadline covers both acquisitions, so needing two locks cannot cost
	// twice the wait: the promise is that a refused caller waited at most
	// lockWait, whatever it asked for.
	//
	// An operation that needs both does hold the index while it waits for the
	// refs, which is the price of a fixed order. It is bounded by that same
	// deadline, and it cannot push anyone past theirs: a caller that arrives
	// while it waits started its own wait later, so the index comes free before
	// that caller's deadline does.
	deadline := time.Now().Add(wait)

	if op.locks&needIndex != 0 {
		if err := locks.index.acquire(dir, op, time.Until(deadline)); err != nil {
			return err
		}
		// The defer covers the refs failure below as well: a refused caller has
		// to leave nothing taken, or one pull that never ran would go on
		// refusing every stage for as long as it waited.
		defer locks.index.release()
	}
	if op.locks&needRefs != 0 {
		if err := locks.refs.acquire(dir, op, time.Until(deadline)); err != nil {
			return err
		}
		defer locks.refs.release()
	}

	return fn()
}

func (l *worktreeLock) acquire(dir string, op operation, wait time.Duration) error {
	// The uncontended case, which is nearly every case: no timer, and no log
	// line about a wait that did not happen. It also lets an arriving caller
	// take a token that queued callers have not been handed yet, which costs
	// them at most the deadline they are already waiting under.
	select {
	case <-l.free:
		l.take(op.name)
		return nil
	default:
	}

	running := l.currentlyRunning()
	// The only account of a tap that took a visible moment to happen.
	slog.Debug("waiting for a worktree git lock", "dir", dir, "lock", l.which, "op", op.name, "running", running)

	timer := time.NewTimer(wait)
	defer timer.Stop()

	l.addWaiting(1)
	defer l.addWaiting(-1)

	select {
	case <-l.free:
		l.take(op.name)
		return nil
	case <-timer.C:
		// The deadline and the token can be ready together, and select then picks
		// between them at random — so look once more before giving up. The window
		// is not a hair's breadth: the timer fires whether or not this goroutine
		// is scheduled, and the operation ahead is likelier to finish at the end
		// of the wait than anywhere else in it. Refusing a lock that is free
		// would be a refusal nobody caused.
		select {
		case <-l.free:
			l.take(op.name)
			return nil
		default:
		}

		// Named at the moment of the refusal, not when the wait began: whatever
		// turned us away may have finished and handed this lock to something
		// else, and what the user needs is what to wait for now. A lock that
		// went free in the instant we gave up keeps the name we found on the way
		// in — the last true answer there was.
		if current := l.currentlyRunning(); current != "" {
			running = current
		}
		return &BusyError{Running: running}
	}
}

func (l *worktreeLock) take(op string) {
	l.stateMu.Lock()
	defer l.stateMu.Unlock()
	l.running = op
}

func (l *worktreeLock) release() {
	l.stateMu.Lock()
	l.running = ""
	l.stateMu.Unlock()
	l.free <- struct{}{}
}

func (l *worktreeLock) currentlyRunning() string {
	l.stateMu.Lock()
	defer l.stateMu.Unlock()
	return l.running
}

func (l *worktreeLock) addWaiting(delta int) {
	l.stateMu.Lock()
	defer l.stateMu.Unlock()
	l.waiting += delta
}

func (l *worktreeLock) waitingCount() int {
	l.stateMu.Lock()
	defer l.stateMu.Unlock()
	return l.waiting
}

// Reading operations — Status, Log, Diff, Show, Branches, Head — deliberately
// take no lock, and are not a third kind of need above: no read here has to win
// one of git's lock files. The only one that would even want index.lock is a
// status writing back a refreshed stat cache, which git treats as optional and
// skips when it cannot have it. docs/git.md#serialising-writes has the
// argument, and why this is not an RWMutex.
