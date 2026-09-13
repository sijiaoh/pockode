//go:build !windows

package shutdown

import (
	"fmt"
	"os"
	"syscall"
)

// RequestExit asks the process with the given PID to shut down gracefully.
//
// The PID is rejected unless it is positive: it reaches us from server.json, and
// kill(2) reads 0 as "my own process group", -1 as "every process I am allowed
// to signal", and other negatives as a process group. A corrupted file must not
// be able to turn a request to stop one node into a request that takes the
// cluster down with it.
func RequestExit(pid int) error {
	if pid <= 0 {
		return fmt.Errorf("cannot ask process %d to exit: pid must be positive", pid)
	}

	process, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return process.Signal(syscall.SIGTERM)
}

// requestWatcher has nothing to watch on unix: SIGTERM already reaches a
// process regardless of who its parent is or what terminal it came from.
type requestWatcher struct{}

func watchExitRequests(func()) *requestWatcher { return &requestWatcher{} }

func (w *requestWatcher) stop() {}
