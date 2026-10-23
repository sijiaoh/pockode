//go:build !windows

package filetransfer

import (
	"errors"
	"syscall"
)

// openNonBlock makes an open of a fifo with no reader fail at once instead of
// waiting for one; on a regular file it changes nothing.
const openNonBlock = syscall.O_NONBLOCK

// isInvalidName reports whether the file system refused a name itself: one too
// long for it, or one it cannot hold at all.
func isInvalidName(err error) bool {
	return errors.Is(err, syscall.ENAMETOOLONG) || errors.Is(err, syscall.EINVAL) || errors.Is(err, syscall.EILSEQ)
}
