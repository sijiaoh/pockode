//go:build windows

package filestore

import (
	"errors"
	"os"
	"testing"

	"golang.org/x/sys/windows"
)

// The retry loop is the only thing standing between a transiently locked index
// file and a failed write, and nothing else in the suite reaches it: provoking a
// real sharing violation would mean holding a handle with a conflicting share
// mode from another process. The classification is a pure function, so pin it
// directly.
//
// Errors arrive wrapped in *os.LinkError (that is what os.Rename returns), and
// the wrapper is included on purpose — a classification that only works on a
// bare Errno would report every real failure as permanent.
func TestIsRetryableRenameError(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want bool
	}{
		{"sharing violation", windows.ERROR_SHARING_VIOLATION, true},
		{"lock violation", windows.ERROR_LOCK_VIOLATION, true},
		{"access denied", windows.ERROR_ACCESS_DENIED, true},
		{"file not found", windows.ERROR_FILE_NOT_FOUND, false},
		{"path not found", windows.ERROR_PATH_NOT_FOUND, false},
		{"disk full", windows.ERROR_DISK_FULL, false},
		{"not a syscall error", errors.New("some other failure"), false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			wrapped := &os.LinkError{Op: "rename", Old: "a.tmp", New: "a.json", Err: tt.err}
			if got := isRetryableRenameError(wrapped); got != tt.want {
				t.Errorf("isRetryableRenameError(%v) = %v, want %v", wrapped, got, tt.want)
			}
		})
	}
}
