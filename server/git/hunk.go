package git

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/pockode/server/contents"
)

// ErrHunkStale refuses a hunk the file's current diff no longer has: the file
// changed after the client read the diff, so what the user picked is not what
// would be applied. Nothing was written; the client rereads the diff.
var ErrHunkStale = errors.New("hunk no longer matches the current diff; reload it and try again")

// ErrHunkUnsupported refuses a hunk operation on a file whose diff is not a
// list of hunks that can be applied one at a time: a typechange, and a diff
// spanning two paths. A conflicted path, whose diff is git's combined one, is
// refused before its diff is read, as ConflictedPathsError.
var ErrHunkUnsupported = errors.New("hunks cannot be staged or unstaged for this file")

// statusTypeChange is a path that changed kind — a file became a symlink, or
// the reverse. git diffs it as a deletion and a creation of the same path, and
// either half applied on its own collides with the entry the other half would
// have removed, so it is staged whole.
const statusTypeChange = "T"

// diffHunk is one `@@` hunk of a file's diff.
type diffHunk struct {
	// header is the `@@ -a,b +c,d @@` line. Its positions are where the hunk
	// sits now; they are not part of the hunk's identity (see hunkIDs).
	header string
	// body is every line under the header, each with its ' ', '+', '-' or '\'
	// prefix.
	body []string
}

// diffSection is one `diff --git` file of a diff: the lines before its first
// hunk, and its hunks.
type diffSection struct {
	header []string
	hunks  []diffHunk
}

// parsedDiff is a diff split into its files.
type parsedDiff struct {
	sections []diffSection
	// unsupported says why the diff's hunks cannot be applied one at a time,
	// and is empty when they can.
	unsupported string
}

// parseDiff splits a unified diff into files and hunks. Hunk bodies are read by
// the counts in their headers rather than up to the next `@@`, so a body line
// is never mistaken for a header whatever it says.
func parseDiff(diff string) parsedDiff {
	var result parsedDiff
	lines := strings.Split(strings.TrimSuffix(diff, "\n"), "\n")
	var section *diffSection
	for i := 0; i < len(lines); i++ {
		line := lines[i]
		switch {
		case strings.HasPrefix(line, "diff --cc ") || strings.HasPrefix(line, "diff --combined ") || strings.HasPrefix(line, "* Unmerged path "):
			// A conflicted path is shown as a combined diff (`@@@` hunks) or not
			// at all, neither of which applies to the index a hunk at a time.
			result.unsupported = "it is conflicted"
			section = nil
		case strings.HasPrefix(line, "diff --git "):
			result.sections = append(result.sections, diffSection{header: []string{line}})
			section = &result.sections[len(result.sections)-1]
		case section == nil:
		case strings.HasPrefix(line, "@@ "):
			oldCount, newCount, ok := parseHunkHeader(line)
			if !ok {
				section = nil
				continue
			}
			hunk := diffHunk{header: line}
			for i+1 < len(lines) && (oldCount > 0 || newCount > 0) {
				i++
				body := lines[i]
				hunk.body = append(hunk.body, body)
				switch {
				// diff.suppressBlankEmpty writes a blank context line as an
				// empty one.
				case body == "" || body[0] == ' ':
					oldCount--
					newCount--
				case body[0] == '-':
					oldCount--
				case body[0] == '+':
					newCount--
				}
			}
			// The marker follows the last line it describes, which may be the
			// last one the counts asked for.
			if i+1 < len(lines) && strings.HasPrefix(lines[i+1], `\`) {
				i++
				hunk.body = append(hunk.body, lines[i])
			}
			section.hunks = append(section.hunks, hunk)
		case len(section.hunks) == 0:
			section.header = append(section.header, line)
		}
	}
	// One path's diff is one file, except for a staged rename git did not pair
	// the way the status did (a status.renameLimit set apart from
	// diff.renameLimit): then it is the new path added and the old one deleted,
	// and a hunk of the second would write a path the request did not name.
	if result.unsupported == "" && len(result.sections) > 1 {
		result.unsupported = "its diff spans more than one path"
	}
	return result
}

// parseHunkHeader reads the line counts of `@@ -a[,b] +c[,d] @@`; an omitted
// count is 1.
func parseHunkHeader(line string) (oldCount, newCount int, ok bool) {
	fields := strings.Fields(line)
	if len(fields) < 4 || fields[3] != "@@" {
		return 0, 0, false
	}
	oldCount, ok1 := parseRangeCount(fields[1], "-")
	newCount, ok2 := parseRangeCount(fields[2], "+")
	return oldCount, newCount, ok1 && ok2
}

func parseRangeCount(field, prefix string) (int, bool) {
	rest, found := strings.CutPrefix(field, prefix)
	if !found {
		return 0, false
	}
	_, count, hasCount := strings.Cut(rest, ",")
	if !hasCount {
		return 1, true
	}
	n, err := strconv.Atoi(count)
	return n, err == nil && n >= 0
}

// hunkIDs names every hunk of diff, in the order they appear in it.
//
// An ID is a hash of the hunk's own lines — context included — and not of its
// position. Staging one hunk moves the line numbers of every hunk below it, and
// a client that has not yet seen the refreshed diff must still be able to stage
// the next one; what has to be refused is a hunk whose *content* changed. The
// context lines are what pin it to its place in the file. Identical hunks are
// told apart by how many came before them and how many there are, so that one
// more identical hunk appearing makes every one of them stale rather than
// shifting which place an ID names. Staging one of them makes the rest stale
// in the same way, which costs the client a reread and nothing more.
//
// The side and the path are part of the hash so that an ID can only ever be
// used for the diff it was read from.
func (d parsedDiff) hunkIDs(path string, staged bool) []string {
	if d.unsupported != "" {
		return nil
	}
	side := "unstaged"
	if staged {
		side = "staged"
	}
	var bodies []string
	total := make(map[string]int)
	for _, section := range d.sections {
		for _, hunk := range section.hunks {
			body := strings.Join(hunk.body, "\n")
			bodies = append(bodies, body)
			total[body]++
		}
	}
	ids := make([]string, 0, len(bodies))
	seen := make(map[string]int)
	for _, body := range bodies {
		n := seen[body]
		seen[body]++
		sum := sha256.Sum256([]byte(side + "\x00" + path + "\x00" + body + "\x00" + strconv.Itoa(n) + "/" + strconv.Itoa(total[body])))
		ids = append(ids, hex.EncodeToString(sum[:16]))
	}
	return ids
}

// find returns the hunk named id with the section it belongs to.
func (d parsedDiff) find(path string, staged bool, id string) (diffSection, diffHunk, bool) {
	ids := d.hunkIDs(path, staged)
	i := 0
	for _, section := range d.sections {
		for _, hunk := range section.hunks {
			if ids[i] == id {
				return section, hunk, true
			}
			i++
		}
	}
	return diffSection{}, diffHunk{}, false
}

// StageHunk stages one hunk of path's unstaged diff, named by an ID from
// DiffResult.HunkIDs. UnstageHunk takes one out of its staged diff.
//
// The diff is read again under the index lock and the hunk applied only if it
// is still in it, line for line; otherwise nothing is written and ErrHunkStale
// is returned. The client's copy of the diff can be seconds old, and an agent
// may have rewritten the file in between — applying the hunk the user looked at
// to a file that has moved on would stage something nobody reviewed.
//
// A conflicted path is refused (ConflictedPathsError), as Add and Reset refuse
// it: marking it resolved is Resolve's, for the whole file.
func StageHunk(dir, path, id string) error {
	return applyHunk(dir, path, id, false)
}

// UnstageHunk is StageHunk for the staged side: it reverses the hunk in the
// index and leaves the working tree alone.
func UnstageHunk(dir, path, id string) error {
	return applyHunk(dir, path, id, true)
}

func applyHunk(dir, path, id string, staged bool) error {
	if err := validatePath(path); err != nil {
		return err
	}
	op := opStage
	if staged {
		op = opUnstage
	}
	return withLock(dir, op, func() error {
		submodules := getSubmodulePaths(dir)
		// Refused as Add and Reset refuse it, and before the status is read: a
		// conflicted path has no side to take a hunk from, and the client's diff
		// may be older than the merge that conflicted it.
		conflicted, err := unmergedPaths(dir, submodules, []string{path})
		if err != nil {
			return err
		}
		if len(conflicted) > 0 {
			return &ConflictedPathsError{Action: op.name, Paths: conflicted}
		}
		status, err := statusWithSubmodules(dir, submodules)
		if err != nil {
			return err
		}
		file := status.file(path, staged)
		if file == nil {
			return ErrHunkStale
		}
		actualDir, relativePath := resolveSubmodulePathWith(submodules, dir, path)
		if relativePath == "" {
			return fmt.Errorf("%w: %s", errNotAFile, path)
		}

		if file.Status == statusTypeChange {
			return fmt.Errorf("%w: %s changed between a file and a symlink", ErrHunkUnsupported, path)
		}
		if !staged && file.Status == "?" {
			return stageUntrackedHunk(actualDir, relativePath, path, id)
		}

		diff, err := diffFile(actualDir, relativePath, file.OrigPath, DiffOptions{Staged: staged})
		if err != nil {
			return err
		}
		parsed := parseDiff(diff)
		if parsed.unsupported != "" {
			return fmt.Errorf("%w: %s, because %s", ErrHunkUnsupported, path, parsed.unsupported)
		}
		section, hunk, ok := parsed.find(path, staged, id)
		if !ok {
			return ErrHunkStale
		}

		args := []string{"apply", "--cached", "--whitespace=nowarn"}
		if staged {
			args = append(args, "--reverse")
		}
		_, err = execGitInput(actualDir, hunkPatch(section, hunk), append(args, "-")...)
		return err
	})
}

// hunkPatch is a patch holding one hunk of section, to be applied to the index
// alone.
//
// Two kinds of header line describe the file as a whole rather than the hunk,
// and would make one hunk carry the whole file's change with it:
//   - a mode change (`old mode` / `new mode`), which staging a hunk would stage
//     too — creation and deletion modes stay, since a new or deleted file's
//     single hunk *is* its creation or deletion;
//   - a rename or copy, which reversed would move the index entry back to its
//     old path. The hunk is applied to the new path instead, which is what
//     unstaging part of a renamed file's edits means: the rename stays staged.
func hunkPatch(section diffSection, hunk diffHunk) []byte {
	var renamed bool
	var header []string
	for _, line := range section.header {
		switch {
		case strings.HasPrefix(line, "rename from "), strings.HasPrefix(line, "copy from "):
			renamed = true
		case strings.HasPrefix(line, "index "),
			strings.HasPrefix(line, "old mode "), strings.HasPrefix(line, "new mode "),
			strings.HasPrefix(line, "similarity index "), strings.HasPrefix(line, "dissimilarity index "),
			strings.HasPrefix(line, "rename to "), strings.HasPrefix(line, "copy to "):
		default:
			header = append(header, line)
		}
	}
	if renamed {
		header = sameNameHeader(header)
	}

	var b bytes.Buffer
	for _, line := range header {
		b.WriteString(line + "\n")
	}
	b.WriteString(hunk.header + "\n")
	for _, line := range hunk.body {
		b.WriteString(line + "\n")
	}
	return b.Bytes()
}

// sameNameHeader rewrites a rename's `diff --git` and `---` lines to name the
// new path on both sides, taken from the `+++` line in git's own quoting.
func sameNameHeader(header []string) []string {
	var plus string
	for _, line := range header {
		if rest, ok := strings.CutPrefix(line, "+++ "); ok {
			plus = rest
		}
	}
	// git ends a name containing a space with a tab in the ---/+++ lines, and
	// only there.
	newName := strings.TrimSuffix(plus, "\t")
	var oldName string
	switch {
	case strings.HasPrefix(newName, `"b/`):
		oldName = `"a/` + newName[3:]
	case strings.HasPrefix(newName, "b/"):
		oldName = "a/" + newName[2:]
	default:
		return header
	}
	tab := strings.TrimPrefix(plus, newName)

	out := make([]string, 0, len(header))
	for _, line := range header {
		switch {
		case strings.HasPrefix(line, "diff --git "):
			line = "diff --git " + oldName + " " + newName
		case strings.HasPrefix(line, "--- "):
			line = "--- " + oldName + tab
		}
		out = append(out, line)
	}
	return out
}

// stageUntrackedHunk stages an untracked file whose single hunk — the whole
// file, as untrackedDiff shows it — is still the one the client named.
//
// The file goes in through `git add` rather than as a patch, so that its mode,
// a symlink, and the repository's clean filters come out as they would for any
// staged file. That opens a gap between the check and the add, closed by
// comparing what the add stored with the content that was checked: a file
// rewritten in between is taken back out of the index and refused as stale.
func stageUntrackedHunk(dir, relativePath, path, id string) error {
	fullPath := filepath.Join(dir, filepath.FromSlash(relativePath))
	// Only what untrackedDiff can show: opening a fifo would block.
	info, err := os.Lstat(fullPath)
	if err != nil {
		return ErrHunkStale
	}
	symlink := info.Mode()&os.ModeSymlink != 0
	if !info.Mode().IsRegular() && !symlink {
		return ErrHunkStale
	}
	size, content, err := readWorktree(fullPath)
	if err != nil {
		return err
	}
	if size > contents.MaxFileSize {
		return ErrHunkStale
	}
	if _, _, ok := parseDiff(untrackedDiff(relativePath, string(content))).find(path, false, id); !ok {
		return ErrHunkStale
	}

	pathspec, err := literalPathspec(relativePath)
	if err != nil {
		return fmt.Errorf("%w: %s", err, path)
	}
	if _, err := execGit(dir, "add", "--", pathspec); err != nil {
		return err
	}
	verified, err := addedAsChecked(dir, relativePath, pathspec, content, symlink)
	if err == nil && verified {
		return nil
	}
	// Whatever went wrong, the file is not left staged unchecked.
	if _, rmErr := execGit(dir, "rm", "--cached", "-f", "--quiet", "--", pathspec); rmErr != nil {
		return fmt.Errorf("%s could not be checked after staging, and could not be unstaged again: %w", path, errors.Join(err, rmErr))
	}
	if err != nil {
		return err
	}
	return ErrHunkStale
}

// addedAsChecked reports whether the index holds content for relativePath, as
// git add would have stored it.
func addedAsChecked(dir, relativePath, pathspec string, content []byte, symlink bool) (bool, error) {
	hashArgs := []string{"hash-object", "--stdin", "--path=" + relativePath}
	if symlink {
		// git add stores a link's target as it is; filters are for file content.
		hashArgs = []string{"hash-object", "--stdin", "--no-filters"}
	}
	want, err := execGitInput(dir, content, hashArgs...)
	if err != nil {
		return false, err
	}
	staged, err := execGit(dir, "ls-files", "--stage", "-z", "--", pathspec)
	if err != nil {
		return false, err
	}
	// "<mode> SP <object> SP <stage> TAB <path>"
	fields := strings.Fields(staged)
	return len(fields) >= 2 && fields[1] == want, nil
}

// hunkIDsFor is the HunkIDs of a DiffResult: none for a diff whose hunks
// cannot be applied as shown.
func hunkIDsFor(path string, file *FileStatus, opts DiffOptions, diff string) []string {
	// -w drops changes from the hunks it shows, so applying one of them would
	// not stage what is on screen.
	if opts.HideWhitespace || file.Status == statusTypeChange {
		return nil
	}
	return parseDiff(diff).hunkIDs(path, opts.Staged)
}
