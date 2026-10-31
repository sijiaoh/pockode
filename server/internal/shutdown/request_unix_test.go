//go:build !windows

package shutdown

import (
	"os"
	"syscall"
	"testing"
	"time"
)

func TestListen_RestartSignal(t *testing.T) {
	for attempt := 1; attempt <= 2; attempt++ {
		l := Listen()

		if err := syscall.Kill(os.Getpid(), syscall.SIGUSR1); err != nil {
			t.Fatalf("attempt %d: kill: %v", attempt, err)
		}
		select {
		case _, ok := <-l.Restarts():
			if !ok {
				t.Fatalf("attempt %d: Restarts closed instead of delivering the request", attempt)
			}
		case <-time.After(notifyTimeout):
			t.Fatalf("attempt %d: restart request was not delivered", attempt)
		}
		select {
		case <-l.Done():
			t.Fatalf("attempt %d: a restart request was reported as an exit request", attempt)
		default:
		}

		l.Stop()
		if _, ok := <-l.Restarts(); ok {
			t.Fatalf("attempt %d: Restarts still open after Stop", attempt)
		}
	}
}

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
