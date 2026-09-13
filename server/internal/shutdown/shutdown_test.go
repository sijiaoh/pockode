package shutdown

import (
	"os"
	"testing"
	"time"
)

const notifyTimeout = 5 * time.Second

// TestListen_RequestExit covers the whole round trip on every platform: SIGTERM
// on unix, and on Windows the named event that a parent without a console has
// to fall back on.
func TestListen_RequestExit(t *testing.T) {
	l := Listen()
	defer l.Stop()

	if err := RequestExit(os.Getpid()); err != nil {
		t.Fatalf("RequestExit: %v", err)
	}

	select {
	case <-l.Done():
	case <-time.After(notifyTimeout):
		t.Fatal("Done was not closed after RequestExit")
	}
}

// TestListen_AfterStop checks that a listener gives back what it took. On
// Windows the request channel is a named kernel object, so a leaked handle
// would keep the name taken and leave the next listener unreachable.
func TestListen_AfterStop(t *testing.T) {
	for attempt := 1; attempt <= 2; attempt++ {
		l := Listen()

		if err := RequestExit(os.Getpid()); err != nil {
			t.Fatalf("attempt %d: RequestExit: %v", attempt, err)
		}
		select {
		case <-l.Done():
		case <-time.After(notifyTimeout):
			t.Fatalf("attempt %d: Done was not closed after RequestExit", attempt)
		}

		l.Stop()
	}
}

// TestRequestExit_RejectsNonPositivePID guards a foot-gun rather than a corner
// case: both platforms read a non-positive PID as a whole group of processes —
// the caller's own process group on unix, everything sharing the caller's
// console on Windows — so a corrupted server.json could otherwise turn a request
// to stop one node into one that takes the cluster down with it.
//
// Only an early return satisfies this. Drop the guard and RequestExit(0) reaches
// GenerateConsoleCtrlEvent, which happily breaks the console it is called from —
// on Windows this test would then take the run down with it, which is the point.
func TestRequestExit_RejectsNonPositivePID(t *testing.T) {
	for _, pid := range []int{0, -1, -1234} {
		if err := RequestExit(pid); err == nil {
			t.Errorf("RequestExit(%d) = nil, want an error", pid)
		}
	}
}

func TestListen_StopWithoutRequest(t *testing.T) {
	l := Listen()
	l.Stop()
	l.Stop() // Idempotent: the shutdown path stops it, and defers stop it again.

	select {
	case <-l.Done():
		t.Error("Done was closed without a shutdown request")
	default:
	}
}
