//go:build !windows

package filestore

// isRetryableRenameError reports whether a failed rename is worth retrying.
// rename(2) atomically replaces the destination regardless of who has it open,
// so any failure here is a real one.
func isRetryableRenameError(error) bool {
	return false
}
