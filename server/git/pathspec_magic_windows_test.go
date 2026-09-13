//go:build windows

package git

import "testing"

// pathspecMagicName skips the test: the hazard it guards against cannot be
// reached on Windows. Pathspec magic is opened by a leading ":", and ":" is not
// a legal character in a Windows filename — the file cannot be created, so no
// name a user can hand us is ever read as magic. The unix leg proves the
// :(literal) prefix that disarms it.
func pathspecMagicName(t *testing.T) string {
	t.Helper()
	t.Skip("Windows filenames cannot contain ':', so no name can open pathspec magic")
	return ""
}
