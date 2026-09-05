package git

import (
	"fmt"
	"path/filepath"
	"sort"
	"strings"
)

// HeadInfo describes what HEAD points at.
type HeadInfo struct {
	Branch   string `json:"branch"` // empty while detached
	Hash     string `json:"hash"`   // abbreviated; empty before the first commit
	Detached bool   `json:"detached"`
	// Message is the message of the commit HEAD points at, empty before the
	// first commit. Amend prefills the sheet with it and quotes its first line,
	// so it is read from git rather than rebuilt out of the panel's parsed log:
	// a rebuilt message guesses at the blank line between subject and body, and
	// an amend would then silently rewrite the message it was meant to keep.
	Message string `json:"message"`
}

// BranchInfo is one local branch.
type BranchInfo struct {
	Name    string `json:"name"`
	Current bool   `json:"current"`
	// Worktree names the other worktree holding this branch, if any. git refuses
	// to check the same branch out twice, so the UI disables such a row instead
	// of letting the user discover the rule through an error.
	Worktree string `json:"worktree,omitempty"`
}

// RemoteBranch is a branch that exists on a remote but not locally.
type RemoteBranch struct {
	Ref  string `json:"ref"`  // "origin/topic", what the UI displays
	Name string `json:"name"` // "topic", what Checkout takes
}

// BranchList is the branch state behind the panel's branch bar and branch sheet.
//
// Sync travels with it rather than in a method of its own: the chip and the
// branch name are one row, and two queries could leave the chip counting a
// branch the bar is no longer showing.
type BranchList struct {
	Head       HeadInfo       `json:"head"`
	Local      []BranchInfo   `json:"local"`
	RemoteOnly []RemoteBranch `json:"remote_only"`
	Sync       SyncInfo       `json:"sync"`
}

// Head reports the branch HEAD is on, or the commit it is detached at.
func Head(dir string) (*HeadInfo, error) {
	// --quiet turns "HEAD is not symbolic" into a plain non-zero exit, which is
	// how a detached HEAD is detected here rather than by matching a message.
	branch, branchErr := execGit(dir, "symbolic-ref", "--quiet", "--short", "HEAD")
	// Fails in a repository without commits, where the branch is named but unborn.
	hash, hashErr := execGit(dir, "rev-parse", "--short", "HEAD")
	if branchErr != nil && hashErr != nil {
		return nil, fmt.Errorf("failed to read HEAD: %w", branchErr)
	}

	head := &HeadInfo{Branch: branch, Hash: hash, Detached: branchErr != nil}
	if hashErr == nil {
		// --no-show-signature because log.showSignature=true makes git print the
		// signature verification ("gpg: Good signature…", or an error when the
		// allowed-signers file is missing) ahead of the format output. That text
		// would become part of the message amend prefills, and committing would
		// then write it into the commit.
		message, err := execGit(dir, "log", "-1", "--no-show-signature", "--format=%B")
		if err != nil {
			return nil, fmt.Errorf("failed to read HEAD message: %w", err)
		}
		head.Message = message
	}

	return head, nil
}

// Branches returns HEAD plus the local and remote-only branches of dir.
func Branches(dir string) (*BranchList, error) {
	head, err := Head(dir)
	if err != nil {
		return nil, err
	}

	// Most recently committed first: in a panel this narrow, the branches worth
	// putting within reach are the ones the user touched last. lstrip=2 drops
	// exactly "refs/heads/", where %(refname:short) would render "heads/main"
	// whenever a tag happens to share the branch's name.
	names, err := execGitLines(dir, "for-each-ref", "--sort=-committerdate", "--format=%(refname:lstrip=2)", "refs/heads")
	if err != nil {
		return nil, err
	}

	occupied, err := worktreeBranches(dir)
	if err != nil {
		return nil, err
	}

	remotes, err := execGitLines(dir, "remote")
	if err != nil {
		return nil, err
	}

	local := make([]BranchInfo, 0, len(names))
	for _, name := range names {
		info := BranchInfo{Name: name, Current: name == head.Branch}
		// A branch lives in at most one worktree, so every entry other than the
		// current branch necessarily belongs to a different one.
		if !info.Current {
			info.Worktree = occupied[name]
		}
		local = append(local, info)
	}
	sort.SliceStable(local, func(i, j int) bool { return local[i].Current && !local[j].Current })

	remoteOnly, err := remoteOnlyBranches(dir, names, remotes)
	if err != nil {
		return nil, err
	}

	sync, err := syncInfo(dir, head, remotes)
	if err != nil {
		return nil, err
	}

	return &BranchList{Head: *head, Local: local, RemoteOnly: remoteOnly, Sync: sync}, nil
}

// mainWorktreeLabel names the main checkout in the branch sheet's "in <worktree>"
// hint. Its directory name is the repository's, which the worktree switcher never
// shows: there the main checkout is labelled by its branch, and naming a branch
// after the branch occupying it would say nothing.
const mainWorktreeLabel = "main worktree"

// worktreeBranches maps branch name to the label of the worktree that has it
// checked out, current worktree included.
func worktreeBranches(dir string) (map[string]string, error) {
	output, err := execGit(dir, "worktree", "list", "--porcelain")
	if err != nil {
		return nil, err
	}

	const branchPrefix = "branch refs/heads/"
	result := make(map[string]string)
	var label string
	// git lists the main worktree first, from any worktree of the repository.
	// Linked ones are named by their directory, which is the name the worktree
	// switcher gives them.
	main := true
	for _, line := range strings.Split(output, "\n") {
		switch {
		case strings.HasPrefix(line, "worktree "):
			if main {
				label = mainWorktreeLabel
				main = false
			} else {
				label = filepath.Base(strings.TrimPrefix(line, "worktree "))
			}
		case strings.HasPrefix(line, branchPrefix):
			result[strings.TrimPrefix(line, branchPrefix)] = label
		}
	}
	return result, nil
}

// remoteOnlyBranches lists remote branches that have no local counterpart,
// given the local branch names and the configured remotes.
func remoteOnlyBranches(dir string, localNames []string, remotes []string) ([]RemoteBranch, error) {
	// The result is an empty slice, never nil: it is marshalled straight to the
	// frontend, which filters it, and a JSON null would arrive there as a crash
	// rather than as "no remote branches".
	result := []RemoteBranch{}

	if len(remotes) == 0 {
		return result, nil
	}

	refs, err := execGitLines(dir, "for-each-ref", "--sort=-committerdate", "--format=%(refname)", "refs/remotes")
	if err != nil {
		return nil, err
	}

	byLength := append([]string(nil), remotes...)
	sort.Slice(byLength, func(i, j int) bool { return len(byLength[i]) > len(byLength[j]) })

	locals := make(map[string]bool, len(localNames))
	for _, name := range localNames {
		locals[name] = true
	}

	seen := make(map[string]bool)
	for _, ref := range refs {
		short, name, ok := splitRemoteRef(ref, byLength)
		// "origin/HEAD" is a symbolic ref aliasing the remote's default branch,
		// not a branch of its own.
		if !ok || name == "HEAD" || locals[name] || seen[name] {
			continue
		}
		seen[name] = true
		result = append(result, RemoteBranch{Ref: short, Name: name})
	}
	return result, nil
}

// splitRemoteRef splits "refs/remotes/origin/topic" into "origin/topic" and
// "topic". A remote name may itself contain a slash, so the split is driven by
// the configured remotes rather than by the first "/".
//
// remotes must be ordered longest first: with both "origin" and "origin/fork"
// configured, the shorter name would otherwise claim the other's refs.
func splitRemoteRef(ref string, remotes []string) (short, name string, ok bool) {
	short = strings.TrimPrefix(ref, "refs/remotes/")
	if short == ref {
		return "", "", false
	}

	for _, remote := range remotes {
		if rest := strings.TrimPrefix(short, remote+"/"); rest != short {
			return short, rest, true
		}
	}
	return "", "", false
}

// Checkout switches dir to branch. A name that exists only on a remote becomes
// a local tracking branch through git's own DWIM rule.
//
// Uncommitted changes are carried over, never stashed: Pockode worktrees share
// one stash stack with the main checkout and each other, so a stash nobody asked
// for can be popped by an unrelated session. When git refuses the switch, its
// message names the offending files and CommandError passes it through intact.
func Checkout(dir, branch string) error {
	if err := validateBranchName(branch); err != nil {
		return err
	}

	// The trailing "--" marks branch as a ref, so a file of the same name cannot
	// turn the switch into a file restore.
	_, err := execGit(dir, "checkout", branch, "--")
	return err
}

// CreateBranch creates a branch at the current HEAD and switches to it.
func CreateBranch(dir, name string) error {
	if err := validateBranchName(name); err != nil {
		return err
	}

	_, err := execGit(dir, "checkout", "-b", name, "--")
	return err
}

// validateBranchName rejects names git would read as an option before reading
// them as a ref. Every other rule is left to git, whose own message names the
// offending character more precisely than a reimplementation could.
func validateBranchName(name string) error {
	if name == "" {
		return fmt.Errorf("branch name is empty")
	}
	if strings.HasPrefix(name, "-") {
		return fmt.Errorf("branch name cannot start with '-'")
	}
	return nil
}
