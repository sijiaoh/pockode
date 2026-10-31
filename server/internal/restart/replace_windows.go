//go:build windows

package restart

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"syscall"

	"golang.org/x/sys/windows"

	"github.com/pockode/server/internal/shutdown"
)

// KeepsPID: Windows has no exec, so the successor has a PID of its own.
const KeepsPID = false

// replace starts the program as a successor process, since Windows has no exec.
//
// What the old process does next depends on whether a person is waiting on it:
//
//   - In a terminal (its standard input is a console), the shell that started
//     it is waiting for it to exit, and would hand the prompt back the moment it
//     did — while the successor goes on writing to the same window. So the old
//     process stays, waits for the successor, and exits with its exit code. It
//     is no longer a server by then: everything was shut down before replace
//     was called. The successor shares the console, so Ctrl+C reaches it, and
//     the old process holds Ctrl+C (and Ctrl+Break) itself rather than letting
//     one end it early.
//   - Anywhere else — a node a cluster started, a service, Task Scheduler —
//     nothing is waiting, and an old process that stayed would be one more
//     process left behind on every restart, each holding the old executable
//     open so the next upgrade cannot replace it. It exits at once.
//
// The successor's console follows the rule cluster/node/process_windows.go
// sets out: sharing ours where there is a terminal to share, and otherwise
// CREATE_NO_WINDOW — a console of its own that is never shown, which its own
// children (git, hook shells) inherit instead of each flashing a window, and
// which a process that has no console at all (a service) would otherwise have
// made visible for it. Never DETACHED_PROCESS or CREATE_NEW_CONSOLE: Windows
// ignores CREATE_NO_WINDOW beside either.
//
// The PID changes; the successor publishes its own in server.json, which is how
// a cluster finds a node.
func replace(p Program, env []string, log *slog.Logger) (int, error) {
	foreground := hasInteractiveConsole()

	cmd := exec.Command(p.Path, p.Args...)
	cmd.Dir = p.Dir
	cmd.Env = env
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if !foreground {
		cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NO_WINDOW}
	}

	if foreground {
		// Before the successor starts, so that there is no moment in which a
		// Ctrl+C meant for it ends this process.
		shutdown.HoldInterrupts()
	}

	if err := cmd.Start(); err != nil {
		return 0, fmt.Errorf("start %s: %w", p.Path, err)
	}
	log.Info("successor started", "pid", cmd.Process.Pid, "waiting", foreground)

	if !foreground {
		if err := cmd.Process.Release(); err != nil {
			log.Warn("failed to release successor process handle", "error", err)
		}
		return 0, nil
	}

	err := cmd.Wait()
	var exitErr *exec.ExitError
	switch {
	case err == nil:
		return 0, nil
	case errors.As(err, &exitErr):
		return exitErr.ExitCode(), nil
	default:
		return 0, fmt.Errorf("wait for successor: %w", err)
	}
}

// hasInteractiveConsole reports whether standard input is a console — that is,
// whether this process was started from a terminal someone is typing into. A
// node a cluster started has NUL there, and a service has nothing at all.
func hasInteractiveConsole() bool {
	stdin, err := windows.GetStdHandle(windows.STD_INPUT_HANDLE)
	if err != nil || stdin == 0 || stdin == windows.InvalidHandle {
		return false
	}
	var mode uint32
	return windows.GetConsoleMode(stdin, &mode) == nil
}

// hideWindow keeps a short-lived child off the screen: CREATE_NO_WINDOW gives
// it a console of its own that is never shown, where a process with no console
// would otherwise have one made, visibly, for every console program it runs.
// The child's output is read through pipes, so nothing was going to reach a
// console anyway.
func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NO_WINDOW}
}
