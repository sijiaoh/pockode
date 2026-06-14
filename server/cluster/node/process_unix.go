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
func setProcessDetached(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Setpgid: true,
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
