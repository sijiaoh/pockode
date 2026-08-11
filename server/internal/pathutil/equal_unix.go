//go:build !windows

package pathutil

// Equal compares two native paths. Unix file systems are case-sensitive, so
// two spellings that differ in case are two different files.
func Equal(a, b string) bool { return a == b }
