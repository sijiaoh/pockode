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

// renameFile renames oldpath to newpath, replacing newpath if it exists, and
// retries while the failure looks like transient sharing contention.
func renameFile(oldpath, newpath string) error {
	for attempt := 1; ; attempt++ {
		err := os.Rename(oldpath, newpath)
		if err == nil || attempt == renameAttempts || !isRetryableRenameError(err) {
			return err
		}
		time.Sleep(renameRetryDelay)
	}
}
