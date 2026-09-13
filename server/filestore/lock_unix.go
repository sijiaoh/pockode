//go:build !windows

package filestore

import (
	"os"
	"syscall"
)

func lockFile(f *os.File, exclusive bool) error {
	how := syscall.LOCK_SH
	if exclusive {
		how = syscall.LOCK_EX
	}
	return flock(f, how)
}

func unlockFile(f *os.File) error {
	return flock(f, syscall.LOCK_UN)
}

// flock retries on EINTR: a blocking flock is not restarted automatically when
// a signal (such as the Go runtime's preemption signal) interrupts the wait.
func flock(f *os.File, how int) error {
	for {
		err := syscall.Flock(int(f.Fd()), how)
		if err != syscall.EINTR {
			return err
		}
	}
}
