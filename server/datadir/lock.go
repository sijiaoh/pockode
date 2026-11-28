package datadir

import (
	"errors"
	"fmt"
	"path/filepath"
	"time"

	"github.com/pockode/server/filestore"
)

// lockFileName sits at the data directory's top level, which the managed
// .gitignore already ignores as a whole.
const lockFileName = "server.lock"

// ErrInUse is Lock finding the data directory held by another server, and
// still held once lockPatience has passed.
var ErrInUse = errors.New("data directory is in use by another Pockode server")

// Lock claims dir for this server for as long as it runs, or refuses with
// ErrInUse when another server already holds it.
//
// Nothing else keeps two servers off one directory: the port search moves a
// second server on to the next free port, and server.json is a convention the
// cluster reads, not something a server started by hand consults. Two servers
// on one directory each keep their own copy of every index (sessions, works,
// roles…) and overwrite each other's writes, and both number the same
// session's history.
//
// One lock covers everything the server opens: every worktree's data lives
// under dir/worktrees/, and one server opens all of them.
//
// The lock is the OS's (filestore.TryLock), so it never outlives its holder:
// a server that crashes or is killed drops it with the process, with no stale
// file to clear. Go opens files close-on-exec and children inherit no handles
// on either platform, so an AI CLI the server started cannot keep it alive
// after the server is gone. It is held on the file rather than compared by
// path, so two spellings of one directory — a symlink, a relative -data —
// still contend. dir must already exist.
func Lock(dir string) (unlock func(), err error) {
	return lock(dir, lockPatience)
}

// lockPatience is how long Lock waits for a holder to let go before refusing.
// Windows drops a dead process's LockFileEx locks only eventually — "the time
// it takes ... depends upon available system resources", in LockFileEx's own
// documentation — so a server killed and started again at once (a cluster's
// Stop then Start) can find its predecessor's lock still there for a moment.
// A real second server only learns it was refused this much later.
const lockPatience = 3 * time.Second

const lockRetryInterval = 100 * time.Millisecond

func lock(dir string, patience time.Duration) (unlock func(), err error) {
	path := filepath.Join(dir, lockFileName)
	deadline := time.Now().Add(patience)
	for {
		unlock, err = filestore.TryLock(path)
		if !errors.Is(err, filestore.ErrLocked) {
			break
		}
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("%w: %s (stop the server using it, or pass a different -data)", ErrInUse, dir)
		}
		time.Sleep(lockRetryInterval)
	}
	if err != nil {
		return nil, fmt.Errorf("lock data directory %s: %w", dir, err)
	}
	return unlock, nil
}
