package git

import (
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// BranchInspection is what deleting a local branch would cost, read when the
// user asks to delete it and before they confirm.
type BranchInspection struct {
	// Tip is the full hash the branch points at. DeleteBranch takes it back
	// whole: an abbreviation can turn ambiguous between the two requests.
	Tip     string `json:"tip"`
	Subject string `json:"subject"`
	// Unique counts the commits on the branch that no other local branch and
	// no remote-tracking ref reaches — the commits deleting it loses. Zero is
	// what "merged" means here (docs/git-branches-ui.md#what-merged-means-here).
	Unique int `json:"unique"`
	// Upstream is the branch's remote-tracking upstream ("origin/topic") when
	// one is configured and its ref exists, so that something does stay on the
	// remote; empty otherwise.
	Upstream string `json:"upstream,omitempty"`
}

// ErrBranchChanged is DeleteBranch refusing a branch that no longer points at
// the tip the user confirmed deleting: the count they agreed to was a count of
// that tip's commits.
var ErrBranchChanged = errors.New("the branch has changed since it was inspected")

// ErrBranchNotFound is InspectBranch or DeleteBranch given a local branch that
// does not exist — in practice one deleted or renamed since the list was read.
var ErrBranchNotFound = errors.New("no such local branch")

// fullHash is a whole object name, SHA-1 or SHA-256. DeleteBranch compares the
// tip as a string, so an abbreviation would read as a branch that moved.
var fullHash = regexp.MustCompile(`^(?:[0-9a-f]{40}|[0-9a-f]{64})$`)

// BranchCheckedOutError refuses deleting a branch that a worktree, this one
// included, has checked out. git refuses it too; the check is here so the
// refusal names the worktree in the panel's words rather than by path.
type BranchCheckedOutError struct {
	Branch string
	// Worktree labels the other worktree holding it, as BranchInfo.Worktree
	// does; empty when it is this worktree's current branch.
	Worktree string
}

func (e *BranchCheckedOutError) Error() string {
	if e.Worktree == "" {
		return fmt.Sprintf("%s is the current branch", e.Branch)
	}
	return fmt.Sprintf("%s is checked out in %s", e.Branch, e.Worktree)
}

// InspectBranch reports what deleting the local branch name would lose.
func InspectBranch(dir, name string) (*BranchInspection, error) {
	if err := validateBranchName(name); err != nil {
		return nil, err
	}

	ref := "refs/heads/" + name
	// for-each-ref rather than rev-parse: it reads tip, subject and upstream in
	// one process. A pattern also matches refs below it, so the exact ref is
	// picked out of what comes back.
	lines, err := execGitLines(dir, "for-each-ref", "--format=%(refname)%00%(objectname)%00%(upstream)%00%(subject)", ref)
	if err != nil {
		return nil, err
	}
	var fields []string
	for _, line := range lines {
		if f := strings.SplitN(line, "\x00", 4); len(f) == 4 && f[0] == ref {
			fields = f
			break
		}
	}
	if fields == nil {
		return nil, fmt.Errorf("%w: %s", ErrBranchNotFound, name)
	}

	// --exclude before --branches takes the name relative to refs/heads/; with
	// the prefix it would exclude nothing and every branch would reach itself.
	count, err := execGit(dir, "rev-list", "--count", fields[1], "--not", "--exclude="+name, "--branches", "--remotes")
	if err != nil {
		return nil, err
	}
	unique, err := strconv.Atoi(count)
	if err != nil {
		return nil, fmt.Errorf("unexpected rev-list count %q: %w", count, err)
	}

	result := &BranchInspection{Tip: fields[1], Subject: fields[3], Unique: unique}
	// %(upstream) is the configured upstream whether or not it was ever fetched,
	// and may be another local branch; only an existing remote-tracking ref is
	// something that stays on the remote.
	if upstream, ok := strings.CutPrefix(fields[2], "refs/remotes/"); ok {
		if _, err := execGit(dir, "rev-parse", "--verify", "--quiet", fields[2]); err == nil {
			result.Upstream = upstream
		}
	}
	return result, nil
}

// DeleteBranch deletes the local branch name, but only while it still points
// at tip — the commit InspectBranch counted. It is --force-with-lease's rule
// applied to a local ref: deleting whatever the branch holds now would delete
// commits nobody was told about.
//
// The check and the delete are not atomic against a process outside the
// server; see docs/git.md#deleting-a-branch for the window that leaves.
func DeleteBranch(dir, name, tip string) error {
	if err := validateBranchName(name); err != nil {
		return err
	}
	if !fullHash.MatchString(tip) {
		return fmt.Errorf("%w: tip %q is not a full commit hash", ErrInvalidArgument, tip)
	}

	return withLock(dir, opBranchDelete, func() error {
		// During a rebase the branch being rebased is checked out nowhere by
		// worktree list's reckoning, yet git refuses to delete it; refusing
		// every operation, as checkout does, covers it without a special case.
		if err := refuseDuringOperation(dir, "delete a branch"); err != nil {
			return err
		}

		current, err := CurrentBranch(dir)
		if err != nil && !errors.Is(err, ErrDetachedHead) {
			return err
		}
		if current == name {
			return &BranchCheckedOutError{Branch: name}
		}
		occupied, err := worktreeBranches(dir)
		if err != nil {
			return err
		}
		if label, ok := occupied[name]; ok {
			return &BranchCheckedOutError{Branch: name, Worktree: label}
		}

		at, err := execGit(dir, "rev-parse", "--verify", "--quiet", "refs/heads/"+name)
		if err != nil {
			return fmt.Errorf("%w: %s", ErrBranchNotFound, name)
		}
		if at != tip {
			return ErrBranchChanged
		}

		// branch -D rather than update-ref -d, so the branch's config section
		// goes with it as it would from the command line.
		_, err = execGit(dir, "branch", "-D", name)
		return err
	})
}
