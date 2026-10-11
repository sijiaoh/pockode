package watch

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pockode/server/contents"
)

// A file that was unchanged and is now over the limit reads as an empty diff
// both times — no diff, no contents — so only the omission can tell the poll
// that anything happened.
func TestGitDiffWatcher_NotifiesWhenFileGrowsPastLimit(t *testing.T) {
	dir := t.TempDir()
	for _, args := range [][]string{
		{"init"},
		{"config", "user.email", "test@test.com"},
		{"config", "user.name", "Test"},
		{"config", "commit.gpgsign", "false"},
	} {
		runGit(t, dir, args...)
	}
	path := filepath.Join(dir, "big.txt")
	if err := os.WriteFile(path, []byte("small\n"), 0644); err != nil {
		t.Fatal(err)
	}
	runGit(t, dir, "add", ".")
	runGit(t, dir, "commit", "-m", "initial")

	w := NewGitDiffWatcher(dir)
	notifier := &captureNotifier{}
	if _, err := w.Subscribe("client-1", "big.txt", false, false, notifier); err != nil {
		t.Fatalf("Subscribe() error: %v", err)
	}

	big := strings.Repeat("a", contents.MaxFileSize+1)
	if err := os.WriteFile(path, []byte(big), 0644); err != nil {
		t.Fatal(err)
	}
	w.checkAll()

	if notifier.count() != 1 {
		t.Fatalf("got %d notifications, want 1", notifier.count())
	}
	var got map[string]any
	if err := json.Unmarshal(notifier.last(), &got); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{
		"id":          "client-1",
		"diff":        "",
		"old_content": "",
		"new_content": "",
		"omitted":     "too_large",
		"size":        float64(len(big)),
		"mime":        "text/plain; charset=utf-8",
		"limit":       float64(contents.MaxFileSize),
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %v, want %v", k, got[k], v)
		}
	}
}

func runGit(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v failed: %v\n%s", args, err, out)
	}
}
