package datadir

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func runGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	// stdout only: a warning on stderr must not read as a status line.
	var stderr strings.Builder
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, stderr.String())
	}
	return string(out)
}

func writeFile(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
}

// The contract is what git makes of the file, so it is asked directly rather
// than the patterns being compared against a string.
func TestEnsureGitignore_LeavesOnlyTheAgentRoleIndexVisibleToGit(t *testing.T) {
	repo := t.TempDir()
	runGit(t, repo, "init")
	dataDir := filepath.Join(repo, ".pockode")

	if err := EnsureGitignore(dataDir); err == nil {
		t.Fatal("expected an error when the directory does not exist")
	}
	if err := os.Mkdir(dataDir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := EnsureGitignore(dataDir); err != nil {
		t.Fatalf("EnsureGitignore: %v", err)
	}

	for _, p := range []string{
		"server.log",
		"sessions.json",
		"sessions/abc/events.jsonl",
		"works/index.json",
		"agent-roles/other.json",
		"worktrees/feature/agent-roles/index.json",
	} {
		writeFile(t, filepath.Join(dataDir, filepath.FromSlash(p)))
	}
	writeFile(t, filepath.Join(dataDir, "agent-roles", "index.json"))
	writeFile(t, filepath.Join(repo, "main.go"))

	got := runGit(t, repo, "status", "--porcelain", "--untracked-files=all")
	want := "?? .pockode/agent-roles/index.json\n?? main.go\n"
	if got != want {
		t.Errorf("git status:\ngot:\n%s\nwant:\n%s", got, want)
	}
}

func TestEnsureGitignore_ReplacesAStaleFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".gitignore")
	if err := os.WriteFile(path, []byte("# an older build's rules, or a user's edit\n/*\n"), 0644); err != nil {
		t.Fatal(err)
	}

	if err := EnsureGitignore(dir); err != nil {
		t.Fatalf("EnsureGitignore: %v", err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != gitignoreContent {
		t.Errorf("stale .gitignore was not replaced: %q", data)
	}
}
