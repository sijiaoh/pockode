//go:build !windows

package filetransfer

import (
	"fmt"
	"os"
	"path/filepath"
)

// resolvedName is the path beneath root that f, opened there as name, has in
// the file system: name with every link on the way followed, since os.Root
// follows a link that stays within it, and "page.css -> .env" or a link into
// another worktree is the dotfile or the other worktree all the same. A case-
// or normalization-insensitive file system may spell a name another way, but
// never with a leading dot added or dropped, so the name is not canonicalized
// beyond that.
//
// The resolving is by path, after the open; the file found there has to be the
// one opened, so a link swapped in between is refused rather than believed.
func resolvedName(root *os.Root, name string, f *os.File) (string, error) {
	base, err := filepath.EvalSymlinks(root.Name())
	if err != nil {
		return "", err
	}
	target, err := filepath.EvalSymlinks(filepath.Join(root.Name(), name))
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(base, target)
	if err != nil || !filepath.IsLocal(rel) {
		return "", fmt.Errorf("%s resolves to %s, which is not beneath %s", name, target, base)
	}

	opened, err := f.Stat()
	if err != nil {
		return "", err
	}
	found, err := os.Stat(target)
	if err != nil {
		return "", err
	}
	if !os.SameFile(opened, found) {
		return "", fmt.Errorf("%s changed while it was opened", name)
	}
	return rel, nil
}
