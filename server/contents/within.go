package contents

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
)

// ErrNotADirectory is a path that names something other than a directory
// where a directory was required.
var ErrNotADirectory = errors.New("not a directory")

// OpenDirWithin opens the existing directory rel beneath work with every link
// on the way followed, provided every step of where it leads is still inside
// work (the walk Resolve makes), and
// returns it as a root along with that resolved path and the directory's info.
//
// Following links rather than refusing them is what lets a link that stays in
// the project lead somewhere — a pnpm workspace links packages into
// node_modules, and on Windows by a junction, whose target is always absolute —
// which work itself refuses outright. Where it leads is read off the opened
// directory (ResolvedName), not off the path: filepath.EvalSymlinks does not
// resolve a junction, so a path check would wave one pointing out of the
// project through.
//
// Returns ErrNotFound for nothing at rel (or a file on the way to it),
// ErrNotADirectory for something else there, and ErrInvalidPath for a
// directory that resolves outside work — the wrapped reason holds host paths,
// for a log, not for a client.
func OpenDirWithin(work *os.Root, rel string) (*os.Root, string, os.FileInfo, error) {
	// Walked first, without following anything out: "not found" against
	// "invalid path" for a name behind a link out would tell which names
	// exist out there.
	r := newResolver(work.Name())
	chain, err := r.dirChain(rel, nil)
	if err != nil {
		if errors.Is(err, ErrNotADirectory) {
			return nil, "", nil, ErrNotADirectory
		}
		if errors.Is(err, ErrNotFound) {
			return nil, "", nil, ErrNotFound
		}
		if errors.Is(err, ErrInvalidPath) {
			return nil, "", nil, err
		}
		return nil, "", nil, fmt.Errorf("failed to stat directory: %w", err)
	}
	real := realPath(chain[len(chain)-1])

	// A root opens with O_DIRECTORY, so a directory swapped for a fifo since
	// the walk fails here instead of blocking the request forever, as a plain
	// os.Open of the fifo would.
	dir, err := work.OpenRoot(real)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, "", nil, ErrNotFound
		}
		return nil, "", nil, fmt.Errorf("failed to open directory: %w", err)
	}
	opened, err := dir.Open(".")
	if err != nil {
		dir.Close()
		return nil, "", nil, fmt.Errorf("failed to open directory: %w", err)
	}
	defer opened.Close()

	resolved, err := ResolvedName(work, real, opened)
	if err != nil {
		dir.Close()
		return nil, "", nil, fmt.Errorf("%w: does not resolve inside the work directory: %w", ErrInvalidPath, err)
	}
	info, err := opened.Stat()
	if err != nil {
		dir.Close()
		return nil, "", nil, fmt.Errorf("failed to stat directory: %w", err)
	}
	if !info.IsDir() {
		dir.Close()
		return nil, "", nil, ErrNotADirectory
	}
	return dir, resolved, info, nil
}

// DisplayDir names the work directory itself in an error message, since the
// empty path that means it would otherwise read as a missing value.
func DisplayDir(relPath string) string {
	if relPath == "" {
		return "the work directory"
	}
	return relPath
}
