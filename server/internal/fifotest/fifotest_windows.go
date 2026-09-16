package fifotest

import "testing"

// Make skips the test: there is no fifo to put in a directory on Windows. Named
// pipes live in \\.\pipe, which is not a filesystem directory, so nothing this
// helper's (dir, name) can describe exists here.
//
// For a caller whose path is checked with filepath.IsLocal — contents,
// filetransfer — that is the end of it: such a path is anchored under the work
// directory, so it can never name a pipe and the hazard does not arise. A
// caller that opens an absolute path it did not check, as agent/codex does with
// the one an agent hands it, is *not* covered by that argument: \\.\pipe\name
// is nameable there. Its guard is a stat before the open on every platform, so
// it holds by construction rather than by that reasoning — but no test here
// says so, and none can until this helper has a Windows form.
func Make(t *testing.T, dir, name string) {
	t.Helper()

	t.Skip("Windows has no fifo inside a directory; named pipes live in \\\\.\\pipe")
}
