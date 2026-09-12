//go:build !windows

package proctree

import (
	"errors"
	"os/exec"
	"sync"
	"syscall"
)

// Tree tracks a child and its descendants through a dedicated Unix process
// group, so a single signal reaches all of them.
type Tree struct {
	// treeMu orders Adopt against a Terminate arriving from elsewhere — an
	// exec.Cmd cancellation runs on a watchdog goroutine of its own, and nothing
	// stops the context from being done before the child has been attached.
	treeMu     sync.Mutex
	pgid       int
	terminated bool
}

// New makes cmd the leader of a fresh process group. Must be called before
// cmd.Start. Options are accepted and ignored: the only one there is describes
// a guarantee a process group cannot make (see KillOnClose).
//
// The child would otherwise share the server's own process group, which rules
// out group-wide signalling — killing that group would kill the server too. A
// side effect worth knowing about: a Ctrl+C typed at the terminal that launched
// the server no longer reaches the child directly, which is what we want,
// because the server terminates what it started itself during shutdown.
func New(cmd *exec.Cmd, _ ...Option) *Tree {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setpgid = true
	return &Tree{}
}

// Adopt records the group ID, which Setpgid made equal to the child's PID.
//
// A Terminate that arrived first found no group to signal, so it is carried out
// here instead: the caller has already been told the tree is going away.
func (t *Tree) Adopt(cmd *exec.Cmd) error {
	t.treeMu.Lock()
	defer t.treeMu.Unlock()

	t.pgid = cmd.Process.Pid
	if t.terminated {
		return t.terminateLocked()
	}
	return nil
}

// Terminate signals the whole group.
//
// Safe to call after the child has been reaped: the kernel keeps a process
// group ID reserved while the group still has members, so the PID cannot have
// been recycled into an unrelated group. Once the last member is gone the call
// simply reports ESRCH.
func (t *Tree) Terminate() error {
	t.treeMu.Lock()
	defer t.treeMu.Unlock()

	t.terminated = true
	return t.terminateLocked()
}

func (t *Tree) terminateLocked() error {
	if t.pgid <= 0 {
		return nil
	}
	if err := syscall.Kill(-t.pgid, syscall.SIGKILL); err != nil && !errors.Is(err, syscall.ESRCH) {
		return err
	}
	return nil
}

// Close is a no-op: a process group holds no handle to release.
func (t *Tree) Close() {}
