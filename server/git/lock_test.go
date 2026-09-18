package git

import (
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/pockode/server/internal/githooktest"
)

// blockedCommit starts a commit that stops inside its pre-commit hook and stays
// there. It returns once the git command is provably in flight, with the
// function that lets it finish and a channel carrying the commit's own result.
func blockedCommit(t *testing.T, dir string) (release func(), done <-chan error) {
	t.Helper()

	hook := githooktest.Block(t, dir)
	writeTestFile(t, dir, "file.txt", "committed while locked\n")
	runGit(t, dir, "add", "file.txt")

	result := make(chan error, 1)
	go func() { result <- CreateCommit(dir, "Blocked on its hook", false) }()

	hook.WaitStarted(t)

	return func() { hook.Release(t) }, result
}

// The whole point of the lock: an operation that holds the worktree for longer
// than lockWait has the next one refused, rather than racing it for index.lock.
func TestBusy_RefusesASecondOperationWhileOneIsRunning(t *testing.T) {
	dir, cleanup := setupCommitRepo(t)
	defer cleanup()

	release, done := blockedCommit(t, dir)

	writeTestFile(t, dir, "other.txt", "unstaged\n")
	err := Add(dir, "other.txt")

	var busy *BusyError
	if !errors.As(err, &busy) {
		t.Fatalf("Add() during a commit: error = %v, want a *BusyError", err)
	}
	if busy.Running != opCommit.name {
		t.Errorf("BusyError.Running = %q, want %q", busy.Running, opCommit.name)
	}

	release()
	if err := <-done; err != nil {
		t.Fatalf("the blocked CreateCommit() failed: %v", err)
	}

	// And the worktree is free again afterwards, including after the refusal —
	// a refused caller must not have consumed anything.
	if err := Add(dir, "other.txt"); err != nil {
		t.Errorf("Add() after the commit finished: %v", err)
	}
}

// The other side of the deadline: an operation that only has to wait a moment
// waits, rather than handing the user an error for two taps in a row. The panel
// issues staging requests without serialising them, so two fast local
// operations overlapping is routine and must not be reported as a conflict.
func TestLock_WaitsForAnOperationThatEndsQuickly(t *testing.T) {
	dir := t.TempDir()

	release := holdLock(t, dir, opCommit)

	// The wait is far longer than this test can take, so a loaded machine
	// cannot turn "queued" into "refused" — the deadline is exercised by the
	// test above, not by this one.
	second := make(chan error, 1)
	go func() {
		second <- withLockTimeout(dir, opStage, time.Minute, func() error { return nil })
	}()
	waitForWaiter(t, locksFor(dir).index)

	release()
	if err := <-second; err != nil {
		t.Errorf("an operation queued behind a short one: %v", err)
	}
}

// holdLock starts op and keeps it holding whatever locks it needs until the
// returned function is called, which then waits for it to finish. It returns
// once the operation provably holds them.
//
// The locks are driven directly rather than through a git command: what these
// tests are about is which locks an operation takes, not what it does while it
// holds them, and blocking inside the operation is what makes "it is holding
// them now" a state to wait for instead of a guess. A fetch could not be held
// open from the outside anyway — that would take a remote that stalls.
func holdLock(t *testing.T, dir string, op operation) (release func()) {
	t.Helper()

	holding := make(chan struct{})
	finish := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- withLock(dir, op, func() error {
			close(holding)
			<-finish
			return nil
		})
	}()

	select {
	case <-holding:
	case err := <-done:
		t.Fatalf("%s never took the worktree: %v", op.name, err)
	}

	var once sync.Once
	return func() {
		once.Do(func() {
			close(finish)
			if err := <-done; err != nil {
				t.Errorf("the holding %s failed: %v", op.name, err)
			}
		})
	}
}

// waitForWaiter blocks until somebody is queued on the given lock. It waits for
// that state rather than for a duration: the point of the tests that use it is
// that a caller which is provably waiting gets the answer under test.
func waitForWaiter(t *testing.T, l *worktreeLock) {
	t.Helper()

	deadline := time.Now().Add(30 * time.Second)
	for l.waitingCount() == 0 {
		if time.Now().After(deadline) {
			t.Fatal("nobody ever queued on the lock")
		}
		time.Sleep(time.Millisecond)
	}
}

// Reads are not part of the mutual exclusion: the panel has to keep refreshing
// while a long operation runs.
func TestBusy_ReadsAreNotBlocked(t *testing.T) {
	dir, cleanup := setupCommitRepo(t)
	defer cleanup()

	release, done := blockedCommit(t, dir)
	defer func() {
		release()
		<-done
	}()

	if _, err := Status(dir); err != nil {
		t.Errorf("Status() during a commit: %v", err)
	}
	if _, err := Log(dir, 10); err != nil {
		t.Errorf("Log() during a commit: %v", err)
	}
	if _, err := Branches(dir); err != nil {
		t.Errorf("Branches() during a commit: %v", err)
	}
}

// One worktree's operation says nothing about another's: the lock is per
// worktree, not per process.
func TestBusy_IsPerWorktree(t *testing.T) {
	busyDir, cleanupBusy := setupCommitRepo(t)
	defer cleanupBusy()
	otherDir, cleanupOther := setupCommitRepo(t)
	defer cleanupOther()

	release, done := blockedCommit(t, busyDir)
	defer func() {
		release()
		<-done
	}()

	writeTestFile(t, otherDir, "other.txt", "unrelated\n")
	if err := Add(otherDir, "other.txt"); err != nil {
		t.Errorf("Add() in an unrelated worktree: %v", err)
	}
}

// The converse, and the one that fails quietly: one worktree reached by two
// spellings is still one worktree. A lock keyed by the raw path lets both
// operations through, and only where the spellings differ — so on Linux this
// needs the symlink below, while macOS (/var) and Windows (8.3 paths) hit it
// with nothing but a temporary directory.
func TestBusy_IsPerWorktreeNotPerSpelling(t *testing.T) {
	dir, cleanup := setupCommitRepo(t)
	defer cleanup()

	alias := filepath.Join(t.TempDir(), "alias")
	if err := os.Symlink(dir, alias); err != nil {
		// Windows grants symlink creation by privilege, and the spelling that
		// differs there is a short path rather than a link.
		t.Skipf("cannot symlink this worktree: %v", err)
	}

	release, done := blockedCommit(t, dir)
	defer func() {
		release()
		if err := <-done; err != nil {
			t.Errorf("the blocked commit failed: %v", err)
		}
	}()

	writeTestFile(t, dir, "staged.txt", "staged through the alias\n")
	var busy *BusyError
	if err := Add(alias, "staged.txt"); !errors.As(err, &busy) {
		t.Fatalf("Add() through a symlinked path during a commit: error = %v, want a *BusyError", err)
	}
}

// A staging request is one operation, not one per path: nothing may commit half
// of what the user asked to stage.
func TestStagingHoldsTheLockForTheWholeRequest(t *testing.T) {
	dir, cleanup := setupCommitRepo(t)
	defer cleanup()

	writeTestFile(t, dir, "a.txt", "a\n")
	writeTestFile(t, dir, "b.txt", "b\n")
	if err := Add(dir, "a.txt", "b.txt"); err != nil {
		t.Fatalf("Add() error: %v", err)
	}

	status, err := Status(dir)
	if err != nil {
		t.Fatalf("Status() error: %v", err)
	}
	if len(status.Staged) != 2 {
		t.Errorf("staged %v, want both files", status.Staged)
	}

	if err := Reset(dir, "a.txt", "b.txt"); err != nil {
		t.Fatalf("Reset() error: %v", err)
	}
	if status, err = Status(dir); err != nil {
		t.Fatalf("Status() error: %v", err)
	}
	if len(status.Staged) != 0 {
		t.Errorf("staged %v after unstaging both", status.Staged)
	}
}

// A failure inside the operation still frees the worktree; otherwise one
// rejected push would leave the panel refusing everything forever.
func TestLockIsReleasedAfterAFailedOperation(t *testing.T) {
	dir, cleanup := setupCommitRepo(t)
	defer cleanup()

	if err := CreateCommit(dir, "nothing is staged", false); err == nil {
		t.Fatal("CreateCommit() with an empty index succeeded, so nothing failed here")
	}

	writeTestFile(t, dir, "file.txt", "changed\n")
	if err := Add(dir, "file.txt"); err != nil {
		t.Errorf("Add() after a failed commit: %v", err)
	}
}

// The lock split, stated as the table it is: an operation may only be turned
// away by one it genuinely conflicts with. The entries that pass are the point
// of having two locks — git itself lets you stage a file while a fetch runs,
// and a fetch of a large repository takes minutes.
func TestLock_OperationsExcludeOnlyWhatTheyShare(t *testing.T) {
	cases := []struct {
		holder    operation
		contender operation
		refused   bool
	}{
		// Neither fetch nor push opens the index, so neither may stop the
		// panel's local work.
		{opFetch, opStage, false},
		{opFetch, opUnstage, false},
		{opFetch, opDiscard, false},
		{opFetch, opCommit, false},
		{opPush, opStage, false},
		{opStage, opFetch, false},
		{opCommit, opPush, false},

		// Two writers of the same refs still collide — FETCH_HEAD.lock is real,
		// and a guard in one client cannot see the other one.
		{opFetch, opPush, true},
		{opFetch, opFetch, true},
		{opFetch, opPull, true},
		{opFetch, opCheckout, true},
		{opPush, opBranchCreate, true},

		// And the index is still one at a time.
		{opCommit, opStage, true},
		{opStage, opDiscard, true},
		{opCheckout, opStage, true},
		{opPull, opStage, true},
		{opStage, opPull, true},
	}

	for _, tc := range cases {
		t.Run(tc.holder.name+"_then_"+tc.contender.name, func(t *testing.T) {
			dir := t.TempDir()

			release := holdLock(t, dir, tc.holder)
			defer release()

			// The holder provably holds, so the outcome does not depend on how
			// long this waits: a conflicting contender is refused however long
			// it waits, and a compatible one takes a free lock without waiting
			// at all.
			err := withLockTimeout(dir, tc.contender, time.Millisecond, func() error { return nil })

			if !tc.refused {
				if err != nil {
					t.Fatalf("%s during a %s: %v, want it to go through", tc.contender.name, tc.holder.name, err)
				}
				return
			}

			var busy *BusyError
			if !errors.As(err, &busy) {
				t.Fatalf("%s during a %s: error = %v, want a *BusyError", tc.contender.name, tc.holder.name, err)
			}
			if busy.Running != tc.holder.name {
				t.Errorf("BusyError.Running = %q, want %q", busy.Running, tc.holder.name)
			}
		})
	}
}

// The lock order, tested by its consequence rather than by reading it: an
// operation that needs both locks and is waiting for the index must not already
// be sitting on the refs. Taking them the other way round is the deadlock the
// order exists to prevent — here it would show up as a fetch refused on behalf
// of a pull that has not started either.
func TestLock_AnOperationWaitingForTheIndexHoldsNoRefs(t *testing.T) {
	dir := t.TempDir()

	releaseStage := holdLock(t, dir, opStage)
	defer releaseStage()

	// Long enough that the pull is still waiting when the fetch below runs; the
	// deadline is not what this test is about.
	pull := make(chan error, 1)
	go func() {
		pull <- withLockTimeout(dir, opPull, time.Minute, func() error { return nil })
	}()
	waitForWaiter(t, locksFor(dir).index)

	if err := withLockTimeout(dir, opFetch, time.Millisecond, func() error { return nil }); err != nil {
		t.Errorf("fetch while a pull waits for the index: %v, want it to go through", err)
	}

	releaseStage()
	if err := <-pull; err != nil {
		t.Errorf("the waiting pull: %v", err)
	}
}

// A refused operation that needs both locks leaves neither taken: the next
// caller must not be turned away on behalf of one that never ran.
func TestLock_ARefusedOperationLeavesBothLocksFree(t *testing.T) {
	dir := t.TempDir()

	release := holdLock(t, dir, opFetch)

	var busy *BusyError
	err := withLockTimeout(dir, opPull, time.Millisecond, func() error { return nil })
	if !errors.As(err, &busy) {
		t.Fatalf("pull during a fetch: error = %v, want a *BusyError", err)
	}

	// The index is the one the refused pull took first and had to give back.
	if err := withLockTimeout(dir, opStage, time.Millisecond, func() error { return nil }); err != nil {
		t.Errorf("stage after a refused pull: %v", err)
	}

	release()
	if err := withLockTimeout(dir, opPull, time.Millisecond, func() error { return nil }); err != nil {
		t.Errorf("pull after the fetch finished: %v", err)
	}
}

// The regression the split exists for, through the real staging command: a
// fetch writes remote-tracking refs and FETCH_HEAD and never opens the index,
// so the panel keeps working while one runs.
func TestBusy_AFetchDoesNotBlockStaging(t *testing.T) {
	dir, cleanup := setupCommitRepo(t)
	defer cleanup()

	release := holdLock(t, dir, opFetch)
	defer release()

	writeTestFile(t, dir, "file.txt", "staged during a fetch\n")
	if err := Add(dir, "file.txt"); err != nil {
		t.Fatalf("Add() during a fetch: %v", err)
	}

	status, err := Status(dir)
	if err != nil {
		t.Fatalf("Status() error: %v", err)
	}
	if len(status.Staged) != 1 {
		t.Errorf("staged %v, want the file staged during the fetch", status.Staged)
	}
}
