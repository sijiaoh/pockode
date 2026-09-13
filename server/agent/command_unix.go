//go:build !windows

package agent

import "os/exec"

// binaryNotFoundHint adds nothing on POSIX systems: pockode is started from a
// shell and inherits that shell's PATH, so "it is not on PATH" is the whole
// story.
const binaryNotFoundHint = ""

// fallbackBinaryDirs is empty here. Package managers on POSIX systems install
// into directories that are on PATH already, so guessing at further locations
// would not be a fallback — it would be a second, worse PATH.
func fallbackBinaryDirs() []string { return nil }

// prepareCommandLine is a no-op. Arguments are passed to a POSIX process as a
// vector, so nothing re-parses them on the way in and there is nothing to quote.
func prepareCommandLine(cmd *exec.Cmd) error { return nil }
