//go:build !windows

package node

import (
	"errors"
	"os"
	"os/exec"
	"syscall"
	"time"
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

// terminateProcess sends SIGTERM first for graceful shutdown, then SIGKILL after timeout.
func terminateProcess(pid int) error {
	process, err := os.FindProcess(pid)
	if err != nil {
		return err
	}

	// Send SIGTERM for graceful shutdown
	if err := process.Signal(syscall.SIGTERM); err != nil {
		// Check if process already exited
		if !processExists(pid) {
			return nil
		}
		return err
	}

	// Wait for process to exit (up to 5 seconds)
	done := make(chan error, 1)
	go func() {
		for i := 0; i < 50; i++ {
			time.Sleep(100 * time.Millisecond)
			if !processExists(pid) {
				done <- nil
				return
			}
		}
		done <- errors.New("timeout")
	}()

	select {
	case err := <-done:
		if err == nil {
			return nil
		}
		// Timeout, send SIGKILL
		if err := process.Signal(syscall.SIGKILL); err != nil {
			if !processExists(pid) {
				return nil
			}
			return err
		}
		// Wait briefly for SIGKILL to take effect
		time.Sleep(100 * time.Millisecond)
	}

	return nil
}
