package git

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// setupDiscardRepo is a repository holding one committed file.
func setupDiscardRepo(t *testing.T) (string, func()) {
	t.Helper()
	dir, cleanup := setupTestRepo(t)
	writeTestFile(t, dir, "file.txt", "committed\n")
	runGit(t, dir, "add", "file.txt")
	runGit(t, dir, "commit", "--no-gpg-sign", "-m", "initial")
	return dir, cleanup
}

func readTestFile(t *testing.T, dir, path string) string {
	t.Helper()
	content, err := os.ReadFile(filepath.Join(dir, path))
	if err != nil {
		t.Fatalf("failed to read %q: %v", path, err)
	}
	return string(content)
}

func requireGone(t *testing.T, dir, path string) {
	t.Helper()
	if _, err := os.Lstat(filepath.Join(dir, path)); !os.IsNotExist(err) {
		t.Errorf("%q still exists after discard (lstat error: %v)", path, err)
	}
}

func TestDiscard_RestoresTrackedFile(t *testing.T) {
	dir, cleanup := setupDiscardRepo(t)
	defer cleanup()

	writeTestFile(t, dir, "file.txt", "edited\n")

	if err := Discard(dir, []string{"file.txt"}); err != nil {
		t.Fatalf("Discard() error: %v", err)
	}

	if got := readTestFile(t, dir, "file.txt"); got != "committed\n" {
		t.Errorf("file.txt = %q, want %q", got, "committed\n")
	}
}

// A deleted tracked file comes back: its unstaged status is the deletion, and
// discarding that is what puts the file on disk again.
func TestDiscard_RestoresDeletedFile(t *testing.T) {
	dir, cleanup := setupDiscardRepo(t)
	defer cleanup()

	if err := os.Remove(filepath.Join(dir, "file.txt")); err != nil {
		t.Fatalf("failed to remove file.txt: %v", err)
	}

	if err := Discard(dir, []string{"file.txt"}); err != nil {
		t.Fatalf("Discard() error: %v", err)
	}

	if got := readTestFile(t, dir, "file.txt"); got != "committed\n" {
		t.Errorf("file.txt = %q, want %q", got, "committed\n")
	}
}

// Discard is offered on unstaged rows, so it must restore from the index rather
// than from HEAD: work the user already staged is not what they asked to lose.
func TestDiscard_KeepsStagedContent(t *testing.T) {
	dir, cleanup := setupDiscardRepo(t)
	defer cleanup()

	writeTestFile(t, dir, "file.txt", "staged\n")
	runGit(t, dir, "add", "file.txt")
	writeTestFile(t, dir, "file.txt", "staged then edited again\n")

	if err := Discard(dir, []string{"file.txt"}); err != nil {
		t.Fatalf("Discard() error: %v", err)
	}

	if got := readTestFile(t, dir, "file.txt"); got != "staged\n" {
		t.Errorf("file.txt = %q, want the staged content %q", got, "staged\n")
	}
	status, err := Status(dir)
	if err != nil {
		t.Fatalf("Status() error: %v", err)
	}
	if len(status.Staged) != 1 || status.Staged[0].Path != "file.txt" {
		t.Errorf("staged = %v, want file.txt still staged", status.Staged)
	}
	if len(status.Unstaged) != 0 {
		t.Errorf("unstaged = %v, want empty", status.Unstaged)
	}
}

func TestDiscard_DeletesUntrackedFile(t *testing.T) {
	dir, cleanup := setupDiscardRepo(t)
	defer cleanup()

	writeTestFile(t, dir, "notes.txt", "scratch\n")

	if err := Discard(dir, []string{"notes.txt"}); err != nil {
		t.Fatalf("Discard() error: %v", err)
	}

	requireGone(t, dir, "notes.txt")
}

func TestDiscard_DeletesUntrackedFileInNewDirectory(t *testing.T) {
	dir, cleanup := setupDiscardRepo(t)
	defer cleanup()

	writeTestFile(t, dir, "newdir/notes.txt", "scratch\n")

	if err := Discard(dir, []string{"newdir/notes.txt"}); err != nil {
		t.Fatalf("Discard() error: %v", err)
	}

	requireGone(t, dir, "newdir/notes.txt")
}

// One call from the group header carries both kinds, and each path has to get
// the treatment its own status calls for.
func TestDiscard_MixedBatch(t *testing.T) {
	dir, cleanup := setupDiscardRepo(t)
	defer cleanup()

	writeTestFile(t, dir, "second.txt", "second\n")
	runGit(t, dir, "add", "second.txt")
	runGit(t, dir, "commit", "--no-gpg-sign", "-m", "second")

	writeTestFile(t, dir, "file.txt", "edited\n")
	writeTestFile(t, dir, "second.txt", "also edited\n")
	writeTestFile(t, dir, "notes.txt", "scratch\n")
	writeTestFile(t, dir, "other.txt", "scratch\n")

	paths := []string{"file.txt", "notes.txt", "second.txt", "other.txt"}
	if err := Discard(dir, paths); err != nil {
		t.Fatalf("Discard() error: %v", err)
	}

	if got := readTestFile(t, dir, "file.txt"); got != "committed\n" {
		t.Errorf("file.txt = %q, want %q", got, "committed\n")
	}
	if got := readTestFile(t, dir, "second.txt"); got != "second\n" {
		t.Errorf("second.txt = %q, want %q", got, "second\n")
	}
	requireGone(t, dir, "notes.txt")
	requireGone(t, dir, "other.txt")

	status, err := Status(dir)
	if err != nil {
		t.Fatalf("Status() error: %v", err)
	}
	if len(status.Unstaged) != 0 {
		t.Errorf("unstaged = %v, want empty", status.Unstaged)
	}
}

// The panel lists submodule files alongside the root repository's, so discard
// has to resolve into the submodule the way Add and Reset do.
func TestDiscard_SubmoduleFile(t *testing.T) {
	dir, cleanup := setupTestRepoWithSubmodule(t)
	defer cleanup()

	writeTestFile(t, dir, "mysub/sub.txt", "edited\n")
	writeTestFile(t, dir, "mysub/scratch.txt", "untracked\n")

	if err := Discard(dir, []string{"mysub/sub.txt", "mysub/scratch.txt"}); err != nil {
		t.Fatalf("Discard() error: %v", err)
	}

	if got := readTestFile(t, dir, "mysub/sub.txt"); got != "sub content\n" {
		t.Errorf("mysub/sub.txt = %q, want %q", got, "sub content\n")
	}
	requireGone(t, dir, "mysub/scratch.txt")
}

// git clean walks past a directory that holds its own repository without a word
// — exit 0, no output — and status keeps listing it, so the user would confirm
// a deletion and see nothing happen. The failure has to be reported.
func TestDiscard_ReportsEmbeddedRepositoryLeftBehind(t *testing.T) {
	dir, cleanup := setupDiscardRepo(t)
	defer cleanup()

	nested := filepath.Join(dir, "nested")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatalf("failed to create nested dir: %v", err)
	}
	runGit(t, nested, "init")
	writeTestFile(t, dir, "nested/a.txt", "a\n")

	status, err := Status(dir)
	if err != nil {
		t.Fatalf("Status() error: %v", err)
	}
	// git reports the embedded repository as one entry with a trailing slash,
	// which is the path the panel would send back.
	if len(status.Unstaged) != 1 || status.Unstaged[0].Path != "nested/" {
		t.Fatalf("unstaged = %v, want a single \"nested/\" entry", status.Unstaged)
	}

	err = Discard(dir, []string{"nested/"})
	if err == nil {
		t.Fatal("Discard() succeeded, want a report that nested/ survived")
	}
	if !strings.Contains(err.Error(), "nested/") {
		t.Errorf("error = %q, want it to name nested/", err)
	}
}

// The same report, but for a path inside a submodule, where the path git runs
// against ("nested/") and the path the panel lists ("mysub/nested/") are not the
// same string. The message has to use the one the user can find in the list.
func TestDiscard_ReportsEmbeddedRepositoryUsingTheRequestedPath(t *testing.T) {
	dir, cleanup := setupTestRepoWithSubmodule(t)
	defer cleanup()

	nested := filepath.Join(dir, "mysub", "nested")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatalf("failed to create nested dir: %v", err)
	}
	runGit(t, nested, "init")
	writeTestFile(t, dir, "mysub/nested/a.txt", "a\n")

	err := Discard(dir, []string{"mysub/nested/"})
	if err == nil {
		t.Fatal("Discard() succeeded, want a report that mysub/nested/ survived")
	}
	if !strings.Contains(err.Error(), "mysub/nested/") {
		t.Errorf("error = %q, want it to name mysub/nested/ as the panel does", err)
	}
}

// A path is a pathspec once it reaches git, and pathspec magic is spelled in
// the leading characters of the name itself. Without :(literal), deleting the
// one file named ":!important.txt" reads as "everything except important.txt"
// and takes every other untracked file with it, exiting 0.
func TestDiscard_TreatsPathspecMagicInNamesAsLiteral(t *testing.T) {
	magic := pathspecMagicName(t)
	dir, cleanup := setupDiscardRepo(t)
	defer cleanup()

	writeTestFile(t, dir, magic, "picked\n")
	writeTestFile(t, dir, "bystander.txt", "not picked\n")

	if err := Discard(dir, []string{magic}); err != nil {
		t.Fatalf("Discard() error: %v", err)
	}

	requireGone(t, dir, magic)
	if got := readTestFile(t, dir, "bystander.txt"); got != "not picked\n" {
		t.Errorf("bystander.txt = %q, want it untouched", got)
	}
}

// A path that is exactly a submodule's directory resolves to nothing inside it,
// and ":(literal)" with no path behind it matches everything — that request has
// to be refused, not obeyed with the whole submodule as the target.
func TestDiscard_RejectsSubmoduleRootAsPath(t *testing.T) {
	dir, cleanup := setupTestRepoWithSubmodule(t)
	defer cleanup()

	writeTestFile(t, dir, "mysub/sub.txt", "edited\n")
	writeTestFile(t, dir, "mysub/scratch.txt", "untracked\n")

	if err := Discard(dir, []string{"mysub/"}); err == nil {
		t.Fatal("Discard() accepted a submodule directory as a path")
	}

	if got := readTestFile(t, dir, "mysub/sub.txt"); got != "edited\n" {
		t.Errorf("mysub/sub.txt = %q, want the rejected call to have changed nothing", got)
	}
	if got := readTestFile(t, dir, "mysub/scratch.txt"); got != "untracked\n" {
		t.Errorf("mysub/scratch.txt = %q, want it still there", got)
	}
}

func TestDiscard_RejectsPathTraversal(t *testing.T) {
	dir, cleanup := setupDiscardRepo(t)
	defer cleanup()

	writeTestFile(t, dir, "file.txt", "edited\n")

	// The bad path comes second: validation has to happen up front, or the first
	// path is already discarded by the time the second is rejected.
	if err := Discard(dir, []string{"file.txt", "../outside.txt"}); err == nil {
		t.Fatal("Discard() accepted a path outside the repository")
	}

	if got := readTestFile(t, dir, "file.txt"); got != "edited\n" {
		t.Errorf("file.txt = %q, want the rejected call to have changed nothing", got)
	}
}

func TestDiscard_RejectsEmptyPathList(t *testing.T) {
	dir, cleanup := setupDiscardRepo(t)
	defer cleanup()

	if err := Discard(dir, nil); err == nil {
		t.Error("Discard() accepted an empty path list")
	}
}

// A conflicted path is refused by name, and nothing else in the batch is
// touched: the refusal comes before any group runs.
func TestDiscard_RefusesConflictedPaths(t *testing.T) {
	dir, _, _ := setupDivergedRepo(t)
	writeTestFile(t, dir, "untracked.txt", "keep me\n")
	gitConflicts(t, dir, "merge", "feature")

	err := Discard(dir, []string{"untracked.txt", "conflict.txt"})
	var conflicted *ConflictedPathsError
	if !errors.As(err, &conflicted) {
		t.Fatalf("Discard() error = %v, want ConflictedPathsError", err)
	}
	if !reflect.DeepEqual(conflicted.Paths, []string{"conflict.txt"}) {
		t.Errorf("Paths = %v, want [conflict.txt]", conflicted.Paths)
	}
	if got := readTestFile(t, dir, "untracked.txt"); got != "keep me\n" {
		t.Errorf("untracked.txt = %q, want it left alone", got)
	}
	if got := mustStatus(t, dir).Conflicted; !reflect.DeepEqual(got, []string{"conflict.txt"}) {
		t.Errorf("Conflicted = %v, want [conflict.txt]", got)
	}
}

// Staging or unstaging a conflicted path would end its conflict unresolved,
// so the batch is refused whole; Resolve is the stage that means it.
func TestStaging_RefusesConflictedPaths(t *testing.T) {
	dir, _, _ := setupDivergedRepo(t)
	writeTestFile(t, dir, "other.txt", "x\n")
	gitConflicts(t, dir, "merge", "feature")

	for name, write := range map[string]func(string, ...string) error{"Add": Add, "Reset": Reset} {
		err := write(dir, "other.txt", "conflict.txt")
		var conflicted *ConflictedPathsError
		if !errors.As(err, &conflicted) {
			t.Fatalf("%s() error = %v, want ConflictedPathsError", name, err)
		}
		if !reflect.DeepEqual(conflicted.Paths, []string{"conflict.txt"}) {
			t.Errorf("%s(): Paths = %v, want [conflict.txt]", name, conflicted.Paths)
		}
	}
	status := mustStatus(t, dir)
	if !reflect.DeepEqual(status.Conflicted, []string{"conflict.txt"}) {
		t.Errorf("Conflicted = %v, want [conflict.txt]", status.Conflicted)
	}
	if status.HasFile("other.txt", true) {
		t.Error("other.txt was staged alongside the refused path")
	}

	if err := Resolve(dir, "conflict.txt"); err != nil {
		t.Fatalf("Resolve() error: %v", err)
	}
	if got := mustStatus(t, dir).Conflicted; got != nil {
		t.Errorf("Conflicted after Resolve = %v, want none", got)
	}
}

// Inside a submodule, and by the directory that holds them, conflicted files
// are found where the write would reach them, and named as the list names them.
func TestStaging_RefusesConflictedPathsInSubmoduleAndDirectory(t *testing.T) {
	dir, cleanup := setupTestRepoWithSubmodule(t)
	defer cleanup()
	sub := filepath.Join(dir, "mysub")
	writeTestFile(t, sub, "d/x.txt", "base\n")
	runGit(t, sub, "add", "d/x.txt")
	runGit(t, sub, "commit", "--no-gpg-sign", "-qm", "base")
	runGit(t, sub, "checkout", "-q", "-b", "other")
	writeTestFile(t, sub, "d/x.txt", "other\n")
	runGit(t, sub, "commit", "--no-gpg-sign", "-qam", "other")
	runGit(t, sub, "checkout", "-q", "-")
	writeTestFile(t, sub, "d/x.txt", "mine\n")
	runGit(t, sub, "commit", "--no-gpg-sign", "-qam", "mine")
	gitConflicts(t, sub, "merge", "other")

	discard := func(dir string, paths ...string) error { return Discard(dir, paths) }
	writes := map[string]func(string, ...string) error{"Add": Add, "Reset": Reset, "Discard": discard}
	for name, write := range writes {
		for _, path := range []string{"mysub/d/x.txt", "mysub/d"} {
			err := write(dir, "parent.txt", path)
			var conflicted *ConflictedPathsError
			if !errors.As(err, &conflicted) {
				t.Fatalf("%s(%s) error = %v, want ConflictedPathsError", name, path, err)
			}
			if !reflect.DeepEqual(conflicted.Paths, []string{"mysub/d/x.txt"}) {
				t.Errorf("%s(%s): Paths = %v, want [mysub/d/x.txt]", name, path, conflicted.Paths)
			}
		}
	}

	if err := Resolve(dir, "mysub/d/x.txt"); err != nil {
		t.Fatalf("Resolve() error: %v", err)
	}
	if got := mustStatus(t, dir).Submodules["mysub"].Conflicted; got != nil {
		t.Errorf("submodule Conflicted after Resolve = %v, want none", got)
	}
}
