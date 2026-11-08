//go:build !windows

package shutdown

import (
	"os"
	"syscall"
	"testing"
	"time"
)

// TestListen_RestartSignalAfterStop guards the shutdown a restart starts: the
// default action of SIGUSR1 is to terminate, so a second request arriving
// while the process is shutting down must not be handed back to it. If it were,
// this test binary would die here.
func TestListen_RestartSignalAfterStop(t *testing.T) {
	l := Listen()
	l.Stop()

	if err := syscall.Kill(os.Getpid(), syscall.SIGUSR1); err != nil {
		t.Fatalf("kill: %v", err)
	}
	// Give an unhandled signal time to do its damage.
	time.Sleep(100 * time.Millisecond)
}
