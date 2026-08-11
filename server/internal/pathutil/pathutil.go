// Package pathutil holds the parts of path handling whose correct answer
// depends on the platform, so that the packages needing them agree instead of
// each reinventing a slightly different rule.
//
// Everything here operates on native paths — the separator of the running OS.
// Values arriving from outside are not native by default and must be converted
// first: git reports `/` on every platform, as do hand-written settings and the
// paths in our own API, so run them through filepath.FromSlash on the way in
// and filepath.ToSlash on the way out.
package pathutil

import (
	"os"
	"path/filepath"
)

// IsAnchored reports whether the OS resolves path against something other than
// the directory a caller is about to join it to.
//
// Beyond absolute paths this covers two Windows-only forms that filepath.IsAbs
// reports as relative: root-relative (`\etc`, resolved against the current
// drive) and drive-relative (`C:etc`, resolved against that drive's working
// directory). Joining either to a base directory does not confine it.
//
// Use filepath.IsLocal instead when the requirement is the stronger "this path
// must stay inside the base directory" — it rules out `..` escapes and Windows
// reserved device names as well. IsAnchored is for the callers that must still
// permit a deliberate escape, such as a `../worktrees` setting, and only need to
// know that the path is anchored somewhere else entirely.
func IsAnchored(path string) bool {
	if path == "" {
		return false
	}
	// os.IsPathSeparator rather than a literal separator, so that `/etc` is
	// recognised as root-relative on Windows too — the OS accepts it there, and
	// this must hold whether or not the caller cleaned the path first.
	return filepath.IsAbs(path) || os.IsPathSeparator(path[0]) || filepath.VolumeName(path) != ""
}

// ChildName returns the part of path directly below dir, and whether path is
// inside dir at all. Comparison follows the platform's own idea of path
// equality (see Equal), so a path is classified the same way the file system
// would resolve it.
//
// Both arguments must already be native, absolute and clean: this compares
// spellings and does not resolve `..`, symlinks or a relative base.
func ChildName(path, dir string) (string, bool) {
	prefix := dir + string(filepath.Separator)
	if len(path) <= len(prefix) {
		return "", false
	}
	if !Equal(path[:len(prefix)], prefix) {
		return "", false
	}
	return path[len(prefix):], true
}

// TrimTildePrefix reports whether path is home-relative — `~` on its own, or
// `~` followed by a separator — and returns the remainder after that separator.
//
// `\` counts as a separator only on Windows. On Unix it is an ordinary
// filename character, so `~\projects` there names a single directory that
// happens to contain a backslash, and expanding it would silently address a
// different file than the user wrote.
//
// The `~user/...` form is not supported and is reported as not home-relative;
// resolving another user's home directory needs the platform account database,
// which is a different problem from the one this package solves.
func TrimTildePrefix(path string) (string, bool) {
	if path == "" || path[0] != '~' {
		return "", false
	}
	if len(path) == 1 {
		return "", true
	}
	if !os.IsPathSeparator(path[1]) {
		return "", false
	}
	return path[2:], true
}

// ExpandTilde replaces a leading `~` with the user's home directory, joining
// the remainder onto it in native form. Paths that are not home-relative come
// back untouched — this expands, it does not normalise — as do
// home-relative ones when the home directory cannot be determined — expansion
// is best-effort, and a caller that needs a usable directory learns otherwise
// when it tries to use it.
//
// This matters most on Windows, where neither cmd.exe nor PowerShell expands
// `~` before the value reaches us, so a literal `~` is what a user who typed
// `~\projects` actually gets unless we expand it ourselves.
func ExpandTilde(path string) string {
	rest, ok := TrimTildePrefix(path)
	if !ok {
		return path
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return path
	}
	if rest == "" {
		return home
	}
	return filepath.Join(home, rest)
}
