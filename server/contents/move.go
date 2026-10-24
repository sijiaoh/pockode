package contents

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
)

var (
	ErrDestinationNotFound = errors.New("destination not found")
	ErrIntoItself          = errors.New("cannot move a directory into itself")
)

// Move puts the entry at relPath into the existing directory destDir, keeping
// its name, and returns the path it now has. destDir "" is the work directory.
//
// It is Rename's other half: Rename changes a name and never a directory, this
// changes a directory and never a name. Kept apart so that each failure
// surface belongs to the gesture that can show it — a move's destination is
// picked, not typed, so it is never created on the way.
//
// Moving an entry into the directory it is already in succeeds and does
// nothing, as renaming to the same name does: the requested state holds.
//
// Returns ErrNotFound for a missing source, ErrDestinationNotFound and
// ErrNotADirectory for a destination that is not a directory, ErrIntoItself
// for a directory moved into itself or beneath itself, ErrExists for a name
// already taken in destDir, and ErrInvalidPath for a path that escapes workDir
// lexically or through a link.
func Move(workDir, relPath, destDir string) (string, error) {
	if relPath == "" {
		return "", fmt.Errorf("%w: empty path", ErrInvalidPath)
	}
	if err := ValidatePath(workDir, relPath); err != nil {
		return "", err
	}
	if err := ValidatePath(workDir, destDir); err != nil {
		return "", err
	}

	// Cleaned first: filepath.Dir("docs/") is docs itself, not its parent.
	srcRel := filepath.Clean(relPath)
	name := filepath.Base(srcRel)
	newPath := path.Join(filepath.ToSlash(destDir), name)

	work, err := os.OpenRoot(workDir)
	if err != nil {
		return "", fmt.Errorf("failed to open work directory: %w", err)
	}
	defer work.Close()

	// Both directories are resolved, links and all, and have to land inside
	// the work directory — stricter than Rename, which follows a symlinked
	// parent wherever it goes. Move is new and has no such behavior to keep,
	// and a destination that is a link out would hand a project file to a
	// directory the user never opened. The syscalls below are then given the
	// resolved paths, so a link checked here is not looked up a second time;
	// one swapped in between is the same check-then-act race every file
	// operation here has.
	//
	// The source's parent is resolved before the source is looked at, so that
	// nothing is ever looked up through a link out: "not found" against
	// "invalid path" would otherwise tell which names exist out there.
	srcParent, srcParentInfo, err := resolveDir(work, filepath.Dir(srcRel))
	if err != nil {
		if errors.Is(err, ErrNotFound) || errors.Is(err, ErrNotADirectory) {
			return "", fmt.Errorf("%w: %s", ErrNotFound, relPath)
		}
		return "", fmt.Errorf("%w: %s", err, relPath)
	}
	dest, destInfo, err := resolveDir(work, destDir)
	if err != nil {
		switch {
		case errors.Is(err, ErrNotFound):
			return "", fmt.Errorf("%w: %s", ErrDestinationNotFound, destDir)
		case errors.Is(err, ErrNotADirectory):
			return "", fmt.Errorf("destination is %w: %s", ErrNotADirectory, destDir)
		}
		return "", fmt.Errorf("%w: %s", err, DisplayDir(destDir))
	}

	// Lstat, as in Rename: a symlink is moved as the link, never as whatever
	// it points at, and a dangling one is still an entry to move.
	srcFull := filepath.Join(workDir, srcParent, name)
	srcInfo, err := os.Lstat(srcFull)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return "", fmt.Errorf("%w: %s", ErrNotFound, relPath)
		}
		return "", fmt.Errorf("failed to stat path: %w", err)
	}

	if os.SameFile(srcParentInfo, destInfo) {
		return filepath.ToSlash(srcRel), nil
	}

	// Walked by identity rather than compared as strings: on a
	// case-insensitive file system "Docs/sub" is beneath "docs" while no
	// prefix test says so. rename(2) would refuse it too, but as EINVAL,
	// which reads as a server fault rather than as the user's mistake.
	if srcInfo.IsDir() {
		for d := dest; ; d = filepath.Dir(d) {
			if info, err := os.Stat(filepath.Join(workDir, d)); err == nil && os.SameFile(info, srcInfo) {
				return "", fmt.Errorf("%w: %s into %s", ErrIntoItself, relPath, DisplayDir(destDir))
			}
			if d == "." {
				break
			}
		}
	}

	newFull := filepath.Join(workDir, dest, name)

	// The same check-then-rename as Rename, for the same reason: rename(2)
	// replaces a destination silently. No allowance for a name that only looks
	// taken here — the two directories differ, so whatever Lstat finds is
	// another entry, even a hard link to the source.
	if _, err := os.Lstat(newFull); err == nil {
		return "", existsError(newPath)
	}

	if err := os.Rename(srcFull, newFull); err != nil {
		if errors.Is(err, os.ErrExist) {
			return "", existsError(newPath)
		}
		return "", fmt.Errorf("failed to move %s to %s: %w", relPath, DisplayDir(destDir), err)
	}
	return newPath, nil
}

// resolveDir is OpenDirWithin for a caller that only needs the resolved path
// and the directory's identity.
func resolveDir(work *os.Root, rel string) (string, os.FileInfo, error) {
	dir, resolved, info, err := OpenDirWithin(work, rel)
	if err != nil {
		return "", nil, err
	}
	dir.Close()
	return resolved, info, nil
}
