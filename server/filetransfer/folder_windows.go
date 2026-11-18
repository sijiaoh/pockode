package filetransfer

import (
	"errors"
	"syscall"

	"golang.org/x/sys/windows"
)

// isInvalidName reports whether the file system refused a name itself: a
// character NTFS does not allow (<>:"|?*), or a name or path too long for it.
func isInvalidName(err error) bool {
	return errors.Is(err, windows.ERROR_INVALID_NAME) ||
		errors.Is(err, windows.ERROR_FILENAME_EXCED_RANGE) ||
		errors.Is(err, syscall.ENAMETOOLONG)
}
