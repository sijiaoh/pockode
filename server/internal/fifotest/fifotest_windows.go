package fifotest

import "testing"

// Make skips the test: the hazard it guards against does not exist on Windows.
// Named pipes live under \\.\pipe, not inside a directory, so no path a user
// can name under a work directory ever opens one — and filepath.IsLocal, which
// every such path is checked against, refuses anything anchored elsewhere.
func Make(t *testing.T, dir, name string) {
	t.Helper()

	t.Skip("Windows has no fifo inside a directory; \\\\.\\pipe names cannot appear under a work directory")
}
