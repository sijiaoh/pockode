package git

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// setupTrackingRepo is a repository with one commit, an "origin" bare remote,
// and its current branch already published — the ordinary state the sync sheet
// renders.
func setupTrackingRepo(t *testing.T) (dir, remote, branch string, cleanup func()) {
	t.Helper()
	dir, cleanupRepo := setupTestRepoWithCommit(t)
	remote, cleanupRemote := setupBareRemote(t)

	branch = mainBranch(t, dir)
	runGit(t, dir, "remote", "add", "origin", remote)
	runGit(t, dir, "push", "-u", "origin", branch)

	return dir, remote, branch, func() {
		cleanupRepo()
		cleanupRemote()
	}
}

func syncOf(t *testing.T, dir string) SyncInfo {
	t.Helper()
	list, err := Branches(dir)
	if err != nil {
		t.Fatalf("Branches() error: %v", err)
	}
	return list.Sync
}

func TestSync_NoRemote(t *testing.T) {
	dir, cleanup := setupTestRepoWithCommit(t)
	defer cleanup()

	sync := syncOf(t, dir)
	if sync.HasRemote {
		t.Error("HasRemote is true in a repository with no remote")
	}
	if sync.Upstream != "" {
		t.Errorf("Upstream = %q, want empty", sync.Upstream)
	}
	if sync.LastFetch != nil {
		t.Errorf("LastFetch = %v, want nil before the first fetch", sync.LastFetch)
	}
}

// A branch that exists only locally is the state the sheet offers to publish,
// not an error.
func TestSync_NoUpstream(t *testing.T) {
	dir, _, _, cleanup := setupTrackingRepo(t)
	defer cleanup()

	runGit(t, dir, "checkout", "-b", "topic")

	sync := syncOf(t, dir)
	if !sync.HasRemote {
		t.Error("HasRemote is false with origin configured")
	}
	if sync.Upstream != "" || sync.UpstreamGone {
		t.Errorf("Sync = %+v, want no upstream", sync)
	}
}

func TestSync_AheadAndBehind(t *testing.T) {
	dir, remote, branch, cleanup := setupTrackingRepo(t)
	defer cleanup()

	// A second clone stands in for the colleague whose commits we are behind.
	other, otherCleanup := cloneRepo(t, remote)
	defer otherCleanup()
	writeTestFile(t, other, "theirs.txt", "theirs\n")
	runGit(t, other, "add", "theirs.txt")
	runGit(t, other, "commit", "--no-gpg-sign", "-m", "theirs")
	runGit(t, other, "push", "origin", branch)

	writeTestFile(t, dir, "ours.txt", "ours\n")
	runGit(t, dir, "add", "ours.txt")
	runGit(t, dir, "commit", "--no-gpg-sign", "-m", "ours")

	if sync := syncOf(t, dir); sync.Ahead != 1 || sync.Behind != 0 {
		t.Errorf("before fetch Sync = %+v, want ahead 1 behind 0", sync)
	}

	if err := Fetch(dir); err != nil {
		t.Fatalf("Fetch() error: %v", err)
	}

	sync := syncOf(t, dir)
	if sync.Ahead != 1 || sync.Behind != 1 {
		t.Errorf("Sync = %+v, want ahead 1 behind 1", sync)
	}
	if sync.Upstream != "origin/"+branch {
		t.Errorf("Upstream = %q, want origin/%s", sync.Upstream, branch)
	}
	// Counts are only as fresh as the last fetch, so the sheet always states it.
	if sync.LastFetch == nil {
		t.Fatal("LastFetch is nil after Fetch()")
	}
	if time.Since(*sync.LastFetch) > time.Minute {
		t.Errorf("LastFetch = %v, want roughly now", sync.LastFetch)
	}
	// A commit of ours that the upstream lacks is a commit amending would rewrite.
	if sync.HeadPushed {
		t.Error("HeadPushed is true while ahead of the upstream")
	}
}

func TestSync_HeadPushed(t *testing.T) {
	dir, _, _, cleanup := setupTrackingRepo(t)
	defer cleanup()

	sync := syncOf(t, dir)
	if !sync.HeadPushed {
		t.Errorf("Sync = %+v, want HeadPushed for a freshly pushed branch", sync)
	}
}

// The upstream is configured but its remote-tracking ref is missing, so the
// counts are unknown rather than zero — reporting "in sync" here would be a lie.
func TestSync_UpstreamGone(t *testing.T) {
	dir, _, branch, cleanup := setupTrackingRepo(t)
	defer cleanup()

	runGit(t, dir, "update-ref", "-d", "refs/remotes/origin/"+branch)

	sync := syncOf(t, dir)
	if !sync.UpstreamGone {
		t.Errorf("Sync = %+v, want UpstreamGone", sync)
	}
	if sync.Upstream != "origin/"+branch {
		t.Errorf("Upstream = %q, want the configured upstream to still be named", sync.Upstream)
	}
	if sync.HeadPushed {
		t.Error("HeadPushed is true while the upstream ref is unknown")
	}
}

// Fetch is the repair action for a stale chip: it must bring the counts up to
// date without touching the working tree or any local branch.
func TestFetch_LeavesLocalBranchAlone(t *testing.T) {
	dir, remote, branch, cleanup := setupTrackingRepo(t)
	defer cleanup()

	other, otherCleanup := cloneRepo(t, remote)
	defer otherCleanup()
	writeTestFile(t, other, "theirs.txt", "theirs\n")
	runGit(t, other, "add", "theirs.txt")
	runGit(t, other, "commit", "--no-gpg-sign", "-m", "theirs")
	runGit(t, other, "push", "origin", branch)

	if err := Fetch(dir); err != nil {
		t.Fatalf("Fetch() error: %v", err)
	}

	if sync := syncOf(t, dir); sync.Behind != 1 {
		t.Errorf("Sync = %+v, want behind 1 after fetching their commit", sync)
	}
	if _, err := os.Stat(filepath.Join(dir, "theirs.txt")); !os.IsNotExist(err) {
		t.Error("Fetch() brought a file into the working tree")
	}
}

func TestPull_FastForwards(t *testing.T) {
	dir, remote, branch, cleanup := setupTrackingRepo(t)
	defer cleanup()

	other, otherCleanup := cloneRepo(t, remote)
	defer otherCleanup()
	writeTestFile(t, other, "theirs.txt", "theirs\n")
	runGit(t, other, "add", "theirs.txt")
	runGit(t, other, "commit", "--no-gpg-sign", "-m", "theirs")
	runGit(t, other, "push", "origin", branch)

	commits, err := Pull(dir)
	if err != nil {
		t.Fatalf("Pull() error: %v", err)
	}
	// Counted after the pull's own fetch, not from a count read before it.
	if commits != 1 {
		t.Errorf("Pull() reported %d commits, want 1", commits)
	}

	if _, err := os.Stat(filepath.Join(dir, "theirs.txt")); err != nil {
		t.Errorf("Pull() did not bring their file in: %v", err)
	}
	if sync := syncOf(t, dir); sync.Ahead != 0 || sync.Behind != 0 {
		t.Errorf("Sync = %+v, want in sync after pulling", sync)
	}
}

// Diverged histories must fail rather than start a merge nobody can finish from
// a phone, and git's own refusal is what the sheet shows.
func TestPull_DivergedIsRefused(t *testing.T) {
	dir, remote, branch, cleanup := setupTrackingRepo(t)
	defer cleanup()

	other, otherCleanup := cloneRepo(t, remote)
	defer otherCleanup()
	writeTestFile(t, other, "theirs.txt", "theirs\n")
	runGit(t, other, "add", "theirs.txt")
	runGit(t, other, "commit", "--no-gpg-sign", "-m", "theirs")
	runGit(t, other, "push", "origin", branch)

	writeTestFile(t, dir, "ours.txt", "ours\n")
	runGit(t, dir, "add", "ours.txt")
	runGit(t, dir, "commit", "--no-gpg-sign", "-m", "ours")

	_, err := Pull(dir)
	if err == nil {
		t.Fatal("Pull() succeeded on diverged branches")
	}
	// The panel keys its "ask the agent to merge or rebase" hint off this phrase.
	if !strings.Contains(strings.ToLower(err.Error()), "fast-forward") {
		t.Errorf("Pull() error = %q, want git's fast-forward refusal", err)
	}
	// Nothing may be left half-merged behind the failure.
	if sync := syncOf(t, dir); sync.Ahead != 1 || sync.Behind != 1 {
		t.Errorf("Sync = %+v, want the branches left diverged", sync)
	}
}

func TestPush(t *testing.T) {
	dir, remote, branch, cleanup := setupTrackingRepo(t)
	defer cleanup()

	writeTestFile(t, dir, "ours.txt", "ours\n")
	runGit(t, dir, "add", "ours.txt")
	runGit(t, dir, "commit", "--no-gpg-sign", "-m", "ours")

	if err := Push(dir, false); err != nil {
		t.Fatalf("Push() error: %v", err)
	}

	if sync := syncOf(t, dir); sync.Ahead != 0 {
		t.Errorf("Sync = %+v, want nothing left to push", sync)
	}
	if got := remoteSubject(t, remote, branch); got != "ours" {
		t.Errorf("remote tip subject = %q, want ours", got)
	}
}

// A branch with no upstream is published and starts tracking in one action, so
// the chip stops reading "Publish" afterwards.
func TestPush_SetsUpstream(t *testing.T) {
	dir, remote, _, cleanup := setupTrackingRepo(t)
	defer cleanup()

	runGit(t, dir, "checkout", "-b", "topic")

	if err := Push(dir, false); err != nil {
		t.Fatalf("Push() error: %v", err)
	}

	sync := syncOf(t, dir)
	if sync.Upstream != "origin/topic" {
		t.Errorf("Upstream = %q, want origin/topic", sync.Upstream)
	}
	if sync.Ahead != 0 || sync.Behind != 0 || sync.UpstreamGone {
		t.Errorf("Sync = %+v, want a published branch in sync", sync)
	}
	if got := remoteSubject(t, remote, "topic"); got != "initial" {
		t.Errorf("remote topic subject = %q, want initial", got)
	}
}

func TestPush_RejectedWhenBehind(t *testing.T) {
	dir, remote, branch, cleanup := setupTrackingRepo(t)
	defer cleanup()

	other, otherCleanup := cloneRepo(t, remote)
	defer otherCleanup()
	writeTestFile(t, other, "theirs.txt", "theirs\n")
	runGit(t, other, "add", "theirs.txt")
	runGit(t, other, "commit", "--no-gpg-sign", "-m", "theirs")
	runGit(t, other, "push", "origin", branch)

	runGit(t, dir, "commit", "--no-gpg-sign", "--allow-empty", "-m", "ours")

	err := Push(dir, false)
	if err == nil {
		t.Fatal("Push() succeeded over a diverged remote")
	}
	// git's rejection names the ref and the reason; the sheet shows it verbatim.
	if !strings.Contains(err.Error(), "rejected") {
		t.Errorf("Push() error = %q, want git's rejection", err)
	}
}

// Force push replaces the remote history, and --force-with-lease is what makes
// it safe: it succeeds only while the remote is where we last saw it.
func TestPush_ForceReplacesRemoteHistory(t *testing.T) {
	dir, remote, branch, cleanup := setupTrackingRepo(t)
	defer cleanup()

	runGit(t, dir, "commit", "--no-gpg-sign", "--amend", "--no-edit", "-m", "amended")

	if err := Push(dir, false); err == nil {
		t.Fatal("plain Push() succeeded after an amend")
	}
	if err := Push(dir, true); err != nil {
		t.Fatalf("Push(force) error: %v", err)
	}
	if got := remoteSubject(t, remote, branch); got != "amended" {
		t.Errorf("remote tip subject = %q, want amended", got)
	}
}

// The lease is the whole point: someone else's push landing in between must make
// the force push fail rather than discard their work.
func TestPush_ForceRefusesToOverwriteUnseenCommits(t *testing.T) {
	dir, remote, branch, cleanup := setupTrackingRepo(t)
	defer cleanup()

	other, otherCleanup := cloneRepo(t, remote)
	defer otherCleanup()
	runGit(t, other, "commit", "--no-gpg-sign", "--allow-empty", "-m", "theirs")
	runGit(t, other, "push", "origin", branch)

	runGit(t, dir, "commit", "--no-gpg-sign", "--amend", "--no-edit", "-m", "amended")

	if err := Push(dir, true); err == nil {
		t.Fatal("Push(force) overwrote a commit it had never seen")
	}
	if got := remoteSubject(t, remote, branch); got != "theirs" {
		t.Errorf("remote tip subject = %q, want their commit intact", got)
	}
}

func TestPush_DetachedHead(t *testing.T) {
	dir, _, _, cleanup := setupTrackingRepo(t)
	defer cleanup()

	runGit(t, dir, "checkout", "--detach", "HEAD")

	err := Push(dir, false)
	if err == nil {
		t.Fatal("Push() succeeded from a detached HEAD")
	}
	if !strings.Contains(err.Error(), "detached") {
		t.Errorf("Push() error = %q, want it to name the detached HEAD", err)
	}
}

// git echoes the remote URL back in its errors, and a repository configured
// outside Pockode may carry a token in it.
func TestRedactCredentials(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{
			name: "token in remote url",
			in:   "fatal: could not read from 'https://x-access-token:ghp_secret@github.com/o/r.git'",
			want: "fatal: could not read from 'https://***@github.com/o/r.git'",
		},
		{
			name: "bare username",
			in:   "remote: https://alice@example.com/repo",
			want: "remote: https://***@example.com/repo",
		},
		{
			name: "url without credentials is untouched",
			in:   "fatal: repository 'https://github.com/o/r.git' not found",
			want: "fatal: repository 'https://github.com/o/r.git' not found",
		},
		{
			name: "email address is not a url",
			in:   "*** Please tell me who you are: git config user.email you@example.com",
			want: "*** Please tell me who you are: git config user.email you@example.com",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := redactCredentials(tt.in); got != tt.want {
				t.Errorf("redactCredentials(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

func cloneRepo(t *testing.T, remote string) (string, func()) {
	t.Helper()
	dir, err := os.MkdirTemp("", "git-clone-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	cleanup := func() { os.RemoveAll(dir) }

	runGit(t, dir, "clone", remote, ".")
	runGit(t, dir, "config", "user.email", "other@test.com")
	runGit(t, dir, "config", "user.name", "Other")
	return dir, cleanup
}

func remoteSubject(t *testing.T, remote, branch string) string {
	t.Helper()
	subject, err := execGit(remote, "log", "-1", "--format=%s", branch)
	if err != nil {
		t.Fatalf("failed to read remote tip: %v", err)
	}
	return subject
}

// A network command that never answers must not hang the RPC behind it — and
// must be stopped in a way that leaves the repository usable afterwards.
func TestExecGitNetwork_TimesOut(t *testing.T) {
	dir, cleanup := setupTestRepoWithCommit(t)
	defer cleanup()

	// git runs GIT_SSH_COMMAND for an ssh-style remote, so this stands in for a
	// remote that accepts the connection and then says nothing.
	runGit(t, dir, "remote", "add", "origin", "git@localhost:repo.git")
	t.Setenv("GIT_SSH_COMMAND", "sh -c 'sleep 30'")

	start := time.Now()
	err := execGitNetworkTimeout(dir, 500*time.Millisecond, "fetch", "origin")
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("execGitNetworkTimeout() returned no error for a hung fetch")
	}
	if elapsed > 10*time.Second {
		t.Errorf("took %s to give up on a 500ms deadline", elapsed)
	}

	var cmdErr *CommandError
	if !errors.As(err, &cmdErr) || !cmdErr.TimedOut {
		t.Fatalf("error = %#v, want a CommandError marked TimedOut", err)
	}
	// git is killed without a word, so the message has to say what happened.
	if !strings.Contains(err.Error(), "timed out") {
		t.Errorf("error = %q, want it to name the timeout", err)
	}

	// A lock left behind by the timeout would break every later git command here.
	if _, err := os.Stat(filepath.Join(dir, ".git", "index.lock")); !os.IsNotExist(err) {
		t.Error("a lock file survived the timeout")
	}
	if _, err := Head(dir); err != nil {
		t.Errorf("repository is unusable after a timed-out fetch: %v", err)
	}
}

// The panel's behind count is only as fresh as the last fetch, and pull fetches
// again before fast-forwarding — so what it reports has to be measured, not
// assumed.
func TestPull_CountsWhatItActuallyBroughtIn(t *testing.T) {
	dir, remote, branch, cleanup := setupTrackingRepo(t)
	defer cleanup()

	other, otherCleanup := cloneRepo(t, remote)
	defer otherCleanup()
	runGit(t, other, "commit", "--no-gpg-sign", "--allow-empty", "-m", "first")
	runGit(t, other, "push", "origin", branch)

	// The panel now believes it is one behind.
	if err := Fetch(dir); err != nil {
		t.Fatalf("Fetch() error: %v", err)
	}
	if sync := syncOf(t, dir); sync.Behind != 1 {
		t.Fatalf("Sync = %+v, want behind 1 before the second push", sync)
	}

	// Two more land before the user taps Pull.
	runGit(t, other, "commit", "--no-gpg-sign", "--allow-empty", "-m", "second")
	runGit(t, other, "commit", "--no-gpg-sign", "--allow-empty", "-m", "third")
	runGit(t, other, "push", "origin", branch)

	commits, err := Pull(dir)
	if err != nil {
		t.Fatalf("Pull() error: %v", err)
	}
	if commits != 3 {
		t.Errorf("Pull() reported %d commits, want 3", commits)
	}
}
