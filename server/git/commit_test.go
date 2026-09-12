package git

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// setupCommitRepo is a repository with one commit and signing off, so the tests
// do not depend on the machine's global commit.gpgsign.
func setupCommitRepo(t *testing.T) (string, func()) {
	t.Helper()
	dir, cleanup := setupTestRepo(t)
	runGit(t, dir, "config", "commit.gpgsign", "false")
	writeTestFile(t, dir, "file.txt", "content\n")
	runGit(t, dir, "add", "file.txt")
	runGit(t, dir, "commit", "--no-gpg-sign", "-m", "initial")
	return dir, cleanup
}

func TestCommit(t *testing.T) {
	dir, cleanup := setupCommitRepo(t)
	defer cleanup()

	writeTestFile(t, dir, "file.txt", "changed\n")
	runGit(t, dir, "add", "file.txt")

	if err := CreateCommit(dir, "Change the file", false); err != nil {
		t.Fatalf("CreateCommit() error: %v", err)
	}

	if subject := gitOutput(t, dir, "log", "-1", "--format=%s"); subject != "Change the file" {
		t.Errorf("commit subject = %q, want %q", subject, "Change the file")
	}
	if count := gitOutput(t, dir, "rev-list", "--count", "HEAD"); count != "2" {
		t.Errorf("commit count = %s, want 2", count)
	}
	status, err := Status(dir)
	if err != nil {
		t.Fatalf("Status() error: %v", err)
	}
	if len(status.Staged) != 0 {
		t.Errorf("index still holds %v after committing", status.Staged)
	}
}

// A body separated from the subject by a blank line has to survive the round
// trip: the sheet's textarea sends one string, and git splits it itself.
func TestCommit_KeepsMessageBody(t *testing.T) {
	dir, cleanup := setupCommitRepo(t)
	defer cleanup()

	writeTestFile(t, dir, "file.txt", "changed\n")
	runGit(t, dir, "add", "file.txt")

	message := "Subject line\n\nBody explaining why.\n"
	if err := CreateCommit(dir, message, false); err != nil {
		t.Fatalf("CreateCommit() error: %v", err)
	}

	if got := gitOutput(t, dir, "log", "-1", "--format=%B"); got != strings.TrimSpace(message) {
		t.Errorf("commit message = %q, want %q", got, strings.TrimSpace(message))
	}
}

func TestCommit_Amend(t *testing.T) {
	dir, cleanup := setupCommitRepo(t)
	defer cleanup()

	writeTestFile(t, dir, "extra.txt", "extra\n")
	runGit(t, dir, "add", "extra.txt")

	if err := CreateCommit(dir, "initial, corrected", true); err != nil {
		t.Fatalf("CreateCommit(amend) error: %v", err)
	}

	if count := gitOutput(t, dir, "rev-list", "--count", "HEAD"); count != "1" {
		t.Errorf("amend produced %s commits, want the original 1", count)
	}
	if subject := gitOutput(t, dir, "log", "-1", "--format=%s"); subject != "initial, corrected" {
		t.Errorf("amended subject = %q", subject)
	}
	// The staged file joins the replaced commit rather than staying behind.
	if files := gitOutput(t, dir, "show", "--name-only", "--format=", "HEAD"); !strings.Contains(files, "extra.txt") {
		t.Errorf("amended commit files = %q, want extra.txt included", files)
	}
}

// Amending with nothing staged is how the last commit's message is corrected.
func TestCommit_AmendMessageOnly(t *testing.T) {
	dir, cleanup := setupCommitRepo(t)
	defer cleanup()

	if err := CreateCommit(dir, "reworded", true); err != nil {
		t.Fatalf("CreateCommit(amend) error: %v", err)
	}

	if subject := gitOutput(t, dir, "log", "-1", "--format=%s"); subject != "reworded" {
		t.Errorf("amended subject = %q, want %q", subject, "reworded")
	}
}

func TestCommit_EmptyMessage(t *testing.T) {
	dir, cleanup := setupCommitRepo(t)
	defer cleanup()

	if err := CreateCommit(dir, "  \n ", false); err == nil {
		t.Fatal("CreateCommit() with a blank message succeeded, want an error")
	}
}

// git announces an empty index on stdout and exits non-zero with nothing on
// stderr. Reported from stderr alone this would reach the user as "exit status
// 1", which says nothing about what to do next.
func TestCommit_NothingStagedExplainsItself(t *testing.T) {
	dir, cleanup := setupCommitRepo(t)
	defer cleanup()

	err := CreateCommit(dir, "nothing here", false)
	if err == nil {
		t.Fatal("CreateCommit() with an empty index succeeded, want an error")
	}
	if !strings.Contains(err.Error(), "nothing to commit") {
		t.Errorf("error = %q, want git's own explanation", err.Error())
	}
}

// A pre-commit hook's rejection is the message the user has to act on.
func TestCommit_ReportsHookOutput(t *testing.T) {
	dir, cleanup := setupCommitRepo(t)
	defer cleanup()

	writeHook(t, dir, "pre-commit", "#!/bin/sh\necho 'lint failed: trailing whitespace' >&2\nexit 1\n")

	writeTestFile(t, dir, "file.txt", "changed\n")
	runGit(t, dir, "add", "file.txt")

	err := CreateCommit(dir, "Change the file", false)
	if err == nil {
		t.Fatal("CreateCommit() succeeded despite a failing pre-commit hook")
	}
	if !strings.Contains(err.Error(), "lint failed: trailing whitespace") {
		t.Errorf("error = %q, want the hook's own message", err.Error())
	}
}

// Committing the root repository leaves a submodule's staged files in the
// submodule's index — the reason the sheet lists them as not included.
func TestCommit_LeavesSubmoduleFilesStaged(t *testing.T) {
	dir, cleanup := setupTestRepoWithSubmodule(t)
	defer cleanup()
	runGit(t, dir, "config", "commit.gpgsign", "false")

	writeTestFile(t, dir, "root.txt", "root\n")
	runGit(t, dir, "add", "root.txt")
	writeTestFile(t, dir, "mysub/sub.txt", "changed\n")
	if err := Add(dir, "mysub/sub.txt"); err != nil {
		t.Fatalf("Add() error: %v", err)
	}

	if err := CreateCommit(dir, "root only", false); err != nil {
		t.Fatalf("CreateCommit() error: %v", err)
	}

	status, err := Status(dir)
	if err != nil {
		t.Fatalf("Status() error: %v", err)
	}
	if len(status.Staged) != 0 {
		t.Errorf("root index still holds %v", status.Staged)
	}
	sub, ok := status.Submodules["mysub"]
	if !ok {
		t.Fatal("submodule missing from status")
	}
	if len(sub.Staged) != 1 || sub.Staged[0].Path != "sub.txt" {
		t.Errorf("submodule staged = %v, want sub.txt still staged", sub.Staged)
	}
}

// Head carries the message amend prefills the sheet with, byte for byte.
func TestHead_Message(t *testing.T) {
	dir, cleanup := setupCommitRepo(t)
	defer cleanup()

	writeTestFile(t, dir, "file.txt", "changed\n")
	runGit(t, dir, "add", "file.txt")
	runGit(t, dir, "commit", "--no-gpg-sign", "-m", "Subject line\n\nBody explaining why.")

	head, err := Head(dir)
	if err != nil {
		t.Fatalf("Head() error: %v", err)
	}
	if head.Message != "Subject line\n\nBody explaining why." {
		t.Errorf("Head().Message = %q", head.Message)
	}
}

// Before the first commit there is no message, and reading it must not fail.
func TestHead_MessageUnborn(t *testing.T) {
	dir, cleanup := setupTestRepo(t)
	defer cleanup()

	head, err := Head(dir)
	if err != nil {
		t.Fatalf("Head() error: %v", err)
	}
	if head.Message != "" {
		t.Errorf("Head().Message = %q, want empty before the first commit", head.Message)
	}
}

// A repository configured with log.showSignature=true makes git print the
// signature verification before the format output. Read without guarding
// against it, that text becomes the message amend prefills — and the amend
// then writes it into the commit.
func TestHead_MessageIgnoresSignatureOutput(t *testing.T) {
	dir, cleanup := setupCommitRepo(t)
	defer cleanup()

	signCommits(t, dir)
	writeTestFile(t, dir, "file.txt", "changed\n")
	runGit(t, dir, "add", "file.txt")
	runGit(t, dir, "commit", "-S", "-m", "Real subject line")
	runGit(t, dir, "config", "log.showSignature", "true")

	head, err := Head(dir)
	if err != nil {
		t.Fatalf("Head() error: %v", err)
	}
	if head.Message != "Real subject line" {
		t.Errorf("Head().Message = %q, want the message alone", head.Message)
	}
}

// signCommits configures dir to sign with a throwaway ssh key, skipping the
// test where the tooling for it is unavailable.
func signCommits(t *testing.T, dir string) {
	t.Helper()
	if _, err := exec.LookPath("ssh-keygen"); err != nil {
		t.Skip("ssh-keygen is not available to sign a commit with")
	}

	key := filepath.Join(t.TempDir(), "signing-key")
	if out, err := exec.Command("ssh-keygen", "-t", "ed25519", "-N", "", "-f", key, "-q").CombinedOutput(); err != nil {
		t.Skipf("could not generate a signing key: %v\n%s", err, out)
	}

	// ssh signing needs git 2.34+; older git rejects the format outright.
	cmd := exec.Command("git", "config", "gpg.format", "ssh")
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Skipf("git does not support ssh signing: %v\n%s", err, out)
	}
	runGit(t, dir, "config", "user.signingkey", key+".pub")
}

// writeHook installs an executable git hook in dir.
func writeHook(t *testing.T, dir, name, script string) {
	t.Helper()
	path := filepath.Join(dir, ".git", "hooks", name)
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatalf("failed to write %s hook: %v", name, err)
	}
}
