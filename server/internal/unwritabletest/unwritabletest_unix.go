//go:build !windows

package unwritabletest

import (
	"os"
	"testing"
)

// Make takes the write bit off dir for the rest of the test, and puts it back
// afterwards so t.TempDir can still clean up.
func Make(t *testing.T, dir string) {
	t.Helper()

	if os.Geteuid() == 0 {
		t.Skip("root bypasses directory permissions")
	}
	if err := os.Chmod(dir, 0500); err != nil {
		t.Fatalf("chmod %s: %v", dir, err)
	}
	t.Cleanup(func() { os.Chmod(dir, 0700) })
}
