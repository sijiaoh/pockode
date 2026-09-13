//go:build windows

package filestore

import (
	"errors"

	"golang.org/x/sys/windows"
)

// isRetryableRenameError reports whether a failed rename looks like another
// opener temporarily holding the destination.
//
// ERROR_ACCESS_DENIED is included even though it also covers genuine permission
// denials: MoveFileEx reports a destination that is open with a conflicting
// share mode as ACCESS_DENIED, not always as SHARING_VIOLATION, so the two
// cases are indistinguishable here. Retrying a real denial only delays the same
// error by the retry budget, which is the cheaper mistake to make.
func isRetryableRenameError(err error) bool {
	return errors.Is(err, windows.ERROR_ACCESS_DENIED) ||
		errors.Is(err, windows.ERROR_SHARING_VIOLATION) ||
		errors.Is(err, windows.ERROR_LOCK_VIOLATION)
}
