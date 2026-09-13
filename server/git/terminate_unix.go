//go:build !windows

package git

import (
	"os/exec"
	"syscall"
)

// terminator stops a git command that has run out of time.
//
// Unix has the mechanism this is built around: git installs signal handlers that
// remove its lock files (index.lock, FETCH_HEAD.lock) before exiting, so asking
// it to stop is both prompt and clean. Nothing has to be arranged in advance for
// that, which is why every method but stop is empty here.
type terminator struct{}

func newTerminator(*exec.Cmd) *terminator { return &terminator{} }

func (t *terminator) adopt(*exec.Cmd) error { return nil }

// stop asks git to clean up and exit.
func (t *terminator) stop(cmd *exec.Cmd) error {
	return cmd.Process.Signal(syscall.SIGTERM)
}

func (t *terminator) close() {}
