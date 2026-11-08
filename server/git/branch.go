package git

import (
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
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
	// to check the same branch out twice, so the UI offers no switch to such a
	// branch instead of letting the user discover the rule through an error.
	Worktree    string    `json:"worktree,omitempty"`
	CommittedAt time.Time `json:"committed_at"`
	// Committer is the committer of the last commit, not its author: it pairs
	// with CommittedAt, which is the committer date.
	Committer string `json:"committer"`
	// Upstream is the configured upstream as displayed ("origin/topic"); empty
	// when none is configured.
	Upstream string `json:"upstream,omitempty"`
	// UpstreamGone marks an Upstream whose ref is not among the listed refs:
	// SyncInfo.UpstreamGone, for every branch.
	UpstreamGone bool `json:"upstream_gone,omitempty"`
	// VsDefault is absent on the default branch itself, in a repository with no
	// default branch, and where the count was not taken (see divergences).
	VsDefault *Divergence `json:"vs_default,omitempty"`
}

// RemoteBranch is a branch that exists on a remote but not locally.
type RemoteBranch struct {
	Ref         string      `json:"ref"`  // "origin/topic", what the UI displays
	Name        string      `json:"name"` // "topic", what Checkout takes
	CommittedAt time.Time   `json:"committed_at"`
	Committer   string      `json:"committer"`            // as on BranchInfo
	VsDefault   *Divergence `json:"vs_default,omitempty"` // as on BranchInfo
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
	// DefaultBranch is what the vs_default counts are taken against, as
	// displayed ("main", or "origin/main" when there is no local one); empty when
	// the repository has none.
	DefaultBranch string `json:"default_branch"`
	// Recent names the local branches most recently checked out in this
	// worktree, latest first; the current branch, when HEAD is on one with a
	// commit, is always the first.
	Recent []string `json:"recent"`
}

// Head reports the branch HEAD is on, or the commit it is detached at.
func Head(dir string) (*HeadInfo, error) {
	// --quiet turns "HEAD is not symbolic" into a plain non-zero exit, which is
	// how a detached HEAD is detected here rather than by matching a message.
	branch, branchErr := headBranch(dir)
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

// headBranch is the branch HEAD points at, failing as `git symbolic-ref
// --quiet` does when HEAD is detached. The ref is stripped by hand because
// --short renders "heads/main" whenever a tag shares the branch's name, and the
// name is compared against the branch list's.
func headBranch(dir string) (string, error) {
	ref, err := execGit(dir, "symbolic-ref", "--quiet", "HEAD")
	if err != nil {
		return "", err
	}
	return strings.TrimPrefix(ref, "refs/heads/"), nil
}

// ErrDetachedHead is CurrentBranch in a worktree whose HEAD is on no branch.
var ErrDetachedHead = errors.New("HEAD is detached")

// CurrentBranch returns the branch HEAD is on, named even before its first
// commit. Unlike Head it reads nothing else, so a caller that needs only the
// name is not failed by a log it never asked for.
func CurrentBranch(dir string) (string, error) {
	branch, err := headBranch(dir)
	// --quiet makes "HEAD is not symbolic" exit 1 and silent; everything else
	// that can go wrong (no repository, no git) is fatal and exits otherwise.
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) && exitErr.ExitCode() == 1 {
		return "", ErrDetachedHead
	}
	return branch, err
}

// Branches returns HEAD plus the local and remote-only branches of dir.
//
// The number of git processes does not grow with the number of branches (on a
// git with %(ahead-behind), see divergences): a large repository has hundreds
// of remote branches, and this runs on every refresh of the panel.
func Branches(dir string) (*BranchList, error) {
	head, err := Head(dir)
	if err != nil {
		return nil, err
	}

	refs, err := branchRefs(dir)
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

	base := defaultBranchRef(refs, remotes)
	var counts map[string]Divergence
	if base != nil {
		names := make([]string, len(refs))
		for i, r := range refs {
			names[i] = r.ref
		}
		// By object id, not by name: a ref name may contain ")", which would end
		// the %(ahead-behind:) atom early. The id also pins the counts to the
		// commit the listing saw.
		if counts, err = divergences(dir, base.hash, names); err != nil {
			return nil, err
		}
	}
	var baseRef string
	if base != nil {
		baseRef = base.ref
	}
	vsDefault := func(ref string) *Divergence {
		d, ok := counts[ref]
		if !ok || ref == baseRef {
			return nil
		}
		return &d
	}

	// Read off the listed refs rather than with a `rev-parse --verify` per
	// branch, as syncInfo does for the current one; the two agree, since
	// branchRefs already leaves out a ref that is not a commit.
	listed := make(map[string]bool, len(refs))
	for _, r := range refs {
		listed[r.ref] = true
	}

	var names []string
	local := []BranchInfo{}
	for _, r := range refs {
		name, ok := strings.CutPrefix(r.ref, "refs/heads/")
		if !ok {
			continue
		}
		names = append(names, name)
		info := BranchInfo{
			Name:        name,
			Current:     name == head.Branch,
			CommittedAt: r.committedAt,
			Committer:   r.committer,
			VsDefault:   vsDefault(r.ref),
		}
		if r.upstream != "" {
			info.Upstream = shortBranchRef(r.upstream)
			info.UpstreamGone = !listed[r.upstream]
		}
		// A branch lives in at most one worktree, so every entry other than the
		// current branch necessarily belongs to a different one.
		if !info.Current {
			info.Worktree = occupied[name]
		}
		local = append(local, info)
	}
	sort.SliceStable(local, func(i, j int) bool { return local[i].Current && !local[j].Current })

	remoteOnly := remoteOnlyBranches(refs, names, remotes)
	for i := range remoteOnly {
		remoteOnly[i].VsDefault = vsDefault("refs/remotes/" + remoteOnly[i].Ref)
	}

	recent := []string{}
	// An unborn HEAD cannot be resolved, and `log -g HEAD` fails rather than
	// print nothing.
	if head.Hash != "" {
		if recent, err = recentBranches(dir, head.Branch, names); err != nil {
			return nil, err
		}
	}

	sync, err := syncInfo(dir, head, remotes)
	if err != nil {
		return nil, err
	}

	return &BranchList{
		Head:          *head,
		Local:         local,
		RemoteOnly:    remoteOnly,
		Sync:          sync,
		DefaultBranch: shortBranchRef(baseRef),
		Recent:        recent,
	}, nil
}

// branchRef is one ref under refs/heads or refs/remotes.
type branchRef struct {
	ref         string // full name, "refs/heads/topic"
	hash        string
	committedAt time.Time
	committer   string
	upstream    string // full name, empty when none is configured
	symref      string // the target of a symbolic ref such as origin/HEAD
}

// branchRefs lists local and remote-tracking branches, most recently committed
// first: in a panel this narrow, the branches worth putting within reach are the
// ones the user touched last.
//
// Not %(upstream:track): it would say "[gone]", but by counting ahead/behind
// against every branch's upstream, a history walk per branch.
func branchRefs(dir string) ([]branchRef, error) {
	lines, err := execGitLines(dir, "for-each-ref", "--sort=-committerdate",
		"--format=%(refname)%09%(objectname)%09%(committerdate:unix)%09%(committername)%09%(upstream)%09%(symref)",
		"refs/heads", "refs/remotes")
	if err != nil {
		return nil, err
	}

	refs := make([]branchRef, 0, len(lines))
	for _, line := range lines {
		// Trailing empty fields may be missing rather than empty: the output is
		// trimmed as a whole, which takes the last line's trailing tabs with it.
		fields := strings.SplitN(line, "\t", 6)
		if len(fields) < 2 {
			return nil, fmt.Errorf("unexpected for-each-ref output: %q", line)
		}
		fields = append(fields, "", "", "", "")[:6]
		// No committer date means the ref points at something other than a
		// commit — a tag object, which a refspec mapping tags under refs/remotes
		// puts there. It is not a branch, and has nothing to switch to.
		if fields[2] == "" {
			continue
		}
		unix, err := strconv.ParseInt(fields[2], 10, 64)
		if err != nil {
			return nil, fmt.Errorf("unexpected for-each-ref output: %q", line)
		}
		refs = append(refs, branchRef{
			ref:         fields[0],
			hash:        fields[1],
			committedAt: time.Unix(unix, 0),
			committer:   fields[3],
			upstream:    fields[4],
			symref:      fields[5],
		})
	}
	return refs, nil
}

// defaultBranchRef picks the ref branches are counted against, nil when there
// is none.
//
// The name is the remote's default (origin/HEAD) when one has been recorded,
// else main or master. The local branch of that name wins over the
// remote-tracking one: it is the branch work is merged into here, and the one a
// count against would stay meaningful between fetches.
func defaultBranchRef(refs []branchRef, remotes []string) *branchRef {
	// The same remote push publishes to: origin by git's convention, or the only
	// one there is.
	var remote string
	switch {
	case contains(remotes, "origin"):
		remote = "origin"
	case len(remotes) == 1:
		remote = remotes[0]
	}
	remotePrefix := "refs/remotes/" + remote + "/"

	byName := make(map[string]*branchRef, len(refs))
	candidates := []string{"main", "master"}
	for i, r := range refs {
		byName[r.ref] = &refs[i]
		if remote != "" && r.ref == remotePrefix+"HEAD" {
			if name, ok := strings.CutPrefix(r.symref, remotePrefix); ok {
				// Still falling back: origin/HEAD can outlive the branch it names.
				candidates = []string{name, "main", "master"}
			}
		}
	}

	for _, name := range candidates {
		if r, ok := byName["refs/heads/"+name]; ok {
			return r
		}
		if r, ok := byName[remotePrefix+name]; ok && remote != "" {
			return r
		}
	}
	return nil
}

// shortBranchRef is the displayed form of a full branch ref: "main" or
// "origin/main".
func shortBranchRef(ref string) string {
	if name, ok := strings.CutPrefix(ref, "refs/heads/"); ok {
		return name
	}
	return strings.TrimPrefix(ref, "refs/remotes/")
}

// recentReflogDepth bounds how far back the HEAD reflog is read for recent
// branches. Entries are a line each, so this is cheap, and a branch not checked
// out within this many HEAD moves is not recent.
const recentReflogDepth = "1000"

// recentBranches lists the current branch, then the existing local branches
// HEAD has moved to or from with a checkout or switch, latest first.
//
// The reflog of HEAD is per worktree, so this is what was worked on here — which
// is what "recent" in this workspace's branch list should mean. The current
// branch is put first rather than found there: a clone or a `git worktree add`,
// which is how Pockode makes worktrees, starts the reflog with no checkout entry.
func recentBranches(dir, current string, localNames []string) ([]string, error) {
	// --no-show-signature for the reason Head gives: log.showSignature would mix
	// verification output into the lines parsed here.
	lines, err := execGitLines(dir, "log", "-g", "--no-show-signature", "--format=%gs", "-n", recentReflogDepth, "HEAD")
	if err != nil {
		return nil, err
	}

	exists := make(map[string]bool, len(localNames))
	for _, name := range localNames {
		exists[name] = true
	}

	result := []string{}
	seen := make(map[string]bool)
	add := func(name string) {
		// Also rules out the commit hash a detached checkout moved to or from.
		if exists[name] && !seen[name] {
			seen[name] = true
			result = append(result, name)
		}
	}
	add(current)
	for _, line := range lines {
		// git switch writes the same message. Branch names cannot contain a
		// space, so " to " splits it unambiguously.
		moved, ok := strings.CutPrefix(line, "checkout: moving from ")
		if !ok {
			continue
		}
		from, to, ok := strings.Cut(moved, " to ")
		if !ok {
			continue
		}
		add(to)
		add(from)
	}
	return result, nil
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
// given the listed refs, the local branch names and the configured remotes.
func remoteOnlyBranches(refs []branchRef, localNames []string, remotes []string) []RemoteBranch {
	// The result is an empty slice, never nil: it is marshalled straight to the
	// frontend, which filters it, and a JSON null would arrive there as a crash
	// rather than as "no remote branches".
	result := []RemoteBranch{}

	if len(remotes) == 0 {
		return result
	}

	byLength := append([]string(nil), remotes...)
	sort.Slice(byLength, func(i, j int) bool { return len(byLength[i]) > len(byLength[j]) })

	locals := make(map[string]bool, len(localNames))
	for _, name := range localNames {
		locals[name] = true
	}

	seen := make(map[string]bool)
	for _, r := range refs {
		short, name, ok := splitRemoteRef(r.ref, byLength)
		// "origin/HEAD" is a symbolic ref aliasing the remote's default branch,
		// not a branch of its own.
		if !ok || name == "HEAD" || locals[name] || seen[name] {
			continue
		}
		seen[name] = true
		result = append(result, RemoteBranch{Ref: short, Name: name, CommittedAt: r.committedAt, Committer: r.committer})
	}
	return result
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
	return withLock(dir, opCheckout, func() error {
		if err := refuseDuringOperation(dir, "switch branches"); err != nil {
			return err
		}
		_, err := execGit(dir, "checkout", branch, "--")
		return err
	})
}

// CreateBranch creates a branch at start, or at the current HEAD when start is
// empty, and switches to it.
func CreateBranch(dir, name, start string) error {
	if err := validateBranchName(name); err != nil {
		return err
	}
	args := []string{"checkout", "-b", name}
	if start != "" {
		if err := validateFullHash(start); err != nil {
			return fmt.Errorf("%w: %w", ErrInvalidArgument, err)
		}
		args = append(args, start)
	}

	return withLock(dir, opBranchCreate, func() error {
		if err := refuseDuringOperation(dir, "create a branch"); err != nil {
			return err
		}
		_, err := execGit(dir, append(args, "--")...)
		return err
	})
}

// validateBranchName rejects names git would read as an option before reading
// them as a ref. Every other rule is left to git, whose own message names the
// offending character more precisely than a reimplementation could. Its
// refusals are ErrInvalidArgument: git never ran.
func validateBranchName(name string) error {
	if name == "" {
		return fmt.Errorf("%w: branch name is empty", ErrInvalidArgument)
	}
	if strings.HasPrefix(name, "-") {
		return fmt.Errorf("%w: branch name cannot start with '-'", ErrInvalidArgument)
	}
	return nil
}
