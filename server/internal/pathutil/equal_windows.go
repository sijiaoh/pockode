//go:build windows

package pathutil

import "strings"

// Equal compares two native paths case-insensitively, matching how Windows
// resolves them.
//
// The two sides of such a comparison usually have independent origins — git
// reports the spelling recorded when a worktree was added, our own paths come
// from the --work argument via filepath.EvalSymlinks (which normalises to the
// on-disk case and upper-cases the drive letter), a user types a node path by
// hand. A byte-wise comparison of `c:\repo` against `C:\repo` fails, and the
// failure is silent: the worktree list comes back empty, or the same directory
// is registered twice.
//
// EqualFold uses Unicode simple case folding, which is slightly more permissive
// than Windows' own upper-case comparison. Erring toward "same path" is the
// safe direction: a false match needs two paths differing only in an exotic
// folding pair, while a false mismatch breaks ordinary use.
func Equal(a, b string) bool { return strings.EqualFold(a, b) }
