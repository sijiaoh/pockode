package git

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pockode/server/internal/symlinktest"
)

// numbered is lines "1".."n", each with its newline, with the lines named in
// edits replaced.
func numbered(n int, edits map[int]string) string {
	var b strings.Builder
	for i := 1; i <= n; i++ {
		line, ok := edits[i]
		if !ok {
			line = fmt.Sprint(i)
		}
		b.WriteString(line + "\n")
	}
	return b.String()
}

// setupHunkRepo commits a 20-line file.txt and edits lines 2 and 18 in the
// working tree: two hunks, far enough apart that git keeps them separate.
func setupHunkRepo(t *testing.T) string {
	t.Helper()
	dir, cleanup := setupTestRepo(t)
	t.Cleanup(cleanup)
	writeTestFile(t, dir, "file.txt", numbered(20, nil))
	runGit(t, dir, "add", "file.txt")
	runGit(t, dir, "commit", "--no-gpg-sign", "-m", "initial")
	writeTestFile(t, dir, "file.txt", numbered(20, map[int]string{2: "two", 18: "eighteen"}))
	return dir
}

func hunkIDsOf(t *testing.T, dir, path string, staged bool) []string {
	t.Helper()
	result, err := DiffWithContent(dir, path, DiffOptions{Staged: staged})
	if err != nil {
		t.Fatalf("DiffWithContent(%s, staged=%v) error: %v", path, staged, err)
	}
	if got, want := len(result.HunkIDs), strings.Count(result.Diff, "\n@@ "); got != want {
		t.Fatalf("%d hunk IDs for %d hunks in\n%s", got, want, result.Diff)
	}
	return result.HunkIDs
}

func indexContent(t *testing.T, dir, path string) string {
	t.Helper()
	return gitOutput(t, dir, "show", ":"+path)
}

func TestStageHunk_StagesOnlyThatHunk(t *testing.T) {
	dir := setupHunkRepo(t)

	ids := hunkIDsOf(t, dir, "file.txt", false)
	if len(ids) != 2 {
		t.Fatalf("got %d hunks, want 2", len(ids))
	}
	if err := StageHunk(dir, "file.txt", ids[1]); err != nil {
		t.Fatalf("StageHunk() error: %v", err)
	}

	if got, want := indexContent(t, dir, "file.txt"), numbered(20, map[int]string{18: "eighteen"}); got != strings.TrimSuffix(want, "\n") {
		t.Errorf("index = %q, want only line 18 staged", got)
	}
	// Partly staged is the file being on both sides of the status.
	status, err := Status(dir)
	if err != nil {
		t.Fatalf("Status() error: %v", err)
	}
	if !status.HasFile("file.txt", true) || !status.HasFile("file.txt", false) {
		t.Errorf("status = %+v, want file.txt both staged and unstaged", status)
	}
}

func TestStageHunk_IDSurvivesAnotherHunkBeingStaged(t *testing.T) {
	dir := setupHunkRepo(t)
	// One more line above line 18, so staging the first hunk moves the second.
	writeTestFile(t, dir, "file.txt", numbered(20, map[int]string{2: "two\nextra", 18: "eighteen"}))

	ids := hunkIDsOf(t, dir, "file.txt", false)
	if err := StageHunk(dir, "file.txt", ids[0]); err != nil {
		t.Fatalf("StageHunk(first) error: %v", err)
	}
	// The client has not seen the refreshed diff, whose second hunk now starts
	// a line lower. Its content is unchanged, so it still stages.
	if err := StageHunk(dir, "file.txt", ids[1]); err != nil {
		t.Fatalf("StageHunk(second, read before the first was staged) error: %v", err)
	}
	if out := gitOutput(t, dir, "diff", "--", "file.txt"); out != "" {
		t.Errorf("unstaged diff after staging both hunks = %q, want empty", out)
	}
}

func TestStageHunk_RefusesStaleHunk(t *testing.T) {
	tests := []struct {
		name string
		// change is what happens to the file after the client read its diff.
		change func(t *testing.T, dir string)
	}{
		{"hunk edited", func(t *testing.T, dir string) {
			writeTestFile(t, dir, "file.txt", numbered(20, map[int]string{2: "TWO", 18: "eighteen"}))
		}},
		{"context around hunk edited", func(t *testing.T, dir string) {
			writeTestFile(t, dir, "file.txt", numbered(20, map[int]string{2: "two", 4: "four", 18: "eighteen"}))
		}},
		{"change reverted", func(t *testing.T, dir string) {
			writeTestFile(t, dir, "file.txt", numbered(20, map[int]string{18: "eighteen"}))
		}},
		{"file staged whole", func(t *testing.T, dir string) {
			runGit(t, dir, "add", "file.txt")
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := setupHunkRepo(t)
			ids := hunkIDsOf(t, dir, "file.txt", false)
			tt.change(t, dir)
			before := indexContent(t, dir, "file.txt")

			if err := StageHunk(dir, "file.txt", ids[0]); !errors.Is(err, ErrHunkStale) {
				t.Fatalf("StageHunk() error = %v, want ErrHunkStale", err)
			}
			if after := indexContent(t, dir, "file.txt"); after != before {
				t.Errorf("index changed by a refused hunk: %q -> %q", before, after)
			}
		})
	}
}

func TestStageHunk_RefusesIDFromOtherSideOrPath(t *testing.T) {
	dir := setupHunkRepo(t)
	writeTestFile(t, dir, "other.txt", numbered(20, nil))
	runGit(t, dir, "add", "other.txt")
	runGit(t, dir, "commit", "--no-gpg-sign", "-m", "other")
	// The same edit, so the same hunk, in a second file.
	writeTestFile(t, dir, "other.txt", numbered(20, map[int]string{2: "two", 18: "eighteen"}))

	ids := hunkIDsOf(t, dir, "file.txt", false)
	if err := StageHunk(dir, "other.txt", ids[0]); !errors.Is(err, ErrHunkStale) {
		t.Errorf("StageHunk(other path) error = %v, want ErrHunkStale", err)
	}
	if err := UnstageHunk(dir, "file.txt", ids[0]); !errors.Is(err, ErrHunkStale) {
		t.Errorf("UnstageHunk(unstaged hunk) error = %v, want ErrHunkStale", err)
	}
}

func TestUnstageHunk_ReversesHunkInIndexOnly(t *testing.T) {
	dir := setupHunkRepo(t)
	runGit(t, dir, "add", "file.txt")

	ids := hunkIDsOf(t, dir, "file.txt", true)
	if len(ids) != 2 {
		t.Fatalf("got %d staged hunks, want 2", len(ids))
	}
	if err := UnstageHunk(dir, "file.txt", ids[0]); err != nil {
		t.Fatalf("UnstageHunk() error: %v", err)
	}

	if got, want := indexContent(t, dir, "file.txt"), numbered(20, map[int]string{18: "eighteen"}); got != strings.TrimSuffix(want, "\n") {
		t.Errorf("index = %q, want line 2 unstaged", got)
	}
	if got, want := readTestFile(t, dir, "file.txt"), numbered(20, map[int]string{2: "two", 18: "eighteen"}); got != want {
		t.Errorf("working tree = %q, want it untouched", got)
	}

	// The same edit in the working tree since does not make a staged hunk stale
	// — only a change to the staged side does.
	ids = hunkIDsOf(t, dir, "file.txt", true)
	writeTestFile(t, dir, "file.txt", numbered(20, nil))
	if err := UnstageHunk(dir, "file.txt", ids[0]); err != nil {
		t.Fatalf("UnstageHunk() after a working-tree edit error: %v", err)
	}
	runGit(t, dir, "add", "file.txt")
	ids = hunkIDsOf(t, dir, "file.txt", true)
	if len(ids) != 0 {
		t.Fatalf("staged hunks after resetting the file = %d, want 0", len(ids))
	}
}

func TestStageHunk_UntrackedFile(t *testing.T) {
	dir := setupHunkRepo(t)
	writeTestFile(t, dir, "new.txt", "a\nb")

	ids := hunkIDsOf(t, dir, "new.txt", false)
	if len(ids) != 1 {
		t.Fatalf("got %d hunks for an untracked file, want 1", len(ids))
	}

	writeTestFile(t, dir, "new.txt", "a\nc")
	if err := StageHunk(dir, "new.txt", ids[0]); !errors.Is(err, ErrHunkStale) {
		t.Fatalf("StageHunk(rewritten untracked file) error = %v, want ErrHunkStale", err)
	}
	if status, _ := Status(dir); status.HasFile("new.txt", true) {
		t.Fatal("a refused untracked file was left staged")
	}

	ids = hunkIDsOf(t, dir, "new.txt", false)
	if err := StageHunk(dir, "new.txt", ids[0]); err != nil {
		t.Fatalf("StageHunk(untracked) error: %v", err)
	}
	if got := indexContent(t, dir, "new.txt"); got != "a\nc" {
		t.Errorf("index = %q, want the file as it was checked", got)
	}

	// And out again: unstaging a new file's only hunk drops it from the index.
	ids = hunkIDsOf(t, dir, "new.txt", true)
	if err := UnstageHunk(dir, "new.txt", ids[0]); err != nil {
		t.Fatalf("UnstageHunk(added file) error: %v", err)
	}
	status, err := Status(dir)
	if err != nil {
		t.Fatalf("Status() error: %v", err)
	}
	if status.HasFile("new.txt", true) || !status.IsUntracked("new.txt") {
		t.Errorf("status = %+v, want new.txt untracked again", status)
	}
}

func TestStageHunk_IntentToAddFile(t *testing.T) {
	dir := setupHunkRepo(t)
	writeTestFile(t, dir, "new.txt", "a\n")
	runGit(t, dir, "add", "-N", "new.txt")

	ids := hunkIDsOf(t, dir, "new.txt", false)
	if err := StageHunk(dir, "new.txt", ids[0]); err != nil {
		t.Fatalf("StageHunk(intent-to-add) error: %v", err)
	}
	if got := indexContent(t, dir, "new.txt"); got != "a" {
		t.Errorf("index = %q, want %q", got, "a")
	}
}

func TestStageHunk_DeletedFile(t *testing.T) {
	dir := setupHunkRepo(t)
	runGit(t, dir, "rm", "-q", "--cached", "file.txt")
	runGit(t, dir, "commit", "--no-gpg-sign", "-q", "-m", "drop")
	writeTestFile(t, dir, "gone.txt", "x\n")
	runGit(t, dir, "add", "gone.txt")
	runGit(t, dir, "commit", "--no-gpg-sign", "-q", "-m", "gone")
	if err := os.Remove(filepath.Join(dir, "gone.txt")); err != nil {
		t.Fatal(err)
	}

	ids := hunkIDsOf(t, dir, "gone.txt", false)
	if err := StageHunk(dir, "gone.txt", ids[0]); err != nil {
		t.Fatalf("StageHunk(deleted) error: %v", err)
	}
	if out := gitOutput(t, dir, "status", "--porcelain", "--", "gone.txt"); out != "D  gone.txt" {
		t.Errorf("status = %q, want the deletion staged", out)
	}

	ids = hunkIDsOf(t, dir, "gone.txt", true)
	if err := UnstageHunk(dir, "gone.txt", ids[0]); err != nil {
		t.Fatalf("UnstageHunk(deleted) error: %v", err)
	}
	if out := gitOutput(t, dir, "status", "--porcelain", "--", "gone.txt"); out != "D gone.txt" {
		t.Errorf("status = %q, want the deletion unstaged", out)
	}
}

func TestStageHunk_NoNewlineAtEnd(t *testing.T) {
	dir := setupHunkRepo(t)
	writeTestFile(t, dir, "file.txt", strings.TrimSuffix(numbered(20, map[int]string{2: "two", 20: "twenty"}), "\n"))

	ids := hunkIDsOf(t, dir, "file.txt", false)
	if err := StageHunk(dir, "file.txt", ids[1]); err != nil {
		t.Fatalf("StageHunk(last hunk) error: %v", err)
	}
	if got, want := indexContent(t, dir, "file.txt"), strings.TrimSuffix(numbered(20, map[int]string{20: "twenty"}), "\n"); got != want {
		t.Errorf("index = %q, want %q", got, want)
	}
}

func TestStageHunk_IdenticalHunks(t *testing.T) {
	dir, cleanup := setupTestRepo(t)
	t.Cleanup(cleanup)
	block := "a\nb\nc\nd\ne\nf\ng\nh\n"
	writeTestFile(t, dir, "file.txt", block+block)
	runGit(t, dir, "add", "file.txt")
	runGit(t, dir, "commit", "--no-gpg-sign", "-m", "initial")
	edited := strings.Replace(block, "d\n", "D\n", 1)
	writeTestFile(t, dir, "file.txt", edited+edited)

	ids := hunkIDsOf(t, dir, "file.txt", false)
	if len(ids) != 2 || ids[0] == ids[1] {
		t.Fatalf("hunk IDs = %v, want two distinct", ids)
	}
	if err := StageHunk(dir, "file.txt", ids[1]); err != nil {
		t.Fatalf("StageHunk(second) error: %v", err)
	}
	if got, want := indexContent(t, dir, "file.txt"), strings.TrimSuffix(block+edited, "\n"); got != want {
		t.Errorf("index = %q, want only the second block staged", got)
	}
}

func TestStageHunk_IdenticalHunkAddedIsStale(t *testing.T) {
	dir, cleanup := setupTestRepo(t)
	t.Cleanup(cleanup)
	block := "a\nb\nc\nd\ne\nf\ng\nh\n"
	writeTestFile(t, dir, "file.txt", block+block+block)
	runGit(t, dir, "add", "file.txt")
	runGit(t, dir, "commit", "--no-gpg-sign", "-m", "initial")
	edited := strings.Replace(block, "d\n", "D\n", 1)
	writeTestFile(t, dir, "file.txt", block+edited+edited)

	ids := hunkIDsOf(t, dir, "file.txt", false)
	// The same edit once more, above the two the client saw: the second of
	// three is now where the first of two was.
	writeTestFile(t, dir, "file.txt", edited+edited+edited)
	if err := StageHunk(dir, "file.txt", ids[0]); !errors.Is(err, ErrHunkStale) {
		t.Errorf("StageHunk() error = %v, want ErrHunkStale", err)
	}
}

func TestStageHunk_IgnoresTextconv(t *testing.T) {
	dir := setupHunkRepo(t)
	runGit(t, dir, "config", "diff.upper.textconv", "tr a-z A-Z <")
	writeTestFile(t, dir, ".gitattributes", "file.txt diff=upper\n")

	ids := hunkIDsOf(t, dir, "file.txt", false)
	if err := StageHunk(dir, "file.txt", ids[0]); err != nil {
		t.Fatalf("StageHunk() error: %v", err)
	}
	// The file's own content, not the textconv's rendering of it.
	if got, want := indexContent(t, dir, "file.txt"), strings.TrimSuffix(numbered(20, map[int]string{2: "two"}), "\n"); got != want {
		t.Errorf("index = %q, want %q", got, want)
	}
}

func TestStageHunk_StagedRenameKeepsRename(t *testing.T) {
	dir := setupHunkRepo(t)
	runGit(t, dir, "add", "file.txt")
	runGit(t, dir, "mv", "file.txt", "moved file.txt")

	ids := hunkIDsOf(t, dir, "moved file.txt", true)
	if len(ids) != 2 {
		t.Fatalf("got %d hunks for a staged rename, want 2", len(ids))
	}
	if err := UnstageHunk(dir, "moved file.txt", ids[0]); err != nil {
		t.Fatalf("UnstageHunk(renamed) error: %v", err)
	}
	if got, want := indexContent(t, dir, "moved file.txt"), numbered(20, map[int]string{18: "eighteen"}); got != strings.TrimSuffix(want, "\n") {
		t.Errorf("index = %q, want line 2 unstaged under the new name", got)
	}
	if out := gitOutput(t, dir, "diff", "--cached", "--name-status", "-M"); !strings.HasPrefix(out, "R") {
		t.Errorf("staged change = %q, want still a rename", out)
	}
}

func TestStageHunk_SuppressBlankEmpty(t *testing.T) {
	dir, cleanup := setupTestRepo(t)
	t.Cleanup(cleanup)
	runGit(t, dir, "config", "diff.suppressBlankEmpty", "true")
	writeTestFile(t, dir, "file.txt", "a\n\nb\n\n\n\n\n\n\nc\n\nd\n")
	runGit(t, dir, "add", "file.txt")
	runGit(t, dir, "commit", "--no-gpg-sign", "-m", "initial")
	writeTestFile(t, dir, "file.txt", "A\n\nb\n\n\n\n\n\n\nc\n\nD\n")

	ids := hunkIDsOf(t, dir, "file.txt", false)
	if len(ids) != 2 {
		t.Fatalf("got %d hunks, want 2", len(ids))
	}
	if err := StageHunk(dir, "file.txt", ids[1]); err != nil {
		t.Fatalf("StageHunk() error: %v", err)
	}
	if got := indexContent(t, dir, "file.txt"); got != "a\n\nb\n\n\n\n\n\n\nc\n\nD" {
		t.Errorf("index = %q, want only the last line staged", got)
	}
}

func TestUnstageHunk_LeavesModeChangeStaged(t *testing.T) {
	dir := setupHunkRepo(t)
	runGit(t, dir, "add", "file.txt")
	runGit(t, dir, "update-index", "--chmod=+x", "file.txt")

	ids := hunkIDsOf(t, dir, "file.txt", true)
	if err := UnstageHunk(dir, "file.txt", ids[0]); err != nil {
		t.Fatalf("UnstageHunk() error: %v", err)
	}
	if out := gitOutput(t, dir, "ls-files", "--stage", "--", "file.txt"); !strings.HasPrefix(out, "100755") {
		t.Errorf("index entry = %q, want the mode change still staged", out)
	}
}

func TestDiffWithContent_NoHunkIDs(t *testing.T) {
	dir := setupHunkRepo(t)
	writeTestBinaryFile(t, dir, "blob.bin", []byte("a\x00b"))

	tests := []struct {
		name string
		path string
		opts DiffOptions
	}{
		{"whitespace hidden", "file.txt", DiffOptions{HideWhitespace: true}},
		{"untracked binary", "blob.bin", DiffOptions{}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result, err := DiffWithContent(dir, tt.path, tt.opts)
			if err != nil {
				t.Fatalf("DiffWithContent() error: %v", err)
			}
			if result.Diff == "" || result.HunkIDs != nil {
				t.Errorf("diff %q with hunk IDs %v, want a diff without IDs", result.Diff, result.HunkIDs)
			}
		})
	}

	// A tracked binary file's diff has no hunk to name.
	runGit(t, dir, "add", "blob.bin")
	runGit(t, dir, "commit", "--no-gpg-sign", "-q", "-m", "blob")
	writeTestBinaryFile(t, dir, "blob.bin", []byte("a\x00c"))
	if ids := hunkIDsOf(t, dir, "blob.bin", false); len(ids) != 0 {
		t.Errorf("binary file hunk IDs = %v, want none", ids)
	}
}

func TestStageHunk_ConflictedFileIsUnsupported(t *testing.T) {
	dir := setupHunkRepo(t)
	runGit(t, dir, "commit", "--no-gpg-sign", "-q", "-am", "ours")
	runGit(t, dir, "checkout", "-q", "-b", "theirs", "HEAD~1")
	writeTestFile(t, dir, "file.txt", numbered(20, map[int]string{2: "deux"}))
	runGit(t, dir, "commit", "--no-gpg-sign", "-q", "-am", "theirs")
	runGit(t, dir, "checkout", "-q", "-")
	if _, err := execGit(dir, "merge", "--no-gpg-sign", "theirs"); err == nil {
		t.Fatal("merge succeeded, want a conflict")
	}

	for _, staged := range []bool{false, true} {
		apply := StageHunk
		if staged {
			apply = UnstageHunk
		}
		if err := apply(dir, "file.txt", "anything"); !errors.Is(err, ErrHunkUnsupported) {
			t.Errorf("staged=%v: error = %v, want ErrHunkUnsupported", staged, err)
		}
	}
}

func TestHunk_BeforeFirstCommit(t *testing.T) {
	dir, cleanup := setupTestRepo(t)
	t.Cleanup(cleanup)
	writeTestFile(t, dir, "new.txt", "a\n")

	ids := hunkIDsOf(t, dir, "new.txt", false)
	if err := StageHunk(dir, "new.txt", ids[0]); err != nil {
		t.Fatalf("StageHunk() error: %v", err)
	}
	ids = hunkIDsOf(t, dir, "new.txt", true)
	if err := UnstageHunk(dir, "new.txt", ids[0]); err != nil {
		t.Fatalf("UnstageHunk() error: %v", err)
	}
	if status, _ := Status(dir); !status.IsUntracked("new.txt") {
		t.Errorf("status = %+v, want new.txt untracked again", status)
	}
}

func TestStageHunk_InSubmodule(t *testing.T) {
	parent, cleanup := setupTestRepoWithSubmodule(t)
	t.Cleanup(cleanup)
	writeTestFile(t, parent, "mysub/sub.txt", "modified content\n")

	ids := hunkIDsOf(t, parent, "mysub/sub.txt", false)
	if err := StageHunk(parent, "mysub/sub.txt", ids[0]); err != nil {
		t.Fatalf("StageHunk() error: %v", err)
	}
	if got := indexContent(t, filepath.Join(parent, "mysub"), "sub.txt"); got != "modified content" {
		t.Errorf("submodule index = %q, want the hunk staged there", got)
	}
}

func TestStageHunk_TypeChangeIsUnsupported(t *testing.T) {
	dir := setupHunkRepo(t)
	if err := os.Remove(filepath.Join(dir, "file.txt")); err != nil {
		t.Fatal(err)
	}
	symlinktest.Make(t, "target", filepath.Join(dir, "file.txt"))

	// Its diff is a deletion and a creation of one path, two hunks neither of
	// which applies without the other.
	result, err := DiffWithContent(dir, "file.txt", DiffOptions{})
	if err != nil {
		t.Fatalf("DiffWithContent() error: %v", err)
	}
	if result.Diff == "" || result.HunkIDs != nil {
		t.Errorf("diff %q with hunk IDs %v, want a diff without IDs", result.Diff, result.HunkIDs)
	}
	if err := StageHunk(dir, "file.txt", "anything"); !errors.Is(err, ErrHunkUnsupported) {
		t.Errorf("StageHunk() error = %v, want ErrHunkUnsupported", err)
	}
}

func TestStageHunk_WaitsForIndexLock(t *testing.T) {
	dir := setupHunkRepo(t)
	ids := hunkIDsOf(t, dir, "file.txt", false)
	err := withLockTimeout(dir, opCommit, lockWait, func() error {
		return StageHunk(dir, "file.txt", ids[0])
	})
	var busy *BusyError
	if !errors.As(err, &busy) || busy.Running != "commit" {
		t.Errorf("StageHunk() during a commit error = %v, want BusyError naming commit", err)
	}
}

func TestParseDiff_BodyIsReadByCounts(t *testing.T) {
	// Body lines that look like headers once their prefix is ignored.
	diff := "diff --git a/f b/f\n" +
		"index 1..2 100644\n" +
		"--- a/f\n" +
		"+++ b/f\n" +
		"@@ -1,2 +1,3 @@\n" +
		" x\n" +
		"+@@ -1 +1 @@\n" +
		"-diff --git a/g b/g\n" +
		"+y\n" +
		"\\ No newline at end of file\n" +
		"@@ -9 +10 @@\n" +
		"-z\n" +
		"+Z\n"
	parsed := parseDiff(diff)
	if len(parsed.sections) != 1 || len(parsed.sections[0].hunks) != 2 {
		t.Fatalf("parsed = %+v, want one file with two hunks", parsed)
	}
	if got := len(parsed.sections[0].hunks[0].body); got != 5 {
		t.Errorf("first hunk body has %d lines, want 5", got)
	}
}
