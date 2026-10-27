package git

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"slices"
	"strings"
)

// ErrNothingStaged reports a commit with nothing to describe: the index matches
// HEAD and the commit is not an amend.
var ErrNothingStaged = errors.New("nothing is staged to commit")

// ErrNothingToAmend reports an amend on a branch with no commit yet.
var ErrNothingToAmend = errors.New("there is no commit to amend yet")

// CommitChange is what a commit about to be made would contain, as text for
// someone — an AI CLI drafting its message — to describe it from.
type CommitChange struct {
	// Stat is the `--stat` summary of every file in the change: it is what
	// still names a file whose diff did not fit. Only a change touching
	// thousands of files is cut, at maxDraftStatBytes.
	Stat string
	// Diff is the change itself, cut to fit maxDraftDiffBytes as described at
	// fitDiff.
	Diff string
	// Truncated says Diff is not the whole change.
	Truncated bool
	// Replacing is the message of the commit an amend replaces; empty
	// otherwise.
	Replacing string
	// Recent are the messages of the latest commits before this one, newest
	// first, for the repository's style.
	Recent []string
}

const (
	// maxDraftDiffBytes bounds the diff handed to the CLI. 48 KiB is on the
	// order of 12k tokens: enough to show a sizeable change whole, and small
	// enough that a huge one costs a bounded amount and is still answered in
	// seconds. A commit message names what changed, not every line of it.
	maxDraftDiffBytes = 48 << 10
	// maxDraftReadBytes bounds how much of the diff is read at all, before it
	// is cut to maxDraftDiffBytes: the fair split needs every file's size, but a
	// staged database dump would otherwise be held in memory whole. Past this
	// the files at the end of the diff are left out, and --stat still names
	// them.
	maxDraftReadBytes = 4 << 20
	// maxDraftStatBytes bounds the file summary, which only runs long for a
	// commit touching thousands of files.
	maxDraftStatBytes = 16 << 10
	// draftRecentCommits is how many earlier messages are shown for style.
	draftRecentCommits = 10
	// maxDraftMessageBytes bounds each of them: a release commit with the whole
	// changelog in its body says nothing more about style than its first part.
	maxDraftMessageBytes = 2 << 10
)

// StagedChange reads what committing now would record in the root repository
// at dir, which is what git.commit commits: submodules' own indexes are not
// part of it.
//
// With amend the change is the whole of the commit that would replace HEAD —
// HEAD's own changes plus whatever is staged on top — so an amend with nothing
// staged still has something to describe. Without amend, an index that matches
// HEAD is ErrNothingStaged.
func StagedChange(dir string, amend bool) (*CommitChange, error) {
	var change CommitChange
	// The diff is taken against base; empty means against HEAD, which is what a
	// plain `git diff --cached` does — including on an unborn branch, where
	// every staged file is new.
	base := ""
	logFrom := "HEAD"
	if amend {
		if isUnborn(dir) {
			return nil, ErrNothingToAmend
		}
		replacing, err := execGit(dir, "log", "-1", "--no-show-signature", "--format=%B", "HEAD")
		if err != nil {
			return nil, err
		}
		change.Replacing = truncateMessage(replacing)
		if base, err = parentOrEmptyTree(dir); err != nil {
			return nil, err
		}
		logFrom = "HEAD~1"
	}

	diffArgs := []string{"diff", "--cached", "--no-color", "--no-ext-diff", "-M"}
	if base != "" {
		diffArgs = append(diffArgs, base)
	}
	diff, readCut, err := execGitPrefix(dir, maxDraftReadBytes, diffArgs...)
	if err != nil {
		return nil, err
	}
	if diff == "" && !amend {
		return nil, ErrNothingStaged
	}
	// Without a terminal git fits --stat to 80 columns and shortens long paths
	// to ".../name", which would defeat the one thing it is here for. The
	// width only lifts that; maxDraftStatBytes still bounds the whole.
	stat, err := execGit(dir, append(diffArgs, "--stat=1000,900")...)
	if err != nil {
		return nil, err
	}

	if cut, truncated := cutAtLine(stat, maxDraftStatBytes); truncated {
		stat = cut + "\n[...]"
	}
	change.Stat = stat
	change.Diff, change.Truncated = fitDiff(diff, maxDraftDiffBytes, readCut)

	change.Recent, err = recentMessages(dir, logFrom)
	if err != nil {
		return nil, err
	}
	return &change, nil
}

// parentOrEmptyTree is what an amend of HEAD is compared with: HEAD's first
// parent, or for a root commit the empty tree — asked of git rather than
// spelled out, because its id differs between SHA-1 and SHA-256 repositories.
func parentOrEmptyTree(dir string) (string, error) {
	if parent, err := execGit(dir, "rev-parse", "--verify", "--quiet", "HEAD~1"); err == nil {
		return parent, nil
	}
	cmd := gitCommand(dir, "hash-object", "-t", "tree", "--stdin")
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("git hash-object of the empty tree: %w", err)
	}
	return strings.TrimSpace(string(out)), nil
}

// recentMessages returns the full messages of the latest non-merge commits
// reachable from rev, which may name no commit (an unborn branch, or amending
// a root commit) and then gives none.
func recentMessages(dir, rev string) ([]string, error) {
	if _, err := execGit(dir, "rev-parse", "--verify", "--quiet", rev); err != nil {
		return nil, nil
	}
	// NUL-separated: a message can contain any line, but not a NUL. Without
	// --no-show-signature, log.showSignature would put gpg's verdict on each
	// signed commit into its message (see docs/git.md#commit).
	out, err := execGit(dir, "log", fmt.Sprintf("-n%d", draftRecentCommits), "--no-merges", "--no-show-signature", "--format=%B%x00", rev)
	if err != nil {
		return nil, err
	}
	var messages []string
	for _, msg := range strings.Split(out, "\x00") {
		if msg = strings.TrimSpace(msg); msg != "" {
			messages = append(messages, truncateMessage(msg))
		}
	}
	return messages, nil
}

func truncateMessage(msg string) string {
	msg = strings.TrimSpace(msg)
	if cut, truncated := cutAtLine(msg, maxDraftMessageBytes); truncated {
		return cut + "\n[...]"
	}
	return msg
}

// fitDiff cuts a diff down to limit bytes without letting one file crowd out
// the rest.
//
// A diff that fits is returned whole. Otherwise the budget is shared fairly —
// a regenerated lockfile staged with a two-line fix must not leave the fix
// out:
//
//   - Every file shown is guaranteed its header (up to its first hunk), a
//     little of its body and room for the note that says it was cut.
//   - When the budget cannot give that much to every file, the files with the
//     smallest such minimum are shown and the rest left out, under one closing
//     note. --stat still names them.
//   - What is left over is split by water-filling: files that need less than an
//     even share get what they need, the larger ones the same share each.
//
// Each file that is cut keeps as many whole lines as fit and ends with a note
// saying how much of it was left out. The notes are counted in the budget, so
// the result never exceeds limit.
//
// readCut says diff is itself only the head of the real one (execGitPrefix
// stopped reading), so its last file is incomplete whatever its share, and how
// much of it is missing is unknown.
func fitDiff(diff string, limit int, readCut bool) (string, bool) {
	if len(diff) <= limit && !readCut {
		return diff, false
	}
	files := splitDiffFiles(diff)

	// need is what showing a file whole costs; minimum is what showing it at
	// all does. A file whose text is incomplete costs its note on top, since it
	// is cut however much of it fits.
	need := make([]int, len(files))
	minimum := make([]int, len(files))
	for i, file := range files {
		need[i] = len(file)
		if readCut && i == len(files)-1 {
			need[i] += cutNoteBytes
		}
		minimum[i] = min(need[i], diffHeaderLen(file)+cutNoteBytes+minDraftBodyBytes)
	}

	// A diff read only in part has files after its last one that were never
	// read, so it closes with the omitted-files note however many fit.
	budget := limit
	if readCut {
		budget -= omittedNoteBytes
	}
	shown := pickByMinimum(minimum, budget)
	if len(shown) < len(files) && !readCut {
		budget -= omittedNoteBytes
		shown = pickByMinimum(minimum, budget)
	}

	extra := make([]int, len(shown))
	spent := 0
	for j, i := range shown {
		extra[j] = need[i] - minimum[i]
		spent += minimum[i]
	}
	extraShares := fairShares(extra, budget-spent)

	isShown := make(map[int]int, len(shown))
	for j, i := range shown {
		isShown[i] = minimum[i] + extraShares[j]
	}

	var b strings.Builder
	for i, file := range files {
		share, ok := isShown[i]
		if !ok {
			continue
		}
		incomplete := readCut && i == len(files)-1
		if len(file) <= share && !incomplete {
			b.WriteString(file)
			continue
		}
		// share - cutNoteBytes still covers the header (minimum guarantees it),
		// so cutting at a line boundary within it keeps the header whole.
		cut, _ := cutAtLine(file, share-cutNoteBytes)
		b.WriteString(strings.TrimRight(cut, "\n"))
		if incomplete {
			b.WriteString("\n[... the rest of this file's diff omitted]\n")
			continue
		}
		omitted := len(strings.Split(strings.Trim(file[len(cut):], "\n"), "\n"))
		fmt.Fprintf(&b, "\n[... %d more lines of this file's diff omitted]\n", omitted)
	}
	if len(shown) < len(files) || readCut {
		b.WriteString("[... the diffs of the remaining files are omitted; changed_files lists them]\n")
	}
	return b.String(), true
}

const (
	// cutNoteBytes is room for the note closing a cut file, the newline before
	// it included: "[... 1234567 more lines of this file's diff omitted]".
	cutNoteBytes = 64
	// omittedNoteBytes is room for the note closing a diff that leaves files
	// out.
	omittedNoteBytes = 96
	// minDraftBodyBytes is the least of a file's changes worth showing beside
	// its header: a few lines, enough to say what kind of change it is.
	minDraftBodyBytes = 256
)

// diffHeaderLen is the length of a file's diff header — everything up to its
// first hunk, which is all of it for a diff with no hunks (a binary file, a
// pure rename, a mode change).
func diffHeaderLen(file string) int {
	if i := strings.Index(file, "\n@@"); i >= 0 {
		return i + 1
	}
	return len(file)
}

// pickByMinimum returns the indexes of the files to show: as many as fit in
// budget at their minimum cost, cheapest first, in their original order.
func pickByMinimum(minimum []int, budget int) []int {
	order := make([]int, len(minimum))
	for i := range order {
		order[i] = i
	}
	slices.SortStableFunc(order, func(a, b int) int { return minimum[a] - minimum[b] })

	var picked []int
	for _, i := range order {
		if minimum[i] > budget {
			break
		}
		budget -= minimum[i]
		picked = append(picked, i)
	}
	slices.Sort(picked)
	return picked
}

// execGitPrefix is execGit for output that may be too large to hold: it
// returns at most limit bytes of stdout, and whether git had more to say —
// in which case git is stopped rather than read to the end.
func execGitPrefix(dir string, limit int, args ...string) (string, bool, error) {
	cmd := gitCommand(dir, args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return "", false, err
	}
	if err := cmd.Start(); err != nil {
		return "", false, newCommandError(args, "", err)
	}

	data, readErr := io.ReadAll(io.LimitReader(stdout, int64(limit)+1))
	more := len(data) > limit
	if more {
		data = data[:limit]
		// Only reads: nothing for git to clean up, so no SIGTERM first.
		if err := cmd.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
			return "", false, fmt.Errorf("stop git %s: %w", strings.Join(args, " "), err)
		}
	}
	waitErr := cmd.Wait()
	if !more {
		if err := errors.Join(readErr, waitErr); err != nil {
			return "", false, newCommandError(args, stderr.String(), err)
		}
	}
	return strings.TrimSpace(string(data)), more, nil
}

// splitDiffFiles splits a diff into one piece per file, at each "diff --git"
// header. Every piece but the last ends in a newline, so joining them gives the
// diff back.
func splitDiffFiles(diff string) []string {
	const header = "diff --git "
	var files []string
	start := 0
	for i := 0; ; {
		next := strings.Index(diff[i:], "\n"+header)
		if next < 0 {
			break
		}
		at := i + next + 1
		files = append(files, diff[start:at])
		start = at
		i = at
	}
	return append(files, diff[start:])
}

// fairShares divides limit bytes between needs of the given sizes by
// water-filling: a need below an even split of what remains is met in full,
// and what it leaves is shared by the others.
func fairShares(needs []int, limit int) []int {
	shares := make([]int, len(needs))
	pending := make([]int, len(needs))
	for i := range needs {
		pending[i] = i
	}
	remaining := limit
	for len(pending) > 0 {
		even := remaining / len(pending)
		var larger []int
		for _, i := range pending {
			if needs[i] <= even {
				shares[i] = needs[i]
				remaining -= shares[i]
			} else {
				larger = append(larger, i)
			}
		}
		if len(larger) == len(pending) {
			for _, i := range larger {
				shares[i] = even
			}
			break
		}
		pending = larger
	}
	return shares
}

// cutAtLine returns at most limit bytes of s, ending at a line boundary when
// there is one to end at, and whether anything was cut.
func cutAtLine(s string, limit int) (string, bool) {
	if len(s) <= limit {
		return s, false
	}
	cut := s[:limit]
	if nl := strings.LastIndexByte(cut, '\n'); nl > 0 {
		cut = cut[:nl]
	}
	return cut, true
}
