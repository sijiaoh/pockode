package git

import (
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"
)

func TestStagedChange(t *testing.T) {
	t.Run("an index matching HEAD has nothing to describe", func(t *testing.T) {
		dir, cleanup := setupCommitRepo(t)
		defer cleanup()
		// Unstaged changes are not what a commit records.
		writeTestFile(t, dir, "file.txt", "edited but not staged\n")

		if _, err := StagedChange(dir, false); !errors.Is(err, ErrNothingStaged) {
			t.Fatalf("got %v, want ErrNothingStaged", err)
		}
	})

	t.Run("describes what is staged, with the messages before it newest first", func(t *testing.T) {
		dir, cleanup := setupCommitRepo(t)
		defer cleanup()
		writeTestFile(t, dir, "second.txt", "two\n")
		runGit(t, dir, "add", "second.txt")
		runGit(t, dir, "commit", "--no-gpg-sign", "-m", "Add second\n\nWith a body.")
		writeTestFile(t, dir, "staged.txt", "staged line\n")
		runGit(t, dir, "add", "staged.txt")
		writeTestFile(t, dir, "file.txt", "unstaged line\n")

		change, err := StagedChange(dir, false)
		if err != nil {
			t.Fatalf("StagedChange: %v", err)
		}
		if !strings.Contains(change.Diff, "+staged line") || strings.Contains(change.Diff, "unstaged line") {
			t.Errorf("diff is not the index against HEAD:\n%s", change.Diff)
		}
		if !strings.Contains(change.Stat, "staged.txt") {
			t.Errorf("stat = %q", change.Stat)
		}
		if want := []string{"Add second\n\nWith a body.", "initial"}; !slices.Equal(change.Recent, want) {
			t.Errorf("recent = %q, want %q", change.Recent, want)
		}
		if change.Replacing != "" || change.Truncated {
			t.Errorf("got %+v", change)
		}
	})

	t.Run("an unborn branch describes every staged file and has no history", func(t *testing.T) {
		dir, cleanup := setupTestRepo(t)
		defer cleanup()
		writeTestFile(t, dir, "first.txt", "hello\n")
		runGit(t, dir, "add", "first.txt")

		change, err := StagedChange(dir, false)
		if err != nil {
			t.Fatalf("StagedChange: %v", err)
		}
		if !strings.Contains(change.Diff, "+hello") || len(change.Recent) != 0 {
			t.Errorf("got %+v", change)
		}
	})

	// Amending with nothing staged is how a message is reworded, so the draft
	// describes the commit being replaced instead of refusing.
	t.Run("an amend describes HEAD's change plus the index, and hides HEAD from the history", func(t *testing.T) {
		dir, cleanup := setupCommitRepo(t)
		defer cleanup()
		writeTestFile(t, dir, "file.txt", "amended content\n")
		runGit(t, dir, "add", "file.txt")
		runGit(t, dir, "commit", "--no-gpg-sign", "-m", "Change the file")

		change, err := StagedChange(dir, true)
		if err != nil {
			t.Fatalf("StagedChange: %v", err)
		}
		if !strings.Contains(change.Diff, "+amended content") {
			t.Errorf("diff misses HEAD's own change:\n%s", change.Diff)
		}
		if change.Replacing != "Change the file" {
			t.Errorf("replacing = %q", change.Replacing)
		}
		if !slices.Equal(change.Recent, []string{"initial"}) {
			t.Errorf("recent = %q, want only the commits before HEAD", change.Recent)
		}
	})

	t.Run("amending the root commit compares it with the empty tree", func(t *testing.T) {
		dir, cleanup := setupCommitRepo(t)
		defer cleanup()

		change, err := StagedChange(dir, true)
		if err != nil {
			t.Fatalf("StagedChange: %v", err)
		}
		if !strings.Contains(change.Diff, "+content") || len(change.Recent) != 0 {
			t.Errorf("got %+v", change)
		}
	})
}

// The messages shown for style are read with the same guard as amend's
// prefill: under log.showSignature, gpg's verdict would otherwise read as part
// of each signed message, and be imitated.
func TestStagedChange_IgnoresSignatureOutput(t *testing.T) {
	dir, cleanup := setupCommitRepo(t)
	defer cleanup()

	signCommits(t, dir)
	writeTestFile(t, dir, "file.txt", "changed\n")
	runGit(t, dir, "add", "file.txt")
	runGit(t, dir, "commit", "-S", "-m", "Signed subject")
	runGit(t, dir, "config", "log.showSignature", "true")

	change, err := StagedChange(dir, true)
	if err != nil {
		t.Fatalf("StagedChange: %v", err)
	}
	if change.Replacing != "Signed subject" {
		t.Errorf("replacing = %q, want the message alone", change.Replacing)
	}

	writeTestFile(t, dir, "file.txt", "changed again\n")
	runGit(t, dir, "add", "file.txt")
	if change, err = StagedChange(dir, false); err != nil {
		t.Fatalf("StagedChange: %v", err)
	}
	if want := []string{"Signed subject", "initial"}; !slices.Equal(change.Recent, want) {
		t.Errorf("recent = %q, want %q", change.Recent, want)
	}
}

func TestFitDiff(t *testing.T) {
	fileDiff := func(name string, lines int) string {
		var b strings.Builder
		fmt.Fprintf(&b, "diff --git a/%s b/%s\n--- a/%s\n+++ b/%s\n@@ -0,0 +1,%d @@\n", name, name, name, name, lines)
		for i := range lines {
			fmt.Fprintf(&b, "+%s line %d\n", name, i)
		}
		return b.String()
	}

	t.Run("a diff that fits is kept whole", func(t *testing.T) {
		diff := fileDiff("a.go", 3) + fileDiff("b.go", 3)
		if got, truncated := fitDiff(diff, len(diff), false); got != diff || truncated {
			t.Errorf("fitDiff changed a diff that fits: %q", got)
		}
	})

	// A regenerated lockfile staged beside a small fix must not push the fix
	// out of what the model sees.
	t.Run("a large file is cut so that a small one stays whole", func(t *testing.T) {
		small := fileDiff("fix.go", 2)
		large := fileDiff("lock.json", 2000)
		limit := 4 << 10

		got, truncated := fitDiff(large+small, limit, false)
		if !truncated {
			t.Fatal("not reported as truncated")
		}
		if !strings.Contains(got, small) {
			t.Errorf("the small file's diff was not kept whole:\n%s", got)
		}
		if !strings.Contains(got, "diff --git a/lock.json") || !strings.Contains(got, "more lines of this file's diff omitted]") {
			t.Errorf("the large file lost its header or its omission note:\n%s", got[:200])
		}
		if len(got) > limit {
			t.Errorf("len = %d, want at most %d", len(got), limit)
		}
	})

	// Thousands of small files leave less than a header's worth each, so the
	// fair split alone would show every one as a mangled header stub and
	// overrun the budget with omission notes.
	t.Run("too many files to show at all leaves some out, within the budget", func(t *testing.T) {
		var b strings.Builder
		for i := range 5000 {
			b.WriteString(fileDiff(fmt.Sprintf("pkg/file%04d.go", i), 3))
		}
		limit := 48 << 10

		got, truncated := fitDiff(b.String(), limit, false)
		if !truncated || len(got) > limit {
			t.Fatalf("len = %d, truncated = %v; want at most %d", len(got), truncated, limit)
		}
		if !strings.HasSuffix(got, "changed_files lists them]\n") {
			t.Errorf("no note saying files were left out")
		}
		// Every file shown is shown whole: they are small, and none is a stub.
		for _, file := range splitDiffFiles(strings.TrimSuffix(got, "[... the diffs of the remaining files are omitted; changed_files lists them]\n")) {
			if !strings.HasPrefix(file, "diff --git a/pkg/file") || !strings.Contains(file, "@@") {
				t.Fatalf("a file is shown without its header or hunk:\n%q", file)
			}
		}
	})

	t.Run("every file cut keeps its header and the result stays within the budget", func(t *testing.T) {
		var b strings.Builder
		for i := range 40 {
			b.WriteString(fileDiff(fmt.Sprintf("big%02d.go", i), 500))
		}
		limit := 48 << 10

		got, _ := fitDiff(b.String(), limit, false)
		if len(got) > limit {
			t.Fatalf("len = %d, want at most %d", len(got), limit)
		}
		if n := strings.Count(got, "+++ b/big"); n != 40 {
			t.Errorf("%d headers kept, want all 40", n)
		}
	})

	// A diff read only in part ends mid-file, and the note must not pretend to
	// know how much is missing.
	t.Run("a diff read only in part says its last file is incomplete", func(t *testing.T) {
		head := fileDiff("a.go", 2) + fileDiff("b.go", 10)[:120]

		got, truncated := fitDiff(head, 1<<20, true)
		if !truncated {
			t.Fatal("not reported as truncated")
		}
		if !strings.HasPrefix(got, fileDiff("a.go", 2)) || !strings.Contains(got, "[... the rest of this file's diff omitted]\n") || !strings.HasSuffix(got, "changed_files lists them]\n") {
			t.Errorf("got:\n%s", got)
		}
	})
}

func TestExecGitPrefix(t *testing.T) {
	dir, cleanup := setupCommitRepo(t)
	defer cleanup()
	writeTestFile(t, dir, "big.txt", strings.Repeat("a line of the staged file\n", 10000))
	runGit(t, dir, "add", "big.txt")

	got, more, err := execGitPrefix(dir, 1000, "diff", "--cached")
	if err != nil || !more || len(got) > 1000 {
		t.Fatalf("got %d bytes, more=%v, err=%v; want at most 1000 and more", len(got), more, err)
	}
	whole, more, err := execGitPrefix(dir, 1<<20, "diff", "--cached")
	if err != nil || more || !strings.HasPrefix(whole, strings.TrimSpace(got)) {
		t.Fatalf("whole read: more=%v err=%v", more, err)
	}
}

// --stat is what names a file whose diff was left out, so its paths must be
// whole, not shortened to fit a terminal there is none of.
func TestStagedChange_StatKeepsLongPaths(t *testing.T) {
	dir, cleanup := setupCommitRepo(t)
	defer cleanup()
	long := "a/very/deeply/nested/directory/that/goes/on/and/on/forever/some_really_long_file_name_here.go"
	writeTestFile(t, dir, long, "x\n")
	runGit(t, dir, "add", long)

	change, err := StagedChange(dir, false)
	if err != nil {
		t.Fatalf("StagedChange: %v", err)
	}
	if !strings.Contains(change.Stat, long) {
		t.Errorf("stat shortened the path:\n%s", change.Stat)
	}
}

func TestStagedChange_AmendWithoutCommit(t *testing.T) {
	dir, cleanup := setupTestRepo(t)
	defer cleanup()
	if _, err := StagedChange(dir, true); !errors.Is(err, ErrNothingToAmend) {
		t.Fatalf("got %v, want ErrNothingToAmend", err)
	}
}
