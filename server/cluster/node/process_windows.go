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
// CREATE_NO_WINDOW is the counterpart of Setsid on the unix side: the node gets
// a console of its own, one with no window, instead of inheriting the cluster's.
// Left on the cluster's console, a node would go the way of that console:
// closing the terminal window the cluster happens to have been started from
// sends CTRL_CLOSE_EVENT to every process on it, and the node goes down with
// it — while the same action on unix leaves the node running. A node is meant
// to outlive the shell that launched its cluster, so it must not be on that
// shell's console in the first place.
//
// The console being there matters as much as it not being the cluster's. A
// process with no console at all — which is what DETACHED_PROCESS, used here
// before, produces — gets a fresh, *visible* console allocated for every console
// program it starts, because such a program with nothing to inherit has one made
// for it. A node starts them constantly: git for every status poll, the shell for
// a worktree hook, and whatever git starts in turn (ssh, a credential helper).
// Each one flashed a black window, continuously, over whatever the user was
// doing. With a hidden console of its own the node has one to hand down, and
// every descendant started without flags of its own inherits it — including an
// exec added later that nobody thought to flag, and the grandchildren no flag of
// ours could reach.
//
// The same holds for a cluster with no console of its own — one run as a service
// or from Task Scheduler — which would otherwise have Windows make the node a
// visible console of its own: CREATE_NO_WINDOW creates one either way, and
// never shows it.
//
// No process group beside it. A process group exists to be addressed by
// GenerateConsoleCtrlEvent, which reaches processes through a shared console;
// the node shares none, so there is no terminal-wide event to keep out. Asking
// the node to exit does not go that way either — see internal/shutdown.
//
// Windows ignores CREATE_NO_WINDOW when it is combined with DETACHED_PROCESS or
// CREATE_NEW_CONSOLE, so neither may be added back here.
func setProcessDetached(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: windows.CREATE_NO_WINDOW,
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
