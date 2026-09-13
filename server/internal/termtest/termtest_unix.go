//go:build !windows

package termtest

import (
	"os"

	"golang.org/x/sys/unix"
)

// Of reports whether this process is still in the session of the process that
// started it. The session is what Setsid gives a process of its own, and it is
// what owns the controlling terminal, so it is the thing detachment is about.
//
// getsid(2) comes from x/sys/unix rather than syscall: the standard library only
// wraps it on the BSDs, not on Linux.
func Of() Attachment {
	sid, err := unix.Getsid(0)
	if err != nil {
		return Attachment("cannot read own session: " + err.Error())
	}
	// The parent is expected to still be waiting on this process; if it has gone
	// away, there is no session left to compare against.
	parentSID, err := unix.Getsid(os.Getppid())
	if err != nil {
		return Attachment("cannot read the parent's session: " + err.Error())
	}
	if sid == parentSID {
		return SharesParent
	}
	return Detached
}

// HasTerminal is always true on unix: every process belongs to a session, so a
// child always has one to inherit and Of can always tell the two cases apart.
func HasTerminal() bool { return true }
