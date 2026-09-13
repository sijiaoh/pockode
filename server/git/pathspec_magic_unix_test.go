//go:build !windows

package git

import "testing"

// pathspecMagicName returns a filename git reads as pathspec magic rather than
// as a name: the leading ":" opens a magic signature, and "!" inside it negates,
// so ":!important.txt" means "everything except important.txt".
func pathspecMagicName(t *testing.T) string {
	t.Helper()
	return ":!important.txt"
}
