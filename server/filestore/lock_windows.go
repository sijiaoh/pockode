//go:build windows

package filestore

import (
	"os"

	"golang.org/x/sys/windows"
)

// allBytes is passed as both the low and the high word of the lock length, so
// the locked range spans the whole 64-bit space. Windows byte-range locks apply
// past EOF, which means that range covers the file whatever its size —
// including the empty lock file created on first use.
const allBytes = ^uint32(0)

func lockFile(f *os.File, exclusive bool) error {
	// LockFileEx without LOCKFILE_FAIL_IMMEDIATELY blocks until granted, and
	// omitting LOCKFILE_EXCLUSIVE_LOCK requests a shared lock — the same two
	// modes flock(2) provides.
	var flags uint32
	if exclusive {
		flags = windows.LOCKFILE_EXCLUSIVE_LOCK
	}
	// An OVERLAPPED is required even for synchronous handles; a zeroed one
	// means "the range starts at offset 0".
	return windows.LockFileEx(windows.Handle(f.Fd()), flags, 0, allBytes, allBytes, new(windows.Overlapped))
}

func unlockFile(f *os.File) error {
	// The unlocked range must match the locked one exactly.
	return windows.UnlockFileEx(windows.Handle(f.Fd()), 0, allBytes, allBytes, new(windows.Overlapped))
}
