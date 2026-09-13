//go:build windows

package node

import (
	"fmt"
	"log/slog"
	"os/exec"
	"syscall"

	"golang.org/x/sys/windows"

	"github.com/pockode/server/internal/shutdown"
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
//
// DETACHED_PROCESS is the counterpart of Setsid on the unix side: the node is
// given no console at all instead of inheriting the cluster's. Without it,
// closing the terminal window the cluster happens to have been started from
// sends CTRL_CLOSE_EVENT to every process on that console, and the node goes
// down with it — while the same action on unix leaves the node running. A node
// is meant to outlive the shell that launched its cluster, so it must not be on
// that shell's console in the first place.
//
// It also settles the opposite case. A cluster with no console of its own — one
// run as a service or from Task Scheduler — used to have Windows allocate a
// fresh, *visible* console for each node it started, since a console program
// with nothing to inherit gets one made for it. Asking for none is what stops
// that too.
//
// It replaces CREATE_NEW_PROCESS_GROUP rather than joining it. A process group
// exists to be addressed by GenerateConsoleCtrlEvent, which reaches processes
// through a shared console; with no console there is no terminal-wide event to
// keep out, and no group for one to be aimed at. Asking the node to exit does
// not go that way either — see internal/shutdown.
func setProcessDetached(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: windows.DETACHED_PROCESS,
	}
}

const (
	// gracefulShutdownTimeoutMs is how long a node gets to exit on its own after
	// being asked to, matching the Unix SIGTERM grace period.
	gracefulShutdownTimeoutMs = 5000

	// forcedExitTimeoutMs bounds the wait for a forced termination to complete.
	// TerminateProcess is asynchronous, but a kernel-level kill lands promptly.
	forcedExitTimeoutMs = 1000
)

// terminateProcess asks the process to exit, then kills it if it will not.
//
// It returns nil only once the process is confirmed gone, so callers can clean
// up the files it left behind without racing it. The wait is on a handle we
// hold rather than on the PID, which stays accurate even once the PID itself
// has been recycled.
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

	// shutdown.RequestExit is the Windows stand-in for SIGTERM; see
	// internal/shutdown for why it is a named event rather than a console
	// control event.
	if err := shutdown.RequestExit(pid); err != nil {
		slog.Info("could not ask node to shut down, terminating it directly", "pid", pid, "error", err)
	} else if waitForExit(handle, gracefulShutdownTimeoutMs) {
		return nil
	}

	if err := windows.TerminateProcess(handle, 1); err != nil {
		// The handle held here keeps the PID valid, so processExists cannot say
		// whether the process is already gone. The process object can.
		if waitForExit(handle, 0) {
			return nil
		}
		return err
	}

	if !waitForExit(handle, forcedExitTimeoutMs) {
		return fmt.Errorf("process %d still running after TerminateProcess", pid)
	}
	return nil
}

// waitForExit reports whether the process exited within the timeout.
func waitForExit(handle windows.Handle, timeoutMs uint32) bool {
	result, err := windows.WaitForSingleObject(handle, timeoutMs)
	if err != nil {
		slog.Error("failed to wait for process to exit", "error", err)
		return false
	}
	return result == windows.WAIT_OBJECT_0
}
