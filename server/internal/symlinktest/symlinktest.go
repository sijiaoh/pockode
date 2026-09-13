// Package symlinktest creates the symlink a test needs, or skips the test when
// the platform will not make one.
//
// Creating a symlink is a privileged operation on Windows unless Developer Mode
// is on, so whether it works is a property of the machine rather than of the
// code under test. Deciding that inline turns every such test into a coin flip
// between a skip and a failure depending on who wrote it; this says it once.
package symlinktest

import (
	"os"
	"testing"
)

// Make creates a symlink at linkPath pointing at target, skipping the test if
// the OS refuses.
func Make(t *testing.T, target, linkPath string) {
	t.Helper()

	if err := os.Symlink(target, linkPath); err != nil {
		t.Skipf("cannot create a symlink here: %v", err)
	}
}
