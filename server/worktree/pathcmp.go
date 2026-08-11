package worktree

import "path/filepath"

// childName returns the part of path directly below dir, and whether path is
// inside dir at all. Comparison follows the platform's own idea of path
// equality (see equalPath), so a worktree is classified the same way the file
// system would resolve it.
func childName(path, dir string) (string, bool) {
	prefix := dir + string(filepath.Separator)
	if len(path) <= len(prefix) {
		return "", false
	}
	if !equalPath(path[:len(prefix)], prefix) {
		return "", false
	}
	return path[len(prefix):], true
}
