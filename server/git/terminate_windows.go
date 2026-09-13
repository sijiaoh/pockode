//go:build windows

package git

import (
	"errors"
	"os"
	"os/exec"

	"github.com/pockode/server/internal/proctree"
)

// terminator stops a git command that has run out of time.
//
// Windows has no way to ask git to stop. Process.Signal fails for anything but
// Kill, and the documented stand-in, GenerateConsoleCtrlEvent, does not do the
// job either: it only reaches processes sharing the *caller's* console, which a
// server run as a service, from Task Scheduler, or as a detached cluster node
// does not have — and the event it can aim at a process group, CTRL_BREAK,
// arrives as SIGBREAK, which git installs no lock-file cleanup handler for. So
// a kill is the honest outcome here, and a lock file git had no chance to remove
// may survive it. Nothing available on this platform would prevent that.
//
// What is worth doing is killing the whole tree rather than git alone. A network
// git is a parent — git-remote-https, ssh, a credential helper — and those
// inherit the stderr pipe this package collects from, so leaving them alive
// would stall Wait until WaitDelay regardless. The tree kill is what makes the
// deadline prompt.
type terminator struct {
	tree *proctree.Tree
}

// Without proctree.KillOnClose, deliberately: close here runs after every
// command, including the ones that finished normally, and a network git may have
// started a credential daemon meant to serve the next command too. Unix leaves
// such a process alone, and there is no reason for this platform not to.
func newTerminator(cmd *exec.Cmd) *terminator {
	return &terminator{tree: proctree.New(cmd)}
}

func (t *terminator) adopt(cmd *exec.Cmd) error { return t.tree.Adopt(cmd) }

func (t *terminator) stop(cmd *exec.Cmd) error {
	err := t.tree.Terminate()
	if err == nil {
		return nil
	}
	if !errors.Is(err, proctree.ErrUnavailable) {
		return err
	}
	// Tree setup failed. Killing git alone still honours the deadline; the
	// helpers it started may outlive it, and holding the stderr pipe is how they
	// would make themselves known.
	if err := cmd.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
		return err
	}
	return nil
}

func (t *terminator) close() { t.tree.Close() }
