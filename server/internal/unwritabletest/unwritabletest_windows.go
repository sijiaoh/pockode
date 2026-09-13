//go:build windows

package unwritabletest

import "testing"

// Make skips the test, because the obvious way to write it is silently a no-op
// here: os.Chmod only toggles FILE_ATTRIBUTE_READONLY, which Windows documents
// as not honoured on directories, so a chmod'd directory keeps accepting new
// files and the test fails on its own setup rather than on the behaviour it is
// about.
//
// Saying it properly takes a deny-write ACE for the current user's SID (the ACL
// machinery is in internal/fsperm). That is worth adding the day the code under
// test treats the failure differently per platform; today it only passes on
// whatever the filesystem returned, and the unix leg proves that path.
func Make(t *testing.T, dir string) {
	t.Helper()

	t.Skip("Windows directories ignore the read-only attribute; refusing writes needs a deny ACE")
}
