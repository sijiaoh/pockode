package watch

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pockode/server/contents"
	"github.com/pockode/server/git"
)

// A file that was unchanged and is now over the limit reads as an empty diff
// both times — no diff, no contents — so only the omission can tell the poll
// that anything happened.
func TestGitDiffWatcher_NotifiesWhenFileGrowsPastLimit(t *testing.T) {
	dir := initRepo(t)
	path := filepath.Join(dir, "big.txt")
	writeFile(t, path, "small\n")
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

// One poll reads the status once for every subscription, and each still
// reports only its own file's changes.
func TestGitDiffWatcher_PollSharesOneStatus(t *testing.T) {
	dir := initRepo(t)
	for _, name := range []string{"a.txt", "b.txt"} {
		writeFile(t, filepath.Join(dir, name), "one\n")
	}
	runGit(t, dir, "add", ".")
	runGit(t, dir, "commit", "-m", "initial")

	w := NewGitDiffWatcher(dir)
	snapshots := 0
	w.newSnapshot = func(dir string) (*git.DiffSnapshot, error) {
		snapshots++
		return git.NewDiffSnapshot(dir)
	}
	notifierA, notifierB := &captureNotifier{}, &captureNotifier{}
	if _, err := w.Subscribe("a", "a.txt", false, false, notifierA); err != nil {
		t.Fatalf("Subscribe(a) error: %v", err)
	}
	if _, err := w.Subscribe("b", "b.txt", false, false, notifierB); err != nil {
		t.Fatalf("Subscribe(b) error: %v", err)
	}

	poll := func(wantA, wantB int) {
		t.Helper()
		before := snapshots
		w.checkAll()
		if got := snapshots - before; got != 1 {
			t.Errorf("poll read the status %d times, want 1", got)
		}
		if notifierA.count() != wantA || notifierB.count() != wantB {
			t.Errorf("notifications a=%d b=%d, want a=%d b=%d", notifierA.count(), notifierB.count(), wantA, wantB)
		}
	}

	writeFile(t, filepath.Join(dir, "a.txt"), "two\n")
	poll(1, 0)
	poll(1, 0)
	writeFile(t, filepath.Join(dir, "b.txt"), "two\n")
	poll(1, 1)
}

func initRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	for _, args := range [][]string{
		{"init"},
		{"config", "user.email", "test@test.com"},
		{"config", "user.name", "Test"},
		{"config", "commit.gpgsign", "false"},
	} {
		runGit(t, dir, args...)
	}
	return dir
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
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
