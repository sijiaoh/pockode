package search

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
)

// maxFilesScanned bounds memory and wall time on large repositories. Hitting it
// makes the result truncated rather than failing the search.
const maxFilesScanned = 50000

// listFiles enumerates candidate files under workDir/scope as slash-separated
// paths relative to workDir, sorted so results are deterministic.
// The second return value reports that the listing hit maxFilesScanned.
func listFiles(ctx context.Context, workDir, scope string, respectGitignore bool) ([]string, bool, error) {
	if respectGitignore {
		if files, truncated, ok := gitListFiles(ctx, workDir, scope, maxFilesScanned); ok {
			return files, truncated, nil
		}
		// Not a git repository (or git is unavailable): fall back to walking,
		// which simply cannot honor gitignore.
	}
	return walkFiles(ctx, workDir, scope, maxFilesScanned)
}

// gitListFiles lists tracked and untracked-but-not-ignored files. git is the
// only gitignore implementation guaranteed to agree with the repository's own
// rules (global excludes, nested .gitignore, .git/info/exclude), so it is
// reused instead of reimplementing the matcher.
// Returns ok=false when git cannot answer, so the caller can fall back.
// limit is a parameter, not maxFilesScanned itself, so tests can exceed it
// without creating that many files.
func gitListFiles(ctx context.Context, workDir, scope string, limit int) (files []string, truncated, ok bool) {
	prefix := ""
	if scope != "" {
		prefix = scope + "/"
	}

	// Tracked files are listed in a call of their own, before the untracked
	// ones, so that they are the ones kept when the limit is hit: an unignored
	// dependency or build directory can hold far more than the limit, and a
	// single --cached --others call prints untracked files first, which would
	// push every tracked file out of the result.
	// --cached and --others can report the same path for unmerged entries, so
	// duplicates are dropped across both calls.
	seen := make(map[string]struct{})
	files = make([]string, 0, 256)
	for _, args := range [][]string{
		{"ls-files", "-z", "--cached"},
		{"ls-files", "-z", "--others", "--exclude-standard"},
	} {
		cmd := exec.CommandContext(ctx, "git", args...)
		cmd.Dir = workDir
		out, err := cmd.Output()
		if err != nil {
			return nil, false, false
		}
		if collectGitPaths(out, scope, prefix, seen, &files, limit) {
			truncated = true
			break
		}
	}

	sort.Strings(files)
	return files, truncated, true
}

// collectGitPaths appends the NUL-separated paths in out that fall under scope
// to files, and reports whether a path had to be dropped because files already
// held limit — so a listing of exactly limit files is not reported truncated.
// It cuts over the raw bytes rather than Split: a string is allocated only for
// the paths actually kept, instead of one per entry in the repository. (The
// output itself is still buffered whole; the limit bounds what is retained,
// not what git prints.)
func collectGitPaths(out []byte, scope, prefix string, seen map[string]struct{}, files *[]string, limit int) bool {
	nul := []byte{0}
	prefixBytes := []byte(prefix)
	for rest := out; len(rest) > 0; {
		var raw []byte
		raw, rest, _ = bytes.Cut(rest, nul)
		if len(raw) == 0 {
			continue
		}
		if prefix != "" && string(raw) != scope && !bytes.HasPrefix(raw, prefixBytes) {
			continue
		}
		// string(raw) inside the index expression is not allocated.
		if _, dup := seen[string(raw)]; dup {
			continue
		}
		if len(*files) >= limit {
			return true
		}
		p := string(raw)
		seen[p] = struct{}{}
		*files = append(*files, p)
	}
	return false
}

// walkFiles assumes scope has already been validated by resolveScope. limit
// is a parameter for the same reason as gitListFiles'.
func walkFiles(ctx context.Context, workDir, scope string, limit int) ([]string, bool, error) {
	root := workDir
	if scope != "" {
		root = filepath.Join(workDir, filepath.FromSlash(scope))
	}

	files := make([]string, 0, 256)
	truncated := false
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			// Unreadable entries are skipped instead of failing the whole search.
			if d != nil && d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if ctxErr := ctx.Err(); ctxErr != nil {
			return ctxErr
		}
		// A linked worktree or submodule has .git as a *file* holding a gitdir
		// pointer, which is the shape Pockode itself runs in — matching only the
		// directory form would leave it searchable.
		if d.Name() == ".git" {
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			return nil
		}
		// Symlinks and other irregular entries are skipped: following them can
		// escape workDir or loop.
		if !d.Type().IsRegular() {
			return nil
		}
		rel, relErr := filepath.Rel(workDir, p)
		if relErr != nil {
			return nil
		}
		// Checked before appending, so that a walk of exactly limit files is
		// not reported truncated, as with gitListFiles.
		if len(files) >= limit {
			truncated = true
			return fs.SkipAll
		}
		files = append(files, filepath.ToSlash(rel))
		return nil
	})
	sort.Strings(files)
	if err != nil {
		// A cancelled walk yields whatever was collected, marked truncated;
		// anything else is a real failure worth reporting.
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
			return files, true, nil
		}
		return nil, false, fmt.Errorf("failed to walk directory: %w", err)
	}
	return files, truncated, nil
}

func isRegularFile(fullPath string) bool {
	info, err := os.Lstat(fullPath)
	return err == nil && info.Mode().IsRegular()
}
