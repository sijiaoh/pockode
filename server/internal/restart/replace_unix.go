//go:build !windows

package restart

import (
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"syscall"
)

// KeepsPID: exec replaces the program and keeps the process. Whatever names
// this process by PID — server.json — is still right afterwards.
const KeepsPID = true

// replace execs the program in place of this process. It returns only on
// failure.
//
// exec keeps everything a restart must not change: the PID, which is how a
// cluster finds a node (its server.json); the session, so a node stays
// detached from every terminal and one started in a terminal stays on it; and
// the parent, so a shell or a supervisor waiting on this process goes on
// waiting on the new one.
func replace(p Program, env []string, _ *slog.Logger) (int, error) {
	if err := os.Chdir(p.Dir); err != nil {
		return 0, fmt.Errorf("enter working directory %s: %w", p.Dir, err)
	}
	argv := append([]string{p.argv0}, p.Args...)
	return 0, fmt.Errorf("exec %s: %w", p.Path, syscall.Exec(p.Path, argv, env))
}

// hideWindow has nothing to hide on unix.
func hideWindow(*exec.Cmd) {}
