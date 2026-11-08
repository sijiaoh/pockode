package git

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/pockode/server/contents"
)

func TestParseNumstatZ(t *testing.T) {
	output := "3\t1\tplain.txt\x00" +
		"-\t-\timage.png\x00" +
		"2\t0\t\x00old name.txt\x00new name.txt\x00" +
		"0\t4\ttab\there.txt\x00"

	got := parseNumstatZ(output)
	want := numstat{
		"plain.txt":     {Additions: 3, Deletions: 1},
		"image.png":     nil,
		"new name.txt":  {Additions: 2, Deletions: 0},
		"tab\there.txt": {Additions: 0, Deletions: 4},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("parseNumstatZ() = %v, want %v", got, want)
	}
}

// lineCounts flattens a status side into what the client reads per row.
func lineCounts(files []FileStatus) map[string]string {
	got := map[string]string{}
	for _, f := range files {
		switch {
		case f.Binary:
			got[f.Path] = "binary"
		case f.Lines == nil:
			got[f.Path] = "unknown"
		default:
			got[f.Path] = fmt.Sprintf("+%d -%d", f.Lines.Additions, f.Lines.Deletions)
		}
	}
	return got
}

func TestStatus_LineCounts(t *testing.T) {
	dir, cleanup := setupTestRepo(t)
	defer cleanup()

	writeTestFile(t, dir, "partial.txt", "a\nb\nc\n")
	writeTestFile(t, dir, "deleted.txt", "x\ny\n")
	writeTestFile(t, dir, "old.txt", "one\ntwo\nthree\nfour\n")
	writeTestFile(t, dir, "image.bin", "\x00\x01")
	runGit(t, dir, "add", "-A")
	runGit(t, dir, "commit", "--no-gpg-sign", "-m", "initial")

	// One line changed and staged, then another added on top.
	writeTestFile(t, dir, "partial.txt", "a\nB\nc\n")
	runGit(t, dir, "add", "partial.txt")
	writeTestFile(t, dir, "partial.txt", "a\nB\nc\nd\n")

	runGit(t, dir, "mv", "old.txt", "new.txt")
	writeTestFile(t, dir, "new.txt", "one\ntwo\nthree\nfour\nfive\n")
	runGit(t, dir, "add", "new.txt")

	if err := os.Remove(filepath.Join(dir, "deleted.txt")); err != nil {
		t.Fatal(err)
	}
	writeTestFile(t, dir, "image.bin", "\x00\x02")

	writeTestFile(t, dir, "untracked.txt", "1\n2\n3")
	writeTestFile(t, dir, "empty.txt", "")
	writeTestFile(t, dir, "untracked.bin", "a\x00b")
	writeTestFile(t, dir, "huge.txt", strings.Repeat("a\n", contents.MaxFileSize/2+1))

	status, err := Status(dir)
	if err != nil {
		t.Fatalf("Status() error: %v", err)
	}

	wantStaged := map[string]string{
		"partial.txt": "+1 -1",
		"new.txt":     "+1 -0",
	}
	wantUnstaged := map[string]string{
		"partial.txt":   "+1 -0",
		"deleted.txt":   "+0 -2",
		"image.bin":     "binary",
		"untracked.txt": "+3 -0",
		"empty.txt":     "+0 -0",
		"untracked.bin": "binary",
		"huge.txt":      "unknown",
	}
	if got := lineCounts(status.Staged); !reflect.DeepEqual(got, wantStaged) {
		t.Errorf("staged counts = %v, want %v", got, wantStaged)
	}
	if got := lineCounts(status.Unstaged); !reflect.DeepEqual(got, wantUnstaged) {
		t.Errorf("unstaged counts = %v, want %v", got, wantUnstaged)
	}
}

// A staged rename is counted, listed and diffed as one pair, whatever the
// user's rename settings: the row's count is the diff its review opens.
func TestStatus_RenameCountsMatchItsDiff(t *testing.T) {
	dir, cleanup := setupTestRepo(t)
	defer cleanup()
	runGit(t, dir, "config", "status.renames", "false")
	runGit(t, dir, "config", "diff.renames", "false")

	writeTestFile(t, dir, "old.txt", "1\n2\n3\n4\n5\n6\n7\n8\n")
	runGit(t, dir, "add", "-A")
	runGit(t, dir, "commit", "--no-gpg-sign", "-m", "initial")
	runGit(t, dir, "mv", "old.txt", "new.txt")
	writeTestFile(t, dir, "new.txt", "1\n2\n3\nfour\n5\n6\n7\n8\n")
	runGit(t, dir, "add", "new.txt")

	status, err := Status(dir)
	if err != nil {
		t.Fatalf("Status() error: %v", err)
	}
	if len(status.Staged) != 1 || status.Staged[0].Status != "R" || status.Staged[0].OrigPath != "old.txt" {
		t.Fatalf("staged = %+v, want one rename from old.txt", status.Staged)
	}
	if got := lineCounts(status.Staged); got["new.txt"] != "+1 -1" {
		t.Errorf("staged counts = %v, want new.txt +1 -1", got)
	}

	result, err := DiffWithContent(dir, "new.txt", DiffOptions{Staged: true})
	if err != nil {
		t.Fatalf("DiffWithContent() error: %v", err)
	}
	if !strings.Contains(result.Diff, "rename from old.txt") ||
		!strings.Contains(result.Diff, "-4\n+four\n") {
		t.Errorf("diff = %q, want the rename pair with one line changed", result.Diff)
	}
	if !strings.HasPrefix(result.OldContent, "1\n2\n3\n4\n") {
		t.Errorf("old content = %q, want old.txt from HEAD", result.OldContent)
	}
}

// Before the first commit the index is compared with the empty tree.
func TestStatus_LineCountsUnborn(t *testing.T) {
	dir, cleanup := setupTestRepo(t)
	defer cleanup()

	writeTestFile(t, dir, "first.txt", "a\nb\n")
	runGit(t, dir, "add", "first.txt")

	status, err := Status(dir)
	if err != nil {
		t.Fatalf("Status() error: %v", err)
	}
	want := map[string]string{"first.txt": "+2 -0"}
	if got := lineCounts(status.Staged); !reflect.DeepEqual(got, want) {
		t.Errorf("staged counts = %v, want %v", got, want)
	}
}

// A submodule's files are counted in the submodule, where the status lists them.
func TestStatus_LineCountsInSubmodule(t *testing.T) {
	parentRepo, cleanup := setupTestRepoWithSubmodule(t)
	defer cleanup()

	writeTestFile(t, parentRepo, "mysub/sub.txt", "modified content\nmore\n")

	status, err := Status(parentRepo)
	if err != nil {
		t.Fatalf("Status() error: %v", err)
	}
	got := lineCounts(status.Submodules["mysub"].Unstaged)
	if got["sub.txt"] != "+2 -1" {
		t.Errorf("submodule unstaged counts = %v, want sub.txt +2 -1", got)
	}
	if len(status.Unstaged) != 0 {
		t.Errorf("root unstaged = %+v, want the submodule entry left out", status.Unstaged)
	}
}

// A conflicted file is listed on both sides, and neither side has a diff whose
// size means anything.
func TestStatus_LineCountsUnmerged(t *testing.T) {
	dir, cleanup := setupTestRepo(t)
	defer cleanup()

	writeTestFile(t, dir, "f.txt", "base\n")
	runGit(t, dir, "add", "-A")
	runGit(t, dir, "commit", "--no-gpg-sign", "-m", "base")
	runGit(t, dir, "checkout", "-q", "-b", "other")
	writeTestFile(t, dir, "f.txt", "theirs\n")
	runGit(t, dir, "commit", "--no-gpg-sign", "-qam", "theirs")
	runGit(t, dir, "checkout", "-q", "-")
	writeTestFile(t, dir, "f.txt", "ours\n")
	runGit(t, dir, "commit", "--no-gpg-sign", "-qam", "ours")
	// Exits non-zero on the conflict, which is the state under test.
	_ = gitCommand(dir, "merge", "other").Run()

	status, err := Status(dir)
	if err != nil {
		t.Fatalf("Status() error: %v", err)
	}
	want := map[string]string{"f.txt": "unknown"}
	if got := lineCounts(status.Staged); !reflect.DeepEqual(got, want) {
		t.Errorf("staged counts = %v, want %v", got, want)
	}
	if got := lineCounts(status.Unstaged); !reflect.DeepEqual(got, want) {
		t.Errorf("unstaged counts = %v, want %v", got, want)
	}
}

// -uall lists a repository nested in the tree as one untracked directory.
func TestStatus_LineCountsNestedRepository(t *testing.T) {
	dir, cleanup := setupTestRepo(t)
	defer cleanup()

	writeTestFile(t, dir, "nested/inner.txt", "x\n")
	runGit(t, filepath.Join(dir, "nested"), "init", "-q")

	status, err := Status(dir)
	if err != nil {
		t.Fatalf("Status() error: %v", err)
	}
	want := map[string]string{"nested/": "unknown"}
	if got := lineCounts(status.Unstaged); !reflect.DeepEqual(got, want) {
		t.Errorf("unstaged counts = %v, want %v", got, want)
	}
}

func TestCountUntracked_Budget(t *testing.T) {
	dir := t.TempDir()
	writeTestFile(t, dir, "a.txt", "1\n2\n")
	writeTestFile(t, dir, "b.txt", "3\n4\n")

	budget := int64(5)
	a := FileStatus{Path: "a.txt", Status: "?"}
	b := FileStatus{Path: "b.txt", Status: "?"}
	countUntracked(dir, &a, &budget)
	countUntracked(dir, &b, &budget)

	if a.Lines == nil || a.Lines.Additions != 2 {
		t.Errorf("a.txt = %+v, want 2 additions within the budget", a.Lines)
	}
	if b.Lines != nil || b.Binary {
		t.Errorf("b.txt = %+v, want it left uncounted past the budget", b)
	}
	if budget != 1 {
		t.Errorf("budget left = %d, want 1", budget)
	}
}
