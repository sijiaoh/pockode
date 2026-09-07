//go:build windows

package node

import (
	"os/exec"
	"syscall"
	"time"

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

	// Send Ctrl+Break to the process group for graceful shutdown
	// This is the closest equivalent to SIGTERM on Windows
	_ = windows.GenerateConsoleCtrlEvent(windows.CTRL_BREAK_EVENT, uint32(pid))

	// Wait for process to exit (up to 5 seconds)
	result, _ := windows.WaitForSingleObject(handle, 5000)
	if result == windows.WAIT_OBJECT_0 {
		return nil
	}

	// Timeout, force terminate
	if err := windows.TerminateProcess(handle, 1); err != nil {
		if !processExists(pid) {
			return nil
		}
		return err
	}

	// Wait briefly for termination to take effect
	time.Sleep(100 * time.Millisecond)
	return nil
}
