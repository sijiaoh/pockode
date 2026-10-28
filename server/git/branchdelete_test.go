package git

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func mustInspect(t *testing.T, dir, name string) *BranchInspection {
	t.Helper()
	got, err := InspectBranch(dir, name)
	if err != nil {
		t.Fatalf("InspectBranch(%s) error: %v", name, err)
	}
	return got
}

func branchExists(t *testing.T, dir, name string) bool {
	t.Helper()
	_, err := execGit(dir, "rev-parse", "--verify", "--quiet", "refs/heads/"+name)
	return err == nil
}

// "Merged" is "deleting loses nothing", whichever branch is checked out: a
// branch merged into main reads as merged from a third branch too, which is
// where git branch -d's merged-into-HEAD test would disagree.
func TestInspectBranch_UniqueCommits(t *testing.T) {
	dir, cleanup := setupTestRepoWithCommit(t)
	defer cleanup()
	main := mainBranch(t, dir)

	runGit(t, dir, "checkout", "-q", "-b", "spike")
	writeTestFile(t, dir, "a.txt", "a\n")
	runGit(t, dir, "add", "a.txt")
	runGit(t, dir, "commit", "--no-gpg-sign", "-qm", "first spike")
	writeTestFile(t, dir, "a.txt", "b\n")
	runGit(t, dir, "commit", "--no-gpg-sign", "-qam", "Try a new layout")
	tip := gitOutput(t, dir, "rev-parse", "HEAD")

	runGit(t, dir, "checkout", "-q", main)
	runGit(t, dir, "branch", "merged-into-main", "spike~1")
	runGit(t, dir, "checkout", "-q", "-b", "elsewhere", main)

	got := mustInspect(t, dir, "spike")
	want := BranchInspection{Tip: tip, Subject: "Try a new layout", Unique: 1}
	if *got != want {
		t.Errorf("InspectBranch(spike) = %+v, want %+v", *got, want)
	}

	if got := mustInspect(t, dir, "merged-into-main"); got.Unique != 0 {
		t.Errorf("merged-into-main Unique = %d, want 0 (spike still reaches it)", got.Unique)
	}
	// main sits under every other branch, and is checked out nowhere but
	// could still be inspected from here.
	if got := mustInspect(t, dir, main); got.Unique != 0 {
		t.Errorf("%s Unique = %d, want 0", main, got.Unique)
	}
}

// A branch whose commits are only on its remote-tracking ref loses nothing,
// and the remote side is named so the confirm can say it stays.
func TestInspectBranch_Upstream(t *testing.T) {
	dir, cleanup := setupTestRepoWithCommit(t)
	defer cleanup()
	remote, remoteCleanup := setupBareRemote(t)
	defer remoteCleanup()
	runGit(t, dir, "remote", "add", "origin", remote)
	main := mainBranch(t, dir)

	runGit(t, dir, "checkout", "-q", "-b", "published")
	commitAt(t, dir, "published work", time.Now())
	runGit(t, dir, "push", "-q", "-u", "origin", "published")
	runGit(t, dir, "checkout", "-q", main)

	got := mustInspect(t, dir, "published")
	if got.Unique != 0 || got.Upstream != "origin/published" {
		t.Errorf("InspectBranch(published) = %+v, want 0 unique and upstream origin/published", *got)
	}

	// Configured but never fetched — or pruned since — is no copy at all.
	runGit(t, dir, "update-ref", "-d", "refs/remotes/origin/published")
	got = mustInspect(t, dir, "published")
	if got.Unique != 1 || got.Upstream != "" {
		t.Errorf("InspectBranch(published) after prune = %+v, want 1 unique and no upstream", *got)
	}
}

// for-each-ref matches refs below its pattern too; inspecting a name that is
// only a prefix of real branches must not report one of them.
func TestInspectBranch_Missing(t *testing.T) {
	dir, cleanup := setupTestRepoWithCommit(t)
	defer cleanup()
	runGit(t, dir, "branch", "feature/x")

	if _, err := InspectBranch(dir, "feature"); !errors.Is(err, ErrBranchNotFound) {
		t.Errorf("InspectBranch(feature) error = %v, want ErrBranchNotFound", err)
	}
}

func TestDeleteBranch(t *testing.T) {
	dir, cleanup := setupTestRepoWithCommit(t)
	defer cleanup()
	runGit(t, dir, "checkout", "-q", "-b", "spike")
	commitAt(t, dir, "spike work", time.Now())
	runGit(t, dir, "config", "branch.spike.remote", "origin")
	runGit(t, dir, "checkout", "-q", "-")

	tip := mustInspect(t, dir, "spike").Tip
	if err := DeleteBranch(dir, "spike", tip); err != nil {
		t.Fatalf("DeleteBranch() error: %v", err)
	}
	if branchExists(t, dir, "spike") {
		t.Error("spike still exists")
	}
	// As from the command line: the branch's config goes with it.
	if _, err := execGit(dir, "config", "branch.spike.remote"); err == nil {
		t.Error("branch.spike.remote survived the delete")
	}
}

// Something committed to the branch between inspect and confirm: those
// commits were never counted, so nothing is deleted.
func TestDeleteBranch_RefusesMovedTip(t *testing.T) {
	dir, cleanup := setupTestRepoWithCommit(t)
	defer cleanup()
	runGit(t, dir, "branch", "spike")
	tip := mustInspect(t, dir, "spike").Tip

	runGit(t, dir, "checkout", "-q", "spike")
	commitAt(t, dir, "late work", time.Now())
	runGit(t, dir, "checkout", "-q", "-")

	if err := DeleteBranch(dir, "spike", tip); !errors.Is(err, ErrBranchChanged) {
		t.Fatalf("DeleteBranch() error = %v, want ErrBranchChanged", err)
	}
	if !branchExists(t, dir, "spike") {
		t.Error("spike was deleted despite having moved")
	}
}

// The server refuses what the UI hides: the current branch, and a branch
// another worktree has checked out.
func TestDeleteBranch_RefusesCheckedOut(t *testing.T) {
	dir, cleanup := setupTestRepoWithCommit(t)
	defer cleanup()
	main := mainBranch(t, dir)
	runGit(t, dir, "branch", "topic")
	linked := filepath.Join(filepath.Dir(dir), filepath.Base(dir)+"-linked")
	runGit(t, dir, "worktree", "add", "-q", linked, "topic")
	defer os.RemoveAll(linked)

	tests := []struct {
		branch       string
		wantWorktree string
	}{
		{main, ""},
		{"topic", filepath.Base(linked)},
	}
	for _, tt := range tests {
		t.Run(tt.branch, func(t *testing.T) {
			err := DeleteBranch(dir, tt.branch, gitOutput(t, dir, "rev-parse", tt.branch))
			var checkedOut *BranchCheckedOutError
			if !errors.As(err, &checkedOut) {
				t.Fatalf("DeleteBranch() error = %v, want BranchCheckedOutError", err)
			}
			if checkedOut.Worktree != tt.wantWorktree {
				t.Errorf("Worktree = %q, want %q", checkedOut.Worktree, tt.wantWorktree)
			}
			if !branchExists(t, dir, tt.branch) {
				t.Errorf("%s was deleted", tt.branch)
			}
		})
	}
}

// A branch deleted elsewhere since the inspect is not "changed", and says so.
func TestDeleteBranch_Gone(t *testing.T) {
	dir, cleanup := setupTestRepoWithCommit(t)
	defer cleanup()
	runGit(t, dir, "branch", "spike")
	tip := mustInspect(t, dir, "spike").Tip
	runGit(t, dir, "branch", "-D", "spike")

	if err := DeleteBranch(dir, "spike", tip); !errors.Is(err, ErrBranchNotFound) {
		t.Fatalf("DeleteBranch() error = %v, want ErrBranchNotFound", err)
	}
}

// The tip is compared as a string, so an abbreviation is refused as a bad
// request rather than reported as a branch that moved.
func TestDeleteBranch_RefusesAbbreviatedTip(t *testing.T) {
	dir, cleanup := setupTestRepoWithCommit(t)
	defer cleanup()
	runGit(t, dir, "branch", "spike")
	tip := mustInspect(t, dir, "spike").Tip

	if err := DeleteBranch(dir, "spike", tip[:7]); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("DeleteBranch() error = %v, want ErrInvalidArgument", err)
	}
	if !branchExists(t, dir, "spike") {
		t.Error("spike was deleted")
	}
}
