package filetransfer

import (
	"errors"
	"syscall"

	"golang.org/x/sys/windows"
)

// openNonBlock is nothing on Windows: a named pipe exists only under \\.\pipe,
// never in a work directory, so there is no fifo for an open to block on.
const openNonBlock = 0

// isInvalidName reports whether the file system refused a name itself: a
// character NTFS does not allow (<>:"|?*), or a name or path too long for it.
func isInvalidName(err error) bool {
	return errors.Is(err, windows.ERROR_INVALID_NAME) ||
		errors.Is(err, windows.ERROR_FILENAME_EXCED_RANGE) ||
		errors.Is(err, syscall.ENAMETOOLONG)
}
