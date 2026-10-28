package git

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// setupTestRepoWithCommit is setupTestRepo plus one commit, so HEAD resolves and
// branches can be created.
func setupTestRepoWithCommit(t *testing.T) (string, func()) {
	t.Helper()
	dir, cleanup := setupTestRepo(t)
	writeTestFile(t, dir, "file.txt", "content\n")
	runGit(t, dir, "add", "file.txt")
	runGit(t, dir, "commit", "--no-gpg-sign", "-m", "initial")
	return dir, cleanup
}

func TestHead(t *testing.T) {
	dir, cleanup := setupTestRepoWithCommit(t)
	defer cleanup()

	runGit(t, dir, "branch", "-M", "main")

	head, err := Head(dir)
	if err != nil {
		t.Fatalf("Head() error: %v", err)
	}
	if head.Branch != "main" || head.Detached {
		t.Errorf("Head() = %+v, want branch main and attached", head)
	}
	if head.Hash == "" {
		t.Error("Head() returned an empty hash")
	}

	runGit(t, dir, "checkout", "--detach", "HEAD")

	head, err = Head(dir)
	if err != nil {
		t.Fatalf("Head() error after detach: %v", err)
	}
	if !head.Detached || head.Branch != "" {
		t.Errorf("Head() = %+v, want detached with no branch", head)
	}
	if head.Hash == "" {
		t.Error("Head() returned an empty hash while detached")
	}
}

func TestCurrentBranch(t *testing.T) {
	dir, cleanup := setupTestRepoWithCommit(t)
	defer cleanup()
	runGit(t, dir, "branch", "-M", "feature/x")

	if got, err := CurrentBranch(dir); err != nil || got != "feature/x" {
		t.Errorf("CurrentBranch() = %q, %v; want feature/x", got, err)
	}

	runGit(t, dir, "checkout", "--detach", "HEAD")
	if _, err := CurrentBranch(dir); !errors.Is(err, ErrDetachedHead) {
		t.Errorf("CurrentBranch() detached error = %v, want ErrDetachedHead", err)
	}
}

// --short would render "heads/main" here, and the current row would stop
// matching its own branch.
func TestHead_TagSharingTheBranchName(t *testing.T) {
	dir, cleanup := setupTestRepoWithCommit(t)
	defer cleanup()
	runGit(t, dir, "branch", "-M", "main")
	// update-ref rather than tag: a user tag.gpgSign would make tag ask for a message.
	runGit(t, dir, "update-ref", "refs/tags/main", "HEAD")

	if got, err := CurrentBranch(dir); err != nil || got != "main" {
		t.Errorf("CurrentBranch() = %q, %v; want main", got, err)
	}
	head, err := Head(dir)
	if err != nil || head.Branch != "main" {
		t.Errorf("Head() = %+v, %v; want branch main", head, err)
	}
}

func TestCurrentBranch_UnbornBranch(t *testing.T) {
	dir, cleanup := setupTestRepo(t)
	defer cleanup()
	runGit(t, dir, "symbolic-ref", "HEAD", "refs/heads/fresh")

	if got, err := CurrentBranch(dir); err != nil || got != "fresh" {
		t.Errorf("CurrentBranch() = %q, %v; want fresh", got, err)
	}
}

// Anything but a detached HEAD is a failure to read, not a HEAD on no branch.
func TestCurrentBranch_NotARepository(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("GIT_CEILING_DIRECTORIES", filepath.Dir(dir))

	_, err := CurrentBranch(dir)
	if err == nil || errors.Is(err, ErrDetachedHead) {
		t.Errorf("CurrentBranch() error = %v, want a failure other than ErrDetachedHead", err)
	}
}

// A repository without commits still has a named branch, and the branch bar has
// to show it rather than fail because HEAD does not resolve.
func TestHead_UnbornBranch(t *testing.T) {
	dir, cleanup := setupTestRepo(t)
	defer cleanup()

	head, err := Head(dir)
	if err != nil {
		t.Fatalf("Head() error: %v", err)
	}
	if head.Branch == "" {
		t.Error("Head() returned no branch for an unborn HEAD")
	}
	if head.Hash != "" || head.Detached {
		t.Errorf("Head() = %+v, want no hash and not detached", head)
	}
}

func TestBranches_CurrentFirst(t *testing.T) {
	dir, cleanup := setupTestRepoWithCommit(t)
	defer cleanup()

	runGit(t, dir, "branch", "-M", "main")
	runGit(t, dir, "branch", "topic")
	runGit(t, dir, "branch", "other")

	list, err := Branches(dir)
	if err != nil {
		t.Fatalf("Branches() error: %v", err)
	}
	if len(list.Local) != 3 {
		t.Fatalf("Branches() returned %d local branches, want 3", len(list.Local))
	}
	if list.Local[0].Name != "main" || !list.Local[0].Current {
		t.Errorf("first local branch = %+v, want current branch main", list.Local[0])
	}
	for _, b := range list.Local[1:] {
		if b.Current {
			t.Errorf("branch %q marked current besides HEAD", b.Name)
		}
		if b.Worktree != "" {
			t.Errorf("branch %q annotated with worktree %q, want none", b.Name, b.Worktree)
		}
	}
}

// A branch checked out elsewhere cannot be checked out here, so it must arrive
// annotated instead of failing at checkout time.
func TestBranches_OccupiedByOtherWorktree(t *testing.T) {
	dir, cleanup := setupTestRepoWithCommit(t)
	defer cleanup()

	runGit(t, dir, "branch", "topic")
	linked := filepath.Join(filepath.Dir(dir), filepath.Base(dir)+"-linked")
	runGit(t, dir, "worktree", "add", linked, "topic")
	defer os.RemoveAll(linked)

	list, err := Branches(dir)
	if err != nil {
		t.Fatalf("Branches() error: %v", err)
	}

	topic := findBranch(t, list.Local, "topic")
	if topic.Worktree != filepath.Base(linked) {
		t.Errorf("topic.Worktree = %q, want %q", topic.Worktree, filepath.Base(linked))
	}

	// The current branch is held by this worktree, which is not an obstacle.
	for _, b := range list.Local {
		if b.Current && b.Worktree != "" {
			t.Errorf("current branch annotated with worktree %q", b.Worktree)
		}
	}

	// Seen from the other side, the main checkout has to be named as such: its
	// directory carries the repository's name, which the worktree switcher never
	// shows.
	fromLinked, err := Branches(linked)
	if err != nil {
		t.Fatalf("Branches() error from the linked worktree: %v", err)
	}
	held := findBranch(t, fromLinked.Local, mainBranch(t, dir))
	if held.Worktree != mainWorktreeLabel {
		t.Errorf("main worktree's branch annotated %q, want %q", held.Worktree, mainWorktreeLabel)
	}
	if topic := findBranch(t, fromLinked.Local, "topic"); topic.Worktree != "" {
		t.Errorf("current branch annotated with worktree %q from the linked worktree", topic.Worktree)
	}
}

// mainBranch is the branch the repository was initialised on, whose name depends
// on the git version and on init.defaultBranch.
func mainBranch(t *testing.T, dir string) string {
	t.Helper()
	return gitOutput(t, dir, "rev-parse", "--abbrev-ref", "HEAD")
}

func TestBranches_RemoteOnly(t *testing.T) {
	dir, cleanup := setupTestRepoWithCommit(t)
	defer cleanup()

	runGit(t, dir, "branch", "-M", "main")
	runGit(t, dir, "branch", "published")

	remote, remoteCleanup := setupBareRemote(t)
	defer remoteCleanup()
	runGit(t, dir, "remote", "add", "origin", remote)
	runGit(t, dir, "push", "origin", "main", "published")
	// Only "published" keeps a local counterpart deleted, so it becomes remote-only.
	runGit(t, dir, "branch", "-D", "published")
	runGit(t, dir, "fetch", "origin")

	list, err := Branches(dir)
	if err != nil {
		t.Fatalf("Branches() error: %v", err)
	}

	if len(list.RemoteOnly) != 1 {
		t.Fatalf("RemoteOnly = %+v, want only the deleted local branch", list.RemoteOnly)
	}
	if list.RemoteOnly[0].Name != "published" || list.RemoteOnly[0].Ref != "origin/published" {
		t.Errorf("RemoteOnly[0] = %+v, want {origin/published published}", list.RemoteOnly[0])
	}
}

// The frontend filters this list, so "no remotes" has to marshal as [] and not
// as null.
func TestBranches_RemoteOnlyIsNeverNil(t *testing.T) {
	dir, cleanup := setupTestRepoWithCommit(t)
	defer cleanup()

	list, err := Branches(dir)
	if err != nil {
		t.Fatalf("Branches() error: %v", err)
	}
	if list.RemoteOnly == nil {
		t.Error("RemoteOnly is nil, want an empty slice")
	}
}

func TestCheckout(t *testing.T) {
	dir, cleanup := setupTestRepoWithCommit(t)
	defer cleanup()

	runGit(t, dir, "branch", "topic")

	if err := Checkout(dir, "topic"); err != nil {
		t.Fatalf("Checkout() error: %v", err)
	}
	if got := gitOutput(t, dir, "rev-parse", "--abbrev-ref", "HEAD"); got != "topic" {
		t.Errorf("HEAD is on %q, want topic", got)
	}
}

// Uncommitted changes are never stashed, so a switch git refuses has to surface
// git's own message naming the files in the way.
func TestCheckout_RefusedKeepsGitMessage(t *testing.T) {
	dir, cleanup := setupTestRepoWithCommit(t)
	defer cleanup()

	runGit(t, dir, "checkout", "-b", "topic")
	writeTestFile(t, dir, "file.txt", "topic version\n")
	runGit(t, dir, "commit", "--no-gpg-sign", "-am", "topic change")
	runGit(t, dir, "checkout", "-")
	writeTestFile(t, dir, "file.txt", "uncommitted\n")

	err := Checkout(dir, "topic")
	if err == nil {
		t.Fatal("Checkout() succeeded, want refusal over the conflicting change")
	}
	if !strings.Contains(err.Error(), "file.txt") {
		t.Errorf("Checkout() error = %q, want it to name file.txt", err)
	}
}

func TestCheckout_RemoteOnlyBranchTracks(t *testing.T) {
	dir, cleanup := setupTestRepoWithCommit(t)
	defer cleanup()

	runGit(t, dir, "branch", "published")
	remote, remoteCleanup := setupBareRemote(t)
	defer remoteCleanup()
	runGit(t, dir, "remote", "add", "origin", remote)
	runGit(t, dir, "push", "origin", "published")
	runGit(t, dir, "branch", "-D", "published")

	if err := Checkout(dir, "published"); err != nil {
		t.Fatalf("Checkout() error: %v", err)
	}
	if got := gitOutput(t, dir, "rev-parse", "--abbrev-ref", "HEAD"); got != "published" {
		t.Errorf("HEAD is on %q, want published", got)
	}
	if got := gitOutput(t, dir, "rev-parse", "--abbrev-ref", "published@{upstream}"); got != "origin/published" {
		t.Errorf("upstream = %q, want origin/published", got)
	}
}

func TestCreateBranch(t *testing.T) {
	dir, cleanup := setupTestRepoWithCommit(t)
	defer cleanup()

	base := gitHead(t, dir)
	writeTestFile(t, dir, "file.txt", "uncommitted\n")

	if err := CreateBranch(dir, "feature/new", ""); err != nil {
		t.Fatalf("CreateBranch() error: %v", err)
	}
	if got := gitOutput(t, dir, "rev-parse", "--abbrev-ref", "HEAD"); got != "feature/new" {
		t.Errorf("HEAD is on %q, want feature/new", got)
	}
	if gitHead(t, dir) != base {
		t.Error("CreateBranch() did not branch from the current HEAD")
	}
	// Uncommitted work follows the user onto the new branch (standard git).
	if got := gitOutput(t, dir, "status", "--porcelain"); !strings.Contains(got, "file.txt") {
		t.Errorf("status = %q, want the uncommitted change carried over", got)
	}
}

// A leading dash would reach git as an option rather than as a ref.
func TestValidateBranchName(t *testing.T) {
	tests := []struct {
		name    string
		branch  string
		wantErr bool
	}{
		{name: "ordinary name", branch: "topic"},
		{name: "slashed name", branch: "feature/topic"},
		{name: "empty", branch: "", wantErr: true},
		{name: "leading dash", branch: "-f", wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := validateBranchName(tt.branch); (err != nil) != tt.wantErr {
				t.Errorf("validateBranchName(%q) error = %v, wantErr %v", tt.branch, err, tt.wantErr)
			}
		})
	}
}

// The longest-first ordering this relies on cannot be reached through Branches()
// without configuring a remote literally named "origin/fork".
func TestSplitRemoteRef(t *testing.T) {
	tests := []struct {
		name      string
		ref       string
		remotes   []string
		wantShort string
		wantName  string
		wantOK    bool
	}{
		{
			name:      "ordinary remote",
			ref:       "refs/remotes/origin/topic",
			remotes:   []string{"origin"},
			wantShort: "origin/topic",
			wantName:  "topic",
			wantOK:    true,
		},
		{
			name:      "branch name contains a slash",
			ref:       "refs/remotes/origin/feature/topic",
			remotes:   []string{"origin"},
			wantShort: "origin/feature/topic",
			wantName:  "feature/topic",
			wantOK:    true,
		},
		{
			name:      "longer remote wins over its own prefix",
			ref:       "refs/remotes/origin/fork/topic",
			remotes:   []string{"origin/fork", "origin"},
			wantShort: "origin/fork/topic",
			wantName:  "topic",
			wantOK:    true,
		},
		{
			name:    "ref of no configured remote",
			ref:     "refs/remotes/gone/topic",
			remotes: []string{"origin"},
		},
		{
			name:    "not a remote ref",
			ref:     "refs/heads/topic",
			remotes: []string{"origin"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			short, name, ok := splitRemoteRef(tt.ref, tt.remotes)
			if ok != tt.wantOK || short != tt.wantShort || name != tt.wantName {
				t.Errorf("splitRemoteRef(%q, %v) = (%q, %q, %v), want (%q, %q, %v)",
					tt.ref, tt.remotes, short, name, ok, tt.wantShort, tt.wantName, tt.wantOK)
			}
		})
	}
}

func findBranch(t *testing.T, branches []BranchInfo, name string) BranchInfo {
	t.Helper()
	for _, b := range branches {
		if b.Name == name {
			return b
		}
	}
	t.Fatalf("branch %q not found in %+v", name, branches)
	return BranchInfo{}
}

func setupBareRemote(t *testing.T) (string, func()) {
	t.Helper()
	dir, err := os.MkdirTemp("", "git-remote-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	cleanup := func() { os.RemoveAll(dir) }
	runGit(t, dir, "init", "--bare")
	return dir, cleanup
}

// commitAt commits everything staged-or-not with a fixed committer date, so
// ordering by commit time does not depend on how fast the test runs.
func commitAt(t *testing.T, dir, message string, at time.Time) {
	t.Helper()
	cmd := exec.Command("git", "commit", "--no-gpg-sign", "--allow-empty", "-m", message)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_COMMITTER_DATE="+at.Format(time.RFC3339))
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git commit failed: %v\n%s", err, out)
	}
}

func TestBranches_CommitTimeAndDivergence(t *testing.T) {
	dir, cleanup := setupTestRepoWithCommit(t)
	defer cleanup()
	runGit(t, dir, "branch", "-M", "main")

	// Later than the fixture's initial commit, which is dated now.
	base := time.Now().Add(time.Hour).Truncate(time.Second)
	runGit(t, dir, "checkout", "-q", "-b", "topic")
	commitAt(t, dir, "topic work", base.Add(3*time.Hour))
	runGit(t, dir, "checkout", "-q", "main")
	commitAt(t, dir, "main 1", base.Add(1*time.Hour))
	commitAt(t, dir, "main 2", base.Add(2*time.Hour))
	runGit(t, dir, "branch", "stale", "HEAD~2")

	list, err := Branches(dir)
	if err != nil {
		t.Fatalf("Branches() error: %v", err)
	}

	if list.DefaultBranch != "main" {
		t.Errorf("DefaultBranch = %q, want main", list.DefaultBranch)
	}
	// Current first, then most recently committed.
	var order []string
	for _, b := range list.Local {
		order = append(order, b.Name)
	}
	if strings.Join(order, ",") != "main,topic,stale" {
		t.Errorf("local order = %v, want [main topic stale]", order)
	}

	main := findBranch(t, list.Local, "main")
	if !main.CommittedAt.Equal(base.Add(2 * time.Hour)) {
		t.Errorf("main.CommittedAt = %v, want %v", main.CommittedAt, base.Add(2*time.Hour))
	}
	if main.VsDefault != nil {
		t.Errorf("main.VsDefault = %+v, want none on the default branch itself", *main.VsDefault)
	}

	tests := []struct {
		name string
		want Divergence
	}{
		{"topic", Divergence{Ahead: 1, Behind: 2}},
		{"stale", Divergence{Ahead: 0, Behind: 2}},
	}
	for _, tt := range tests {
		b := findBranch(t, list.Local, tt.name)
		if b.VsDefault == nil || *b.VsDefault != tt.want {
			t.Errorf("%s.VsDefault = %v, want %+v", tt.name, b.VsDefault, tt.want)
		}
	}
}

func TestBranches_NoDefaultBranch(t *testing.T) {
	dir, cleanup := setupTestRepoWithCommit(t)
	defer cleanup()
	runGit(t, dir, "branch", "-M", "trunk")
	runGit(t, dir, "branch", "topic")

	list, err := Branches(dir)
	if err != nil {
		t.Fatalf("Branches() error: %v", err)
	}
	if list.DefaultBranch != "" {
		t.Errorf("DefaultBranch = %q, want none", list.DefaultBranch)
	}
	for _, b := range list.Local {
		if b.VsDefault != nil {
			t.Errorf("%s.VsDefault = %+v, want none without a default branch", b.Name, *b.VsDefault)
		}
	}
}

// Counted against the remote's default branch when there is no local copy of it,
// which is how a fresh clone of a single feature branch looks.
func TestBranches_RemoteDefaultBranch(t *testing.T) {
	dir, cleanup := setupTestRepoWithCommit(t)
	defer cleanup()
	runGit(t, dir, "branch", "-M", "main")

	remote, remoteCleanup := setupBareRemote(t)
	defer remoteCleanup()
	runGit(t, dir, "remote", "add", "origin", remote)
	runGit(t, dir, "push", "-q", "origin", "main")
	runGit(t, dir, "checkout", "-q", "-b", "colleague")
	commitAt(t, dir, "colleague work", time.Now())
	runGit(t, dir, "push", "-q", "origin", "colleague")
	runGit(t, dir, "checkout", "-q", "-b", "topic", "main")
	commitAt(t, dir, "topic work", time.Now())
	runGit(t, dir, "branch", "-D", "main", "colleague")

	list, err := Branches(dir)
	if err != nil {
		t.Fatalf("Branches() error: %v", err)
	}
	if list.DefaultBranch != "origin/main" {
		t.Fatalf("DefaultBranch = %q, want origin/main", list.DefaultBranch)
	}
	topic := findBranch(t, list.Local, "topic")
	if topic.VsDefault == nil || *topic.VsDefault != (Divergence{Ahead: 1}) {
		t.Errorf("topic.VsDefault = %v, want 1 ahead, 0 behind", topic.VsDefault)
	}
	if len(list.RemoteOnly) != 2 {
		t.Fatalf("RemoteOnly = %+v, want origin/colleague and origin/main", list.RemoteOnly)
	}
	for _, r := range list.RemoteOnly {
		if r.CommittedAt.IsZero() {
			t.Errorf("%s has no commit time", r.Ref)
		}
		switch r.Ref {
		case "origin/main":
			if r.VsDefault != nil {
				t.Errorf("origin/main.VsDefault = %+v, want none on the default itself", *r.VsDefault)
			}
		case "origin/colleague":
			// Remote branches are counted only where git can do it in one pass.
			native, err := gitHasAheadBehind()
			if err != nil {
				t.Fatalf("gitHasAheadBehind() error: %v", err)
			}
			if native && (r.VsDefault == nil || *r.VsDefault != (Divergence{Ahead: 1})) {
				t.Errorf("origin/colleague.VsDefault = %v, want 1 ahead, 0 behind", r.VsDefault)
			}
		}
	}
}

// A refspec can map tags under refs/remotes, where a ref then points at a tag
// object with no committer date. It is no branch, and must not fail the list.
func TestBranches_SkipsRemoteRefToTagObject(t *testing.T) {
	dir, cleanup := setupTestRepoWithCommit(t)
	defer cleanup()
	runGit(t, dir, "tag", "-a", "v1", "-m", "release")
	runGit(t, dir, "remote", "add", "origin", dir)
	runGit(t, dir, "update-ref", "refs/remotes/origin/tags/v1", "refs/tags/v1")

	list, err := Branches(dir)
	if err != nil {
		t.Fatalf("Branches() error: %v", err)
	}
	if len(list.RemoteOnly) != 0 {
		t.Errorf("RemoteOnly = %+v, want the tag ref left out", list.RemoteOnly)
	}
}

// A ")" is legal in a ref name, and inside %(ahead-behind:...) it would end the
// atom early and fail the whole list.
func TestBranches_DefaultBranchNameWithParenthesis(t *testing.T) {
	dir, cleanup := setupTestRepoWithCommit(t)
	defer cleanup()
	runGit(t, dir, "branch", "-M", "re)lease")
	runGit(t, dir, "branch", "topic")
	runGit(t, dir, "commit", "-q", "--no-gpg-sign", "--allow-empty", "-m", "release work")

	remote, remoteCleanup := setupBareRemote(t)
	defer remoteCleanup()
	runGit(t, dir, "remote", "add", "origin", remote)
	runGit(t, dir, "push", "-q", "origin", "re)lease")
	runGit(t, dir, "remote", "set-head", "origin", "re)lease")

	list, err := Branches(dir)
	if err != nil {
		t.Fatalf("Branches() error: %v", err)
	}
	if list.DefaultBranch != "re)lease" {
		t.Errorf("DefaultBranch = %q, want re)lease", list.DefaultBranch)
	}
	topic := findBranch(t, list.Local, "topic")
	if topic.VsDefault == nil || *topic.VsDefault != (Divergence{Behind: 1}) {
		t.Errorf("topic.VsDefault = %v, want 0 ahead, 1 behind", topic.VsDefault)
	}
}

func TestDefaultBranchRef(t *testing.T) {
	refs := func(names ...string) []branchRef {
		var result []branchRef
		for _, n := range names {
			result = append(result, branchRef{ref: n})
		}
		return result
	}
	originHead := branchRef{ref: "refs/remotes/origin/HEAD", symref: "refs/remotes/origin/develop"}

	tests := []struct {
		name    string
		refs    []branchRef
		remotes []string
		want    string
	}{
		{
			name: "local main",
			refs: refs("refs/heads/topic", "refs/heads/main"),
			want: "refs/heads/main",
		},
		{
			name: "master when there is no main",
			refs: refs("refs/heads/master"),
			want: "refs/heads/master",
		},
		{
			name:    "local copy wins over the remote-tracking one",
			refs:    refs("refs/remotes/origin/main", "refs/heads/main"),
			remotes: []string{"origin"},
			want:    "refs/heads/main",
		},
		{
			name:    "remote-tracking when there is no local copy",
			refs:    refs("refs/heads/topic", "refs/remotes/origin/main"),
			remotes: []string{"origin"},
			want:    "refs/remotes/origin/main",
		},
		{
			name:    "origin/HEAD names the default",
			refs:    append(refs("refs/heads/main", "refs/heads/develop", "refs/remotes/origin/develop"), originHead),
			remotes: []string{"origin"},
			want:    "refs/heads/develop",
		},
		{
			name:    "origin/HEAD naming a pruned branch falls back to main",
			refs:    append(refs("refs/heads/main"), originHead),
			remotes: []string{"origin"},
			want:    "refs/heads/main",
		},
		{
			name:    "a lone remote stands in for origin",
			refs:    refs("refs/remotes/upstream/main"),
			remotes: []string{"upstream"},
			want:    "refs/remotes/upstream/main",
		},
		{
			name:    "no remote is picked among several without origin",
			refs:    refs("refs/remotes/a/main", "refs/remotes/b/main"),
			remotes: []string{"a", "b"},
			want:    "",
		},
		{
			name: "none",
			refs: refs("refs/heads/trunk"),
			want: "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var got string
			if r := defaultBranchRef(tt.refs, tt.remotes); r != nil {
				got = r.ref
			}
			if got != tt.want {
				t.Errorf("defaultBranchRef() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestBranches_Recent(t *testing.T) {
	dir, cleanup := setupTestRepoWithCommit(t)
	defer cleanup()
	runGit(t, dir, "branch", "-M", "main")
	for _, name := range []string{"a", "b", "c", "gone", "untouched"} {
		runGit(t, dir, "branch", name)
	}

	runGit(t, dir, "checkout", "-q", "gone")
	runGit(t, dir, "checkout", "-q", "a")
	runGit(t, dir, "checkout", "-q", "--detach", "HEAD")
	runGit(t, dir, "switch", "-q", "b")
	runGit(t, dir, "checkout", "-q", "c")
	runGit(t, dir, "branch", "-D", "gone")

	list, err := Branches(dir)
	if err != nil {
		t.Fatalf("Branches() error: %v", err)
	}
	// Deleted branches and detached commits are left out; a branch only ever
	// created, never checked out, is not recent.
	want := "c,b,a,main"
	if got := strings.Join(list.Recent, ","); got != want {
		t.Errorf("Recent = %v, want %s", list.Recent, want)
	}
}

// A worktree's reflog starts with no checkout entry, which is how every Pockode
// worktree begins; its own branch is still the most recent.
func TestBranches_RecentInFreshWorktree(t *testing.T) {
	dir, cleanup := setupTestRepoWithCommit(t)
	defer cleanup()
	linked := filepath.Join(filepath.Dir(dir), filepath.Base(dir)+"-fresh")
	runGit(t, dir, "worktree", "add", "-q", "-b", "fresh", linked)
	defer os.RemoveAll(linked)

	list, err := Branches(linked)
	if err != nil {
		t.Fatalf("Branches() error: %v", err)
	}
	if strings.Join(list.Recent, ",") != "fresh" {
		t.Errorf("Recent = %v, want [fresh]", list.Recent)
	}
}

// An unborn branch has no reflog to read and nothing to count, and still lists.
func TestBranches_Unborn(t *testing.T) {
	dir, cleanup := setupTestRepo(t)
	defer cleanup()

	list, err := Branches(dir)
	if err != nil {
		t.Fatalf("Branches() error: %v", err)
	}
	if list.Recent == nil || len(list.Recent) != 0 || len(list.Local) != 0 {
		t.Errorf("Branches() = %+v, want no branches and an empty recent list", list)
	}
}
