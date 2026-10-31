//go:build !windows

package node

import (
	"os/exec"
	"testing"
	"time"
)

// TestProcessExists_UnreapedChild covers the nodes of a cluster that restarted
// itself: they are still its children, but the goroutines that waited on them
// did not survive the exec, so one that exits stays a zombie — which signal 0
// alone reports as running.
func TestProcessExists_UnreapedChild(t *testing.T) {
	cmd := exec.Command("sh", "-c", "exit 0")
	if err := cmd.Start(); err != nil {
		t.Fatalf("start: %v", err)
	}
	// Deliberately never waited on.

	deadline := time.Now().Add(5 * time.Second)
	for processExists(cmd.Process.Pid) {
		if time.Now().After(deadline) {
			t.Fatal("an exited, unreaped child is still reported running")
		}
		time.Sleep(20 * time.Millisecond)
	}
}
