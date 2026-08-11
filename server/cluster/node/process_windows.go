//go:build windows

package node

import (
	"log/slog"
	"os/exec"
	"syscall"

	"golang.org/x/sys/windows"
)

// processExists checks if a process with the given PID is running on Windows.
// Uses OpenProcess with PROCESS_QUERY_LIMITED_INFORMATION to check if the process exists.
func processExists(pid int) bool {
	if pid <= 0 {
		return false
	}

	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return false
	}
	windows.CloseHandle(handle)
	return true
}

// setProcessDetached sets process attributes to run detached from parent on Windows.
func setProcessDetached(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP,
	}
}

const (
	// gracefulShutdownTimeoutMs is how long a node gets to exit on its own after
	// receiving Ctrl+Break, matching the Unix SIGTERM grace period.
	gracefulShutdownTimeoutMs = 5000

	// terminateWaitTimeoutMs bounds the wait for a forced termination to
	// complete. TerminateProcess is asynchronous, but a kernel-level kill lands
	// promptly.
	terminateWaitTimeoutMs = 1000
)

// terminateProcess terminates a process on Windows.
// First tries to send a console control event, then TerminateProcess after timeout.
func terminateProcess(pid int) error {
	handle, err := windows.OpenProcess(windows.PROCESS_TERMINATE|windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		// Process might have already exited
		if !processExists(pid) {
			return nil
		}
		return err
	}
	defer windows.CloseHandle(handle)

	// Send Ctrl+Break to the process group for graceful shutdown.
	// This is the closest equivalent to SIGTERM on Windows, but it only works
	// when the target shares a console with us. A cluster started as a Windows
	// service or otherwise detached has no console, and the call then fails
	// outright — there is no graceful shutdown to wait for in that case, so skip
	// the grace period instead of stalling on it for nothing.
	if err := windows.GenerateConsoleCtrlEvent(windows.CTRL_BREAK_EVENT, uint32(pid)); err != nil {
		slog.Info("no console available for graceful shutdown, terminating node directly", "pid", pid, "error", err)
	} else if result, _ := windows.WaitForSingleObject(handle, gracefulShutdownTimeoutMs); result == windows.WAIT_OBJECT_0 {
		return nil
	}

	if err := windows.TerminateProcess(handle, 1); err != nil {
		if !processExists(pid) {
			return nil
		}
		return err
	}

	// Wait for the termination to actually take effect so callers that clean up
	// the node's files afterwards don't race it. Best effort: the kill itself
	// already succeeded, so a wait that times out or fails changes nothing we
	// could report or act on.
	_, _ = windows.WaitForSingleObject(handle, terminateWaitTimeoutMs)
	return nil
}
