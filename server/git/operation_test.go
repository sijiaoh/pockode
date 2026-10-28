package git

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"
)

// setupDivergedRepo is a repository whose `feature` branch changes conflict.txt
// twice and whose main branch changes it once, so merging, rebasing,
// cherry-picking or reverting across the two stops on a conflict. Returned are
// the main branch's name and the hashes of the commits involved.
func setupDivergedRepo(t *testing.T) (dir, main string, commits divergedCommits) {
	t.Helper()
	dir, cleanup := setupTestRepo(t)
	t.Cleanup(cleanup)
	// No editor anywhere: an operation that wanted one would hang the test.
	runGit(t, dir, "config", "core.editor", "true")

	writeTestFile(t, dir, "conflict.txt", "base\n")
	runGit(t, dir, "add", "conflict.txt")
	runGit(t, dir, "commit", "--no-gpg-sign", "-m", "base")
	main = mainBranch(t, dir)

	runGit(t, dir, "checkout", "-q", "-b", "feature")
	writeTestFile(t, dir, "conflict.txt", "feature one\n")
	runGit(t, dir, "commit", "--no-gpg-sign", "-qam", "feature one")
	commits.featureOne = gitOutput(t, dir, "rev-parse", "HEAD")
	writeTestFile(t, dir, "conflict.txt", "feature two\n")
	runGit(t, dir, "commit", "--no-gpg-sign", "-qam", "feature two")
	commits.featureTwo = gitOutput(t, dir, "rev-parse", "HEAD")

	runGit(t, dir, "checkout", "-q", main)
	writeTestFile(t, dir, "conflict.txt", "main\n")
	runGit(t, dir, "commit", "--no-gpg-sign", "-qam", "main")
	commits.main = gitOutput(t, dir, "rev-parse", "HEAD")
	return dir, main, commits
}

type divergedCommits struct {
	featureOne, featureTwo, main string
}

// gitConflicts runs a git command that is expected to stop on a conflict, and
// so to exit non-zero.
func gitConflicts(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-c", "commit.gpgSign=false"}, args...)...)
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err == nil {
		t.Fatalf("git %v succeeded, want it to stop on a conflict\n%s", args, out)
	}
}

func mustStatus(t *testing.T, dir string) *GitStatus {
	t.Helper()
	status, err := Status(dir)
	if err != nil {
		t.Fatalf("Status() error: %v", err)
	}
	return status
}

func TestStatus_Operation(t *testing.T) {
	tests := []struct {
		name string
		// start leaves the repository in the middle of an operation and returns
		// what Status should report about it.
		start func(t *testing.T, dir, main string, c divergedCommits) *Operation
	}{
		{
			name: "merge",
			start: func(t *testing.T, dir, main string, c divergedCommits) *Operation {
				gitConflicts(t, dir, "merge", "feature")
				return &Operation{
					Kind:   OperationMerge,
					Commit: &OperationCommit{Hash: c.featureTwo, Subject: "feature two", Ref: "feature"},
				}
			},
		},
		{
			name: "rebase",
			start: func(t *testing.T, dir, main string, c divergedCommits) *Operation {
				runGit(t, dir, "checkout", "-q", "feature")
				gitConflicts(t, dir, "rebase", main)
				return &Operation{
					Kind:   OperationRebase,
					Commit: &OperationCommit{Hash: c.featureOne, Subject: "feature one"},
					Branch: "feature",
					Onto:   &OperationCommit{Hash: c.main, Subject: "main", Ref: main},
					Step:   &OperationStep{Current: 1, Total: 2},
				}
			},
		},
		{
			name: "interactive rebase",
			start: func(t *testing.T, dir, main string, c divergedCommits) *Operation {
				runGit(t, dir, "checkout", "-q", "feature")
				gitConflicts(t, dir, "-c", "sequence.editor=true", "rebase", "-i", main)
				return &Operation{
					Kind:   OperationRebase,
					Commit: &OperationCommit{Hash: c.featureOne, Subject: "feature one"},
					Branch: "feature",
					Onto:   &OperationCommit{Hash: c.main, Subject: "main", Ref: main},
					Step:   &OperationStep{Current: 1, Total: 2},
				}
			},
		},
		{
			// The apply backend keeps the same facts in rebase-apply, under
			// other names.
			name: "rebase with the apply backend",
			start: func(t *testing.T, dir, main string, c divergedCommits) *Operation {
				runGit(t, dir, "checkout", "-q", "feature")
				gitConflicts(t, dir, "rebase", "--apply", main)
				return &Operation{
					Kind:   OperationRebase,
					Commit: &OperationCommit{Hash: c.featureOne, Subject: "feature one"},
					Branch: "feature",
					Onto:   &OperationCommit{Hash: c.main, Subject: "main", Ref: main},
					Step:   &OperationStep{Current: 1, Total: 2},
				}
			},
		},
		{
			name: "rebase of a detached HEAD",
			start: func(t *testing.T, dir, main string, c divergedCommits) *Operation {
				runGit(t, dir, "checkout", "-q", "--detach", "feature")
				gitConflicts(t, dir, "rebase", main)
				return &Operation{
					Kind:   OperationRebase,
					Commit: &OperationCommit{Hash: c.featureOne, Subject: "feature one"},
					Onto:   &OperationCommit{Hash: c.main, Subject: "main", Ref: main},
					Step:   &OperationStep{Current: 1, Total: 2},
				}
			},
		},
		{
			name: "cherry-pick",
			start: func(t *testing.T, dir, main string, c divergedCommits) *Operation {
				gitConflicts(t, dir, "cherry-pick", "feature")
				return &Operation{
					Kind:   OperationCherryPick,
					Commit: &OperationCommit{Hash: c.featureTwo, Subject: "feature two", Ref: "feature"},
				}
			},
		},
		{
			// The commit that stopped the sequence was resolved and committed by
			// hand, which ends that pick; the rest of the sequence still waits.
			name: "cherry-pick sequence between two commits",
			start: func(t *testing.T, dir, main string, c divergedCommits) *Operation {
				gitConflicts(t, dir, "cherry-pick", c.featureOne, c.featureTwo)
				writeTestFile(t, dir, "conflict.txt", "resolved\n")
				runGit(t, dir, "add", "conflict.txt")
				runGit(t, dir, "commit", "--no-gpg-sign", "-m", "resolved")
				return &Operation{Kind: OperationCherryPick}
			},
		},
		{
			name: "revert",
			start: func(t *testing.T, dir, main string, c divergedCommits) *Operation {
				runGit(t, dir, "checkout", "-q", "feature")
				gitConflicts(t, dir, "revert", c.featureOne)
				return &Operation{
					Kind:   OperationRevert,
					Commit: &OperationCommit{Hash: c.featureOne, Subject: "feature one"},
				}
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir, main, commits := setupDivergedRepo(t)
			want := tt.start(t, dir, main, commits)

			status := mustStatus(t, dir)
			if !reflect.DeepEqual(status.Operation, want) {
				t.Errorf("Operation = %s, want %s", describeOperation(status.Operation), describeOperation(want))
			}
		})
	}
}

func describeOperation(op *Operation) string {
	if op == nil {
		return "<nil>"
	}
	return fmt.Sprintf("{kind=%s commit=%+v onto=%+v branch=%q step=%+v}", op.Kind, op.Commit, op.Onto, op.Branch, op.Step)
}

func TestStatus_NoOperation(t *testing.T) {
	dir, _, _ := setupDivergedRepo(t)

	status := mustStatus(t, dir)
	if status.Operation != nil {
		t.Errorf("Operation = %s, want none", describeOperation(status.Operation))
	}
	if status.Conflicted != nil {
		t.Errorf("Conflicted = %v, want none", status.Conflicted)
	}
}

// A branch or tag named after an operation's ref is not that operation: git
// resolves the bare name to it only when the ref itself is absent.
func TestStatus_RefsNamedLikeOperationHeads(t *testing.T) {
	dir, _, _ := setupDivergedRepo(t)
	runGit(t, dir, "branch", "MERGE_HEAD")
	runGit(t, dir, "update-ref", "refs/tags/CHERRY_PICK_HEAD", "HEAD")
	runGit(t, dir, "branch", "REVERT_HEAD")

	if op := mustStatus(t, dir).Operation; op != nil {
		t.Errorf("Operation = %s, want none", describeOperation(op))
	}

	// And while one really is in progress, it is still read as such.
	gitConflicts(t, dir, "merge", "feature")
	if op := mustStatus(t, dir).Operation; op == nil || op.Kind != OperationMerge {
		t.Errorf("Operation = %s, want a merge", describeOperation(op))
	}
}

// Conflicts are listed whatever shape git gives them: modified on both sides,
// added on both, and deleted on one side while modified on the other.
func TestStatus_Conflicted(t *testing.T) {
	dir, cleanup := setupTestRepo(t)
	defer cleanup()
	writeTestFile(t, dir, "both.txt", "base\n")
	writeTestFile(t, dir, "deleted.txt", "base\n")
	writeTestFile(t, dir, "clean.txt", "base\n")
	runGit(t, dir, "add", ".")
	runGit(t, dir, "commit", "--no-gpg-sign", "-m", "base")
	main := mainBranch(t, dir)

	runGit(t, dir, "checkout", "-q", "-b", "other")
	writeTestFile(t, dir, "both.txt", "other\n")
	writeTestFile(t, dir, "added.txt", "other\n")
	writeTestFile(t, dir, "deleted.txt", "changed on other\n")
	runGit(t, dir, "add", ".")
	runGit(t, dir, "commit", "--no-gpg-sign", "-m", "other")

	runGit(t, dir, "checkout", "-q", main)
	writeTestFile(t, dir, "both.txt", "main\n")
	writeTestFile(t, dir, "added.txt", "main\n")
	writeTestFile(t, dir, "clean.txt", "changed on main\n")
	runGit(t, dir, "rm", "-q", "deleted.txt")
	runGit(t, dir, "add", ".")
	runGit(t, dir, "commit", "--no-gpg-sign", "-m", "main")

	gitConflicts(t, dir, "merge", "other")

	status := mustStatus(t, dir)
	want := []string{"added.txt", "both.txt", "deleted.txt"}
	if !reflect.DeepEqual(status.Conflicted, want) {
		t.Errorf("Conflicted = %v, want %v", status.Conflicted, want)
	}
}

// In a linked worktree .git is a file and a rebase's state lives in that
// worktree's own git directory: it has to be found there, and only there.
func TestStatus_OperationInLinkedWorktree(t *testing.T) {
	dir, main, commits := setupDivergedRepo(t)
	linked := filepath.Join(t.TempDir(), "linked")
	runGit(t, dir, "worktree", "add", "-q", linked, "feature")

	gitConflicts(t, linked, "rebase", main)

	op := mustStatus(t, linked).Operation
	if op == nil || op.Kind != OperationRebase || op.Branch != "feature" || op.Commit == nil || op.Commit.Hash != commits.featureOne {
		t.Errorf("linked worktree Operation = %s, want the rebase of feature", describeOperation(op))
	}
	if op := mustStatus(t, dir).Operation; op != nil {
		t.Errorf("main checkout Operation = %s, want none: the rebase is the linked worktree's", describeOperation(op))
	}

	if _, err := Abort(linked, OperationRebase); err != nil {
		t.Fatalf("Abort() in the linked worktree: %v", err)
	}
	if got := gitOutput(t, linked, "rev-parse", "HEAD"); got != commits.featureTwo {
		t.Errorf("HEAD after abort = %s, want feature's tip %s", got, commits.featureTwo)
	}
}

func TestAbort(t *testing.T) {
	tests := []struct {
		kind string
		// onFeature: the operation runs on feature, whose tip the abort has
		// to put back; otherwise on main.
		onFeature bool
		start     func(t *testing.T, dir, main string, c divergedCommits)
	}{
		{OperationMerge, false, func(t *testing.T, dir, main string, c divergedCommits) {
			gitConflicts(t, dir, "merge", "feature")
		}},
		{OperationRebase, true, func(t *testing.T, dir, main string, c divergedCommits) {
			runGit(t, dir, "checkout", "-q", "feature")
			gitConflicts(t, dir, "rebase", main)
		}},
		{OperationCherryPick, false, func(t *testing.T, dir, main string, c divergedCommits) {
			gitConflicts(t, dir, "cherry-pick", c.featureOne, c.featureTwo)
		}},
		{OperationRevert, true, func(t *testing.T, dir, main string, c divergedCommits) {
			runGit(t, dir, "checkout", "-q", "feature")
			gitConflicts(t, dir, "revert", c.featureOne)
		}},
	}

	for _, tt := range tests {
		t.Run(tt.kind, func(t *testing.T) {
			dir, main, commits := setupDivergedRepo(t)
			tt.start(t, dir, main, commits)
			wantHead := commits.main
			if tt.onFeature {
				wantHead = commits.featureTwo
			}

			headKept, err := Abort(dir, tt.kind)
			if err != nil {
				t.Fatalf("Abort(%q) error: %v", tt.kind, err)
			}
			if headKept {
				t.Error("Abort() reported the branch kept, want it moved back")
			}

			status := mustStatus(t, dir)
			if status.Operation != nil {
				t.Errorf("Operation after abort = %s, want none", describeOperation(status.Operation))
			}
			if len(status.Conflicted) != 0 || len(status.Staged) != 0 || len(status.Unstaged) != 0 {
				t.Errorf("status after abort = %+v, want a clean tree", status)
			}
			if got := gitOutput(t, dir, "rev-parse", "HEAD"); got != wantHead {
				t.Errorf("HEAD after abort = %s, want %s", got, wantHead)
			}
		})
	}
}

// An abort names the operation the user confirmed; anything else in progress,
// or nothing at all, is refused without running git.
func TestAbort_OperationChanged(t *testing.T) {
	dir, _, _ := setupDivergedRepo(t)

	_, err := Abort(dir, OperationMerge)
	var changed *OperationChangedError
	if !errors.As(err, &changed) || changed.Current != "" {
		t.Fatalf("Abort() with nothing in progress = %v, want OperationChangedError with no current operation", err)
	}

	gitConflicts(t, dir, "merge", "feature")
	_, err = Abort(dir, OperationRebase)
	if !errors.As(err, &changed) || changed.Current != OperationMerge {
		t.Fatalf("Abort(rebase) during a merge = %v, want OperationChangedError naming the merge", err)
	}
	if op := mustStatus(t, dir).Operation; op == nil || op.Kind != OperationMerge {
		t.Errorf("Operation after the refused abort = %s, want the merge still in progress", describeOperation(op))
	}
}

// A sequence whose conflict was resolved with a plain commit has moved HEAD,
// and git's abort then ends the sequence without putting the branch back. That
// has to be reported, not passed off as the rollback the user confirmed.
func TestAbort_SequenceWithMovedHeadKeepsBranch(t *testing.T) {
	for _, kind := range []string{OperationCherryPick, OperationRevert} {
		t.Run(kind, func(t *testing.T) {
			dir, _, c := setupDivergedRepo(t)
			if kind == OperationRevert {
				runGit(t, dir, "checkout", "-q", "feature")
				// Reverting the older commit first conflicts with the newer.
				gitConflicts(t, dir, "revert", c.featureOne, c.featureTwo)
			} else {
				gitConflicts(t, dir, "cherry-pick", c.featureOne, c.featureTwo)
			}
			writeTestFile(t, dir, "conflict.txt", "resolved\n")
			runGit(t, dir, "add", "conflict.txt")
			runGit(t, dir, "commit", "--no-gpg-sign", "-m", "resolved")
			resolved := gitOutput(t, dir, "rev-parse", "HEAD")

			headKept, err := Abort(dir, kind)
			if err != nil {
				t.Fatalf("Abort() error: %v", err)
			}
			if !headKept {
				t.Error("Abort() did not report the branch kept")
			}
			if got := gitOutput(t, dir, "rev-parse", "HEAD"); got != resolved {
				t.Errorf("HEAD after abort = %s, want the resolved commit %s left in place", got, resolved)
			}
			if op := mustStatus(t, dir).Operation; op != nil {
				t.Errorf("Operation after abort = %s, want none", describeOperation(op))
			}
		})
	}
}

func TestSequencerCommand(t *testing.T) {
	tests := []struct {
		name string
		todo string
		want string
	}{
		{"pick", "pick 1a2b3c4 subject\npick 5d6e7f8 other\n", "pick"},
		{"abbreviated pick", "p 1a2b3c4 subject\n", "p"},
		{"revert", "revert 1a2b3c4 subject\n", "revert"},
		{"leading comment and blank line", "# comment\n\nrevert 1a2b3c4 subject\n", "revert"},
		{"empty", "", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "todo")
			if err := os.WriteFile(path, []byte(tt.todo), 0644); err != nil {
				t.Fatal(err)
			}
			if got := sequencerCommand(path); got != tt.want {
				t.Errorf("sequencerCommand() = %q, want %q", got, tt.want)
			}
		})
	}

	if got := sequencerCommand(filepath.Join(t.TempDir(), "missing")); got != "" {
		t.Errorf("sequencerCommand(missing) = %q, want empty", got)
	}
}

// onto is read from the rebase's state file rather than resolved, so a commit
// git cannot find there leaves its subject unknown instead of failing the
// whole status.
func TestStatus_RebaseOntoMissingCommit(t *testing.T) {
	dir, main, _ := setupDivergedRepo(t)
	runGit(t, dir, "checkout", "-q", "feature")
	gitConflicts(t, dir, "rebase", main)
	missing := "0123456789abcdef0123456789abcdef01234567"
	writeTestFile(t, dir, filepath.Join(".git", "rebase-merge", "onto"), missing+"\n")

	op := mustStatus(t, dir).Operation
	if op == nil || op.Onto == nil {
		t.Fatalf("Operation = %s, want a rebase with onto", describeOperation(op))
	}
	if *op.Onto != (OperationCommit{Hash: missing}) {
		t.Errorf("Onto = %+v, want the bare hash", op.Onto)
	}
}

// The writes the workspace pauses during an operation are refused by the
// server too, before git runs, and say which operation is in the way.
func TestWritesRefusedDuringOperation(t *testing.T) {
	tests := []struct {
		name   string
		action string
		write  func(dir string) error
	}{
		{"commit", "commit", func(dir string) error { return CreateCommit(dir, "stray", false) }},
		{"amend", "commit", func(dir string) error { return CreateCommit(dir, "stray", true) }},
		{"checkout", "switch branches", func(dir string) error { return Checkout(dir, "feature") }},
		{"branch create", "create a branch", func(dir string) error { return CreateBranch(dir, "side", "") }},
		{"pull", "pull", func(dir string) error { _, err := Pull(dir); return err }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir, _, _ := setupDivergedRepo(t)
			gitConflicts(t, dir, "merge", "feature")
			before := gitOutput(t, dir, "rev-parse", "HEAD")

			err := tt.write(dir)
			var inProgress *OperationInProgressError
			if !errors.As(err, &inProgress) {
				t.Fatalf("error = %v, want OperationInProgressError", err)
			}
			if inProgress.Kind != OperationMerge || inProgress.Action != tt.action {
				t.Errorf("error = %+v, want merge / %q", inProgress, tt.action)
			}
			if got := gitOutput(t, dir, "rev-parse", "HEAD"); got != before {
				t.Errorf("HEAD moved from %s to %s", before, got)
			}
			if mustStatus(t, dir).Operation == nil {
				t.Error("the merge is no longer in progress")
			}
		})
	}
}

// Without an operation the guard is silent: a commit goes through.
func TestCommitAllowedWithoutOperation(t *testing.T) {
	dir, _, _ := setupDivergedRepo(t)
	writeTestFile(t, dir, "other.txt", "x\n")
	runGit(t, dir, "add", "other.txt")
	if err := CreateCommit(dir, "other", false); err != nil {
		t.Fatalf("CreateCommit() error: %v", err)
	}
}
