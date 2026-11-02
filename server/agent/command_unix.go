//go:build !windows

package agent

import (
	"os/exec"
	"path/filepath"
)

// binaryNotFoundHint adds nothing on POSIX systems: pockode is started from a
// shell and inherits that shell's PATH, so "it is not on PATH" is the whole
// story.
const binaryNotFoundHint = ""

// fallbackBinaryDirs is empty here: beyond a CLI's own installer directory
// (RegisterInstallDir), package managers on POSIX systems install into
// directories that are on PATH already, so guessing at further locations would
// not be a fallback — it would be a second, worse PATH.
func fallbackBinaryDirs() []string { return nil }

// isPathKey reports whether an environment key is PATH. POSIX environment
// names are case-sensitive.
func isPathKey(key string) bool { return key == "PATH" }

// prepareCommandLine is a no-op. Arguments are passed to a POSIX process as a
// vector, so nothing re-parses them on the way in and there is nothing to quote.
func prepareCommandLine(cmd *exec.Cmd) error { return nil }

// withPWD returns env with PWD set to dir, as exec itself does for a Cmd whose
// Env is nil: POSIX shells and tools take PWD as the directory they run in.
// The added entry is last, which is the one exec passes on.
func withPWD(env []string, dir string) []string {
	if dir == "" {
		return env
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		return env
	}
	return append(env[:len(env):len(env)], "PWD="+abs)
}
