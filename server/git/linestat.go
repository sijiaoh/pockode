package git

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/pockode/server/contents"
)

// LineStat is how many lines one side of a change adds and deletes.
type LineStat struct {
	Additions int `json:"additions"`
	Deletions int `json:"deletions"`
}

// numstat maps a path to its line counts for one side of the status. A binary
// file maps to nil: git knows it changed but has no lines to count.
type numstat map[string]*LineStat

// readNumstat runs `git diff --numstat` for the index (cached) or the working
// tree, one process for the whole repository rather than one per file.
//
// Each side pairs renames the way the review's diff of that side does, so that
// a row counts what opening it shows, whatever the user's diff.renames says.
// The index finds them as the status does, and a rename is keyed by its new
// path just as the status entry is. The working tree does not: its one rename,
// a move after `git add -N`, is diffed as the new path alone.
func readNumstat(ctx context.Context, dir string, cached bool) (numstat, error) {
	args := []string{"--no-optional-locks", "diff", "--numstat", "-z"}
	if cached {
		args = append(args, "--cached", "--find-renames")
	} else {
		args = append(args, "--no-renames")
	}
	output, err := execGitRaw(ctx, dir, args...)
	if err != nil {
		return nil, err
	}
	return parseNumstatZ(output), nil
}

// parseNumstatZ parses `git diff --numstat -z`. Each record is
// "ADDED\tDELETED\tPATH\x00", or for a rename "ADDED\tDELETED\t\x00OLD\x00NEW\x00"
// — the empty path field is what announces the two that follow. Binary files
// report "-" for both counts.
func parseNumstatZ(output string) numstat {
	result := numstat{}
	fields := strings.Split(output, "\x00")
	for i := 0; i < len(fields); i++ {
		added, rest, ok := strings.Cut(fields[i], "\t")
		if !ok {
			continue
		}
		deleted, path, ok := strings.Cut(rest, "\t")
		if !ok {
			continue
		}
		if path == "" {
			if i+2 >= len(fields) {
				break
			}
			path = fields[i+2]
			i += 2
		}

		if added == "-" || deleted == "-" {
			result[path] = nil
			continue
		}
		a, errA := strconv.Atoi(added)
		d, errD := strconv.Atoi(deleted)
		if errA != nil || errD != nil {
			continue
		}
		result[path] = &LineStat{Additions: a, Deletions: d}
	}
	return result
}

// fill sets file's counts from the numstat, or marks it binary. A file the
// numstat does not mention keeps nil counts with Binary unset, which reads as
// "not counted" — status and numstat pairing a rename differently is the case
// that leaves one.
func (n numstat) fill(file *FileStatus) {
	stat, ok := n[file.Path]
	if !ok {
		return
	}
	if stat == nil {
		file.Binary = true
		return
	}
	file.Lines = stat
}

// untrackedBudget bounds how many bytes of untracked files one status reads to
// count them. The watcher reads the status every few seconds, and a tree with a
// build output nobody ignored can hold far more untracked content than a poll
// should touch; files past the budget are left uncounted. Eight files at the
// diff view's own limit.
const untrackedBudget = 8 * contents.MaxFileSize

// binarySniffLen is how far git looks for a NUL before calling content binary
// (FIRST_FEW_BYTES in git's xdiff-interface.c). Untracked files use the same
// rule as the tracked files beside them, so the two are binary for one reason.
const binarySniffLen = 8000

// countUntracked counts an untracked file as git would count it once added:
// every line an addition, the target of a symlink as its single line.
//
// The count is left out, rather than failing the status, when the file cannot
// be read or is larger than contents.MaxFileSize — the diff view refuses such a
// file too, and says why when it is opened — or when it does not fit in what
// is left of budget, which counting it spends.
//
// Only a regular file or a symlink is read: -uall lists a nested repository as
// its directory, and opening anything else — a fifo — could block the status
// until someone writes to it.
func countUntracked(dir string, file *FileStatus, budget *int64) {
	fullPath := filepath.Join(dir, filepath.FromSlash(file.Path))
	info, err := os.Lstat(fullPath)
	if err != nil || !(info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0) {
		return
	}
	if info.Size() > contents.MaxFileSize || info.Size() > *budget {
		return
	}
	size, content, err := readWorktree(fullPath)
	if err != nil || size > contents.MaxFileSize {
		return
	}
	*budget -= int64(len(content))
	if bytes.IndexByte(content[:min(len(content), binarySniffLen)], 0) >= 0 {
		file.Binary = true
		return
	}
	file.Lines = &LineStat{Additions: countLines(content)}
}

// countLines counts lines the way untrackedDiff splits them: a final line
// without a newline still counts, and an empty file has none.
func countLines(content []byte) int {
	if len(content) == 0 {
		return 0
	}
	n := bytes.Count(content, []byte("\n"))
	if content[len(content)-1] != '\n' {
		n++
	}
	return n
}
