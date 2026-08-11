//go:build !windows

package agent

import (
	"errors"
	"os/exec"
	"syscall"
)

// processGroup tracks an AI CLI and its descendants through a dedicated Unix
// process group, so a single signal reaches all of them.
type processGroup struct {
	pgid int
}

// newProcessGroup makes cmd the leader of a fresh process group. Must be called
// before cmd.Start.
//
// The CLI would otherwise share the server's own process group, which rules out
// group-wide signalling — killing that group would kill the server too. A side
// effect worth knowing about: a Ctrl+C typed at the terminal that launched the
// server no longer reaches the CLI directly, which is what we want, because the
// server terminates its sessions itself during graceful shutdown.
func newProcessGroup(cmd *exec.Cmd) *processGroup {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setpgid = true
	return &processGroup{}
}

// adopt records the group ID, which Setpgid made equal to the child's PID.
func (g *processGroup) adopt(cmd *exec.Cmd) error {
	g.pgid = cmd.Process.Pid
	return nil
}

// terminate signals the whole group.
//
// Safe to call after the child has been reaped: the kernel keeps a process
// group ID reserved while the group still has members, so the PID cannot have
// been recycled into an unrelated group. Once the last member is gone the call
// simply reports ESRCH.
func (g *processGroup) terminate() error {
	if g.pgid <= 0 {
		return nil
	}
	if err := syscall.Kill(-g.pgid, syscall.SIGKILL); err != nil && !errors.Is(err, syscall.ESRCH) {
		return err
	}
	return nil
}

// close is a no-op: a process group holds no handle to release.
func (g *processGroup) close() {}
