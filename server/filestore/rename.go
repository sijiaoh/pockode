package filestore

import (
	"os"
	"time"
)

// Windows can transiently refuse to replace a file that someone else still has
// open (an antivirus scanner, a search indexer, an editor). The failure is not
// prevented by our own lock, because those openers do not take it. Retrying for
// a short while turns a spurious write error into a small delay.
//
// On unix isRetryableRenameError always reports false, so the loop collapses to
// a single os.Rename.
const (
	renameAttempts   = 10
	renameRetryDelay = 20 * time.Millisecond
)

// Rename renames oldpath to newpath, replacing newpath if it exists, and
// retries while the failure looks like transient sharing contention. For a
// caller that writes its own temp file and renames it into place, as
// WriteFileAtomic does.
func Rename(oldpath, newpath string) error {
	for attempt := 1; ; attempt++ {
		err := os.Rename(oldpath, newpath)
		if err == nil || attempt == renameAttempts || !isRetryableRenameError(err) {
			return err
		}
		time.Sleep(renameRetryDelay)
	}
}

// Patient renames back off from patientRenameFirstDelay, doubling up to
// patientRenameMaxDelay between attempts.
const (
	patientRenameFirstDelay = 50 * time.Millisecond
	patientRenameMaxDelay   = time.Second
)

// RenamePatiently is Rename for a file that is expected to be held for longer
// than Rename waits: an executable just written, which Windows Defender opens
// to scan for seconds rather than milliseconds. It retries the same failures
// as Rename, backing off, until budget has passed, and then returns the last
// error. On unix it is a single os.Rename, as Rename is.
func RenamePatiently(oldpath, newpath string, budget time.Duration) error {
	deadline := time.Now().Add(budget)
	delay := patientRenameFirstDelay
	for {
		err := os.Rename(oldpath, newpath)
		if err == nil || !isRetryableRenameError(err) || time.Now().Add(delay).After(deadline) {
			return err
		}
		time.Sleep(delay)
		delay = min(2*delay, patientRenameMaxDelay)
	}
}
