//go:build !windows

package worktree

// equalPath compares two native paths. Unix file systems are case-sensitive, so
// two spellings that differ in case are two different files.
func equalPath(a, b string) bool { return a == b }
