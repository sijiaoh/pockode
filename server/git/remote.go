package git

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// SyncInfo is the current branch's standing against its upstream: everything
// the panel's ahead/behind chip and sync sheet render.
type SyncInfo struct {
	// HasRemote is false in a repository with no remote at all, where there is
	// nothing to sync with and the chip has no reason to exist.
	HasRemote bool `json:"has_remote"`
	// Upstream is the tracking branch as displayed ("origin/main"), empty when
	// the branch has none.
	Upstream string `json:"upstream"`
	// UpstreamGone marks an upstream that is configured but whose remote-tracking
	// ref is missing locally — never fetched, or pruned after the remote branch
	// was deleted. The counts below are then unknowable rather than zero, and
	// reporting "in sync" would be a lie.
	UpstreamGone bool `json:"upstream_gone"`
	Ahead        int  `json:"ahead"`
	Behind       int  `json:"behind"`
	// HeadPushed reports whether HEAD is already contained in the upstream ref,
	// which is what makes amending it a rewrite of published history.
	HeadPushed bool `json:"head_pushed"`
	// LastFetch is when this worktree last fetched, nil before its first fetch.
	// Counts are only as fresh as this, so the sheet always shows it: "0 ahead,
	// 0 behind" must not silently stand for "up to date".
	LastFetch *time.Time `json:"last_fetch"`
}

// syncInfo reads the upstream standing of head. remotes is the output of
// "git remote", already read by the caller.
//
// A branch with no upstream is not an error: it is the state the sync sheet
// offers to publish.
func syncInfo(dir string, head *HeadInfo, remotes []string) (SyncInfo, error) {
	info := SyncInfo{HasRemote: len(remotes) > 0}

	lastFetch, err := lastFetchTime(dir)
	if err != nil {
		return info, err
	}
	info.LastFetch = lastFetch

	// A detached HEAD tracks nothing, and neither does a branch in a repository
	// that has no remote to track.
	if !info.HasRemote || head.Branch == "" {
		return info, nil
	}

	ref, short, err := upstreamOf(dir, head.Branch)
	if err != nil {
		return info, err
	}
	if ref == "" {
		return info, nil
	}
	info.Upstream = short

	// The full ref, not the short name: "origin/main" as a revision could also
	// resolve to a local branch of that name.
	if _, err := execGit(dir, "rev-parse", "--verify", "--quiet", ref+"^{commit}"); err != nil {
		info.UpstreamGone = true
		return info, nil
	}

	ahead, behind, err := aheadBehind(dir, "refs/heads/"+head.Branch, ref)
	if err != nil {
		return info, err
	}
	info.Ahead, info.Behind = ahead, behind
	// Contained in the upstream is exactly "nothing of ours is missing from it".
	info.HeadPushed = ahead == 0

	return info, nil
}

// upstreamOf returns the full and short forms of branch's upstream, both empty
// when it has none. The ref is reported even when it no longer exists locally.
func upstreamOf(dir, branch string) (ref, short string, err error) {
	// The pattern matches at most this one ref: for-each-ref only extends a
	// pattern at a slash, and git's directory/file rule forbids "feat" and
	// "feat/sub" from both existing. So the output is one line or none.
	out, err := execGit(dir, "for-each-ref", "--format=%(upstream)%09%(upstream:short)", "refs/heads/"+branch)
	if err != nil {
		return "", "", err
	}
	// Trimmed output of a branch without upstream is the empty string, not a
	// lone tab; an unborn branch has no ref line at all.
	if out == "" {
		return "", "", nil
	}

	ref, short, ok := strings.Cut(out, "\t")
	if !ok {
		return "", "", fmt.Errorf("unexpected upstream format for %s: %q", branch, out)
	}
	return ref, short, nil
}

// aheadBehind counts the commits each of the two refs has that the other lacks.
func aheadBehind(dir, local, upstream string) (ahead, behind int, err error) {
	out, err := execGit(dir, "rev-list", "--left-right", "--count", local+"..."+upstream)
	if err != nil {
		return 0, 0, err
	}

	fields := strings.Fields(out)
	if len(fields) != 2 {
		return 0, 0, fmt.Errorf("unexpected rev-list count output: %q", out)
	}
	if ahead, err = strconv.Atoi(fields[0]); err != nil {
		return 0, 0, fmt.Errorf("unexpected rev-list count output: %q", out)
	}
	if behind, err = strconv.Atoi(fields[1]); err != nil {
		return 0, 0, fmt.Errorf("unexpected rev-list count output: %q", out)
	}
	return ahead, behind, nil
}

// lastFetchTime is the mtime of FETCH_HEAD, which git rewrites on every fetch.
// nil means the file is absent, i.e. this worktree has never fetched.
//
// FETCH_HEAD is per-worktree, so --git-path is what locates it: a linked
// worktree's copy does not live in the repository's main .git directory.
func lastFetchTime(dir string) (*time.Time, error) {
	path, err := execGit(dir, "rev-parse", "--git-path", "FETCH_HEAD")
	if err != nil {
		return nil, err
	}
	// Relative to the command's working directory, which is dir.
	if !filepath.IsAbs(path) {
		path = filepath.Join(dir, path)
	}

	stat, err := os.Stat(path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("failed to read fetch time: %w", err)
	}

	modTime := stat.ModTime()
	return &modTime, nil
}

// Fetch updates the remote-tracking refs of every remote.
//
// It never touches the working tree or any local branch, which is why the panel
// offers it unconditionally and without confirmation — it is also the repair
// action for a chip whose counts have gone stale.
//
// --prune keeps the branch sheet honest: without it, branches deleted on the
// remote stay in the remote-only list forever and offer a checkout that fails.
func Fetch(dir string) error {
	return execGitNetwork(dir, "fetch", "--all", "--prune")
}

// Pull fast-forwards the current branch onto its upstream and reports how many
// commits it brought in.
//
// --ff-only is deliberate and not configurable from the UI: a merge started by
// one tap on a phone can strand the user in a conflicted worktree with no
// tooling to get out. When the branches have diverged git refuses, and the
// panel points at the escape hatch that does exist there — asking the agent in
// chat to merge or rebase.
//
// The count is measured here rather than taken from the panel's behind count:
// pull fetches first, so it can bring in commits pushed since the chip's
// numbers were last read.
func Pull(dir string) (int, error) {
	// Empty for an unborn HEAD, which has nothing to fast-forward — the pull
	// below is what says so, in git's own words.
	before, _ := execGit(dir, "rev-parse", "HEAD")

	if err := execGitNetwork(dir, "pull", "--ff-only"); err != nil {
		return 0, err
	}

	after, err := execGit(dir, "rev-parse", "HEAD")
	// The pull succeeded; failing to count afterwards must not turn it into a
	// failure. An unreported count is a smaller loss than a wrong outcome.
	if err != nil || before == "" || before == after {
		return 0, nil
	}
	return commitCount(dir, before, after), nil
}

// commitCount counts the commits in from..to, reporting 0 when it cannot tell.
func commitCount(dir, from, to string) int {
	out, err := execGit(dir, "rev-list", "--count", from+".."+to)
	if err != nil {
		return 0
	}
	count, err := strconv.Atoi(out)
	if err != nil {
		return 0
	}
	return count
}

// Push publishes the current branch, setting its upstream when it has none.
//
// force uses --force-with-lease, never a bare --force: a push that races with
// someone else's fails loudly instead of destroying their work. The UI offers
// it only where a plain push cannot succeed, after a confirmation.
func Push(dir string, force bool) error {
	head, err := Head(dir)
	if err != nil {
		return err
	}
	if head.Detached || head.Branch == "" {
		return fmt.Errorf("cannot push a detached HEAD")
	}

	args := []string{"push"}
	if force {
		args = append(args, "--force-with-lease")
	}

	// Read here rather than trusting the caller: the client's copy of the
	// upstream can be seconds old, and pushing to the wrong place is not the
	// kind of mistake to make on stale data.
	ref, _, err := upstreamOf(dir, head.Branch)
	if err != nil {
		return err
	}
	if ref == "" {
		remote, err := defaultRemote(dir)
		if err != nil {
			return err
		}
		args = append(args, "--set-upstream", remote, head.Branch)
	}

	return execGitNetwork(dir, args...)
}

// defaultRemote picks the remote a branch with no upstream is published to.
func defaultRemote(dir string) (string, error) {
	remotes, err := execGitLines(dir, "remote")
	if err != nil {
		return "", err
	}

	switch {
	case len(remotes) == 0:
		return "", fmt.Errorf("no remote configured")
	case len(remotes) == 1:
		return remotes[0], nil
	}
	// git's own convention, and the only remote Pockode configures itself.
	if contains(remotes, "origin") {
		return "origin", nil
	}
	return "", fmt.Errorf("no upstream set and no remote named origin; remotes are %s", strings.Join(remotes, ", "))
}
