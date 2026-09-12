package git

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
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

	if err := CreateBranch(dir, "feature/new"); err != nil {
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
