// Package githooktest holds a git operation open for as long as a test needs
// it, by installing a pre-commit hook that waits for a signal.
//
// It exists because "one operation is running right now" is the precondition of
// every test about per-worktree git mutual exclusion (git.BusyError and the
// wire error the ws handlers build from it), and the only honest way to reach
// it is to have a real git command genuinely in flight. A hook is what makes
// that deterministic: the test waits for a file the hook writes rather than for
// a duration, so nothing here decides a pass by winning a race.
//
// A commit specifically, because it is the operation whose duration is already
// the user's to control — hooks are why commit is as unbounded as a fetch.
package githooktest

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// startTimeout is how long a hook has to get going before the test gives up. It
// is a backstop for a hook that never ran at all, not a budget the test is
// meant to spend, so it is far above any plausible process start.
const startTimeout = 30 * time.Second

// Hook is an installed pre-commit hook that blocks until Release.
type Hook struct {
	started string
	proceed string
}

// Block installs the hook in the repository at dir. The caller then starts the
// commit — this package does not, so that the package under test is the one
// calling git.
func Block(t *testing.T, dir string) *Hook {
	t.Helper()

	signals := t.TempDir()
	h := &Hook{
		started: filepath.Join(signals, "started"),
		proceed: filepath.Join(signals, "proceed"),
	}

	// Forward slashes: the hook runs under sh, where a backslash escapes. This
	// is also why the paths are written into the script rather than passed in
	// the environment — git inherits the test process's, which the test would
	// then be mutating for everything else running in it.
	script := fmt.Sprintf("#!/bin/sh\n: > %q\nwhile [ ! -f %q ]; do sleep 0.05; done\n",
		filepath.ToSlash(h.started), filepath.ToSlash(h.proceed))
	path := filepath.Join(dir, ".git", "hooks", "pre-commit")
	if err := os.WriteFile(path, []byte(script), 0755); err != nil {
		t.Fatalf("failed to write pre-commit hook: %v", err)
	}
	return h
}

// WaitStarted returns once the commit is provably inside the hook, i.e. once
// git is running and holding whatever the commit holds.
func (h *Hook) WaitStarted(t *testing.T) {
	t.Helper()

	deadline := time.Now().Add(startTimeout)
	for {
		if _, err := os.Stat(h.started); err == nil {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("the pre-commit hook never ran")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// Release lets the hook finish, and with it the commit.
func (h *Hook) Release(t *testing.T) {
	t.Helper()

	if err := os.WriteFile(h.proceed, nil, 0600); err != nil {
		t.Errorf("failed to release the hook: %v", err)
	}
}
