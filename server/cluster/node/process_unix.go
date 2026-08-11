//go:build !windows

package node

import (
	"fmt"
	"os"
	"os/exec"
	"syscall"
	"time"

	"github.com/pockode/server/internal/shutdown"
)

const (
	// gracefulShutdownTimeout is how long a node gets to exit on its own after
	// being asked to.
	gracefulShutdownTimeout = 5 * time.Second

	// forcedExitTimeout bounds the wait for SIGKILL to take effect.
	forcedExitTimeout = 1 * time.Second

	exitPollInterval = 100 * time.Millisecond
)

// processExists checks if a process with the given PID is running on Unix systems.
// Uses signal 0 which doesn't actually send a signal but checks if the process exists.
func processExists(pid int) bool {
	if pid <= 0 {
		return false
	}
	process, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	// Signal 0 checks if the process exists without sending an actual signal
	err = process.Signal(syscall.Signal(0))
	return err == nil
}

// setProcessDetached sets process attributes to run detached from parent on Unix.
//
// Setsid (not just Setpgid) is required: it puts the node in a brand-new session
// with NO controlling terminal. When cluster mode is launched from a terminal,
// Setpgid alone would leave the node in a background process group that still
// shares the cluster's controlling terminal. The AI CLI the node spawns (and the
// external commands it runs) would then touch that terminal, and the kernel would
// deliver SIGTTOU/SIGTTIN to the node's process group, suspending/killing the
// node. Detaching into its own session is the correct daemon behavior and avoids
// terminal job-control signals entirely.
func setProcessDetached(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Setsid: true,
	}
}

// terminateProcess asks the process to exit, then SIGKILLs it if it will not.
//
// It returns nil only once the process is confirmed gone, so callers can clean
// up the files it left behind without racing it.
func terminateProcess(pid int) error {
	if err := shutdown.RequestExit(pid); err != nil {
		// The process may simply have exited on its own in the meantime.
		if !processExists(pid) {
			return nil
		}
		return err
	}

	if waitForExit(pid, gracefulShutdownTimeout) {
		return nil
	}

	process, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	if err := process.Signal(syscall.SIGKILL); err != nil {
		if !processExists(pid) {
			return nil
		}
		return err
	}

	if !waitForExit(pid, forcedExitTimeout) {
		return fmt.Errorf("process %d still running after SIGKILL", pid)
	}
	return nil
}

// waitForExit polls until the process is gone, reporting whether it made it
// within the timeout.
func waitForExit(pid int, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for {
		if !processExists(pid) {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(exitPollInterval)
	}
}
