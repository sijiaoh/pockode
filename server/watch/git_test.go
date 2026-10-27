package watch

import (
	"os"
	"path/filepath"
	"testing"
)

// A file edited again keeps its " M" in `git status`, but its line counts move,
// and the client shows those.
func TestGitWatcher_StateChangesWithLineCounts(t *testing.T) {
	dir := t.TempDir()
	for _, args := range [][]string{
		{"init"},
		{"config", "user.email", "test@test.com"},
		{"config", "user.name", "Test"},
		{"config", "commit.gpgsign", "false"},
	} {
		runGit(t, dir, args...)
	}
	path := filepath.Join(dir, "a.txt")
	if err := os.WriteFile(path, []byte("one\n"), 0644); err != nil {
		t.Fatal(err)
	}
	runGit(t, dir, "add", ".")
	runGit(t, dir, "commit", "-m", "initial")

	if err := os.WriteFile(path, []byte("one\ntwo\n"), 0644); err != nil {
		t.Fatal(err)
	}
	w := NewGitWatcher(dir)
	before, ok := w.pollGitState()
	if !ok {
		t.Fatal("poll had no answer")
	}
	if again, _ := w.pollGitState(); again != before {
		t.Errorf("state changed between two polls of the same tree:\n%q\n%q", before, again)
	}

	if err := os.WriteFile(path, []byte("one\ntwo\nthree\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if after, _ := w.pollGitState(); after == before {
		t.Errorf("state did not change after another line was added: %q", after)
	}
}
