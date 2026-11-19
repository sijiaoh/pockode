//go:build !windows

package filetransfer

import (
	"errors"
	"syscall"
)

// isInvalidName reports whether the file system refused a name itself: one too
// long for it, or one it cannot hold at all.
func isInvalidName(err error) bool {
	return errors.Is(err, syscall.ENAMETOOLONG) || errors.Is(err, syscall.EINVAL) || errors.Is(err, syscall.EILSEQ)
}
