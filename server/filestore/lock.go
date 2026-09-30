package filestore

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
)

// fileLock is an advisory lock held on a sidecar ".lock" file.
//
// The lock lives on a sidecar rather than on the index file itself because
// Write replaces the index by renaming a temp file over it: a lock taken on
// the index would be attached to an inode/handle that is no longer the file
// other holders open, and would stop excluding anyone.
type fileLock struct {
	f *os.File
}

// acquireLock opens (creating if needed) the lock file at path and blocks
// until the lock is granted. Shared locks may be held concurrently by any
// number of holders; an exclusive lock excludes every other holder, shared
// or exclusive. Locks are per open file handle, so holders in the same
// process contend with each other exactly as separate processes do.
func acquireLock(path string, exclusive bool) (*fileLock, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0644)
	if err != nil {
		return nil, fmt.Errorf("open lock file: %w", err)
	}

	if err := lockFile(f, exclusive); err != nil {
		f.Close()
		kind := "shared"
		if exclusive {
			kind = "exclusive"
		}
		return nil, fmt.Errorf("acquire %s lock on %s: %w", kind, path, err)
	}

	return &fileLock{f: f}, nil
}

// release unlocks and closes the lock file.
func (l *fileLock) release() {
	// Closing the handle would release the lock on both platforms, but
	// unlocking explicitly keeps an OS-level failure visible instead of
	// silently depending on close-time cleanup.
	if err := unlockFile(l.f); err != nil {
		slog.Error("filestore failed to release lock", "path", l.f.Name(), "error", err)
	}
	if err := l.f.Close(); err != nil {
		slog.Error("filestore failed to close lock file", "path", l.f.Name(), "error", err)
	}
}

// ErrLocked is TryLock finding the lock held by someone else.
var ErrLocked = errors.New("lock is held by another holder")

// TryLock takes an exclusive lock on the file at path, creating it if needed,
// or fails at once with ErrLocked when anyone else holds it — another process,
// or another handle in this one. It is for work that must run once per machine
// and should be refused rather than queued: the OS drops the lock with the
// process, so a holder that crashed never leaves it behind the way a PID file
// would. unlock releases it.
func TryLock(path string) (unlock func(), err error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0644)
	if err != nil {
		return nil, fmt.Errorf("open lock file: %w", err)
	}
	if err := tryLockFile(f); err != nil {
		f.Close()
		if errors.Is(err, errWouldBlock) {
			return nil, ErrLocked
		}
		return nil, fmt.Errorf("acquire exclusive lock on %s: %w", path, err)
	}
	l := &fileLock{f: f}
	return l.release, nil
}
