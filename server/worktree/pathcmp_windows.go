//go:build windows

package worktree

import "strings"

// equalPath compares two native paths case-insensitively, matching how Windows
// resolves them.
//
// The two sides of every comparison here have independent origins: git reports
// the spelling recorded when the worktree was added, while our paths come from
// the --work argument via filepath.EvalSymlinks (which normalises to the
// on-disk case and upper-cases the drive letter). A byte-wise comparison of
// `c:\repo` against `C:\repo` fails, and the failure is silent — every
// worktree, main one included, is written off as external and the list comes
// back empty.
//
// EqualFold uses Unicode simple case folding, which is slightly more permissive
// than Windows' own upper-case comparison. Erring toward "same path" is the
// safe direction: a false match needs two paths differing only in an exotic
// folding pair, while a false mismatch empties the worktree list.
func equalPath(a, b string) bool { return strings.EqualFold(a, b) }
