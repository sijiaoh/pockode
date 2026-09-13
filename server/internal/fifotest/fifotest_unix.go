//go:build !windows

package fifotest

import (
	"path/filepath"
	"syscall"
	"testing"
)

// Make creates a fifo called name inside dir. A filesystem that cannot hold one
// (some CI tmpfs mounts) skips the test rather than failing it.
func Make(t *testing.T, dir, name string) {
	t.Helper()

	if err := syscall.Mkfifo(filepath.Join(dir, name), 0644); err != nil {
		t.Skipf("cannot create a fifo here: %v", err)
	}
}
