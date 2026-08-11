package worktree

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestNewRegistry_NonGitRepo(t *testing.T) {
	dir := resolveSymlinks(t, t.TempDir())

	r := NewRegistry(dir, "")

	if r.IsGitRepo() {
		t.Error("expected IsGitRepo() = false for non-git directory")
	}
	if r.MainDir() != dir {
		t.Errorf("MainDir() = %q, want %q", r.MainDir(), dir)
	}
}

func TestNewRegistry_GitRepo(t *testing.T) {
	dir := initGitRepo(t)

	r := NewRegistry(dir, "")

	if !r.IsGitRepo() {
		t.Error("expected IsGitRepo() = true for git repository")
	}
}

func TestResolve_MainWorktree(t *testing.T) {
	dir := resolveSymlinks(t, t.TempDir())
	r := NewRegistry(dir, "")

	path, err := r.Resolve("")
	if err != nil {
		t.Fatalf("Resolve(\"\") failed: %v", err)
	}
	if path != dir {
		t.Errorf("Resolve(\"\") = %q, want %q", path, dir)
	}
}

func TestResolve_NonGitRepo(t *testing.T) {
	dir := t.TempDir()
	r := NewRegistry(dir, "")

	_, err := r.Resolve("some-worktree")
	if err != ErrNotGitRepo {
		t.Errorf("Resolve() error = %v, want ErrNotGitRepo", err)
	}
}

func TestResolve_NotFound(t *testing.T) {
	dir := initGitRepo(t)
	r := NewRegistry(dir, "")

	_, err := r.Resolve("nonexistent")
	if err != ErrWorktreeNotFound {
		t.Errorf("Resolve() error = %v, want ErrWorktreeNotFound", err)
	}
}

func TestList_NonGitRepo(t *testing.T) {
	dir := t.TempDir()
	r := NewRegistry(dir, "")

	list := r.List()

	if len(list) != 1 {
		t.Fatalf("List() returned %d items, want 1", len(list))
	}
	if list[0].Name != "" {
		t.Errorf("List()[0].Name = %q, want empty string", list[0].Name)
	}
	if !list[0].IsMain {
		t.Error("List()[0].IsMain = false, want true")
	}
}

func TestList_GitRepo(t *testing.T) {
	dir := initGitRepo(t)
	r := NewRegistry(dir, "")

	list := r.List()

	if len(list) < 1 {
		t.Fatal("List() returned empty list")
	}

	var found bool
	for _, info := range list {
		if info.IsMain && info.Name == "" {
			found = true
			break
		}
	}
	if !found {
		t.Error("List() does not contain main worktree")
	}
}

func TestCreate_Success(t *testing.T) {
	dir := initGitRepo(t)
	r := NewRegistry(dir, "")

	info, _, err := r.Create("feature", "feature-branch", "")
	if err != nil {
		t.Fatalf("Create() failed: %v", err)
	}

	if info.Name != "feature" {
		t.Errorf("info.Name = %q, want %q", info.Name, "feature")
	}
	if info.Branch != "feature-branch" {
		t.Errorf("info.Branch = %q, want %q", info.Branch, "feature-branch")
	}

	expectedPath := filepath.Join(r.worktreesDir(), "feature")
	if info.Path != expectedPath {
		t.Errorf("info.Path = %q, want %q", info.Path, expectedPath)
	}

	// Verify worktree exists on disk
	if _, err := os.Stat(info.Path); os.IsNotExist(err) {
		t.Error("worktree directory was not created")
	}

	// Verify Resolve works
	path, err := r.Resolve("feature")
	if err != nil {
		t.Fatalf("Resolve() failed after Create: %v", err)
	}
	if path != expectedPath {
		t.Errorf("Resolve() = %q, want %q", path, expectedPath)
	}
}

func TestCreate_ExistingBranch(t *testing.T) {
	dir := initGitRepo(t)
	r := NewRegistry(dir, "")

	cmd := exec.Command("git", "-C", dir, "branch", "existing-branch")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git branch failed: %s", out)
	}

	info, _, err := r.Create("feature", "existing-branch", "")
	if err != nil {
		t.Fatalf("Create() with existing branch failed: %v", err)
	}
	if info.Branch != "existing-branch" {
		t.Errorf("info.Branch = %q, want %q", info.Branch, "existing-branch")
	}
}

func TestCreate_RemoteBranch(t *testing.T) {
	dir := initGitRepo(t)
	r := NewRegistry(dir, "")

	cmd := exec.Command("git", "-C", dir, "remote", "add", "origin", "https://example.com/repo.git")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git remote add failed: %s", out)
	}
	cmd = exec.Command("git", "-C", dir, "update-ref", "refs/remotes/origin/feature-x", "HEAD")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git update-ref failed: %s", out)
	}

	info, _, err := r.Create("feature", "feature-x", "")
	if err != nil {
		t.Fatalf("Create() with remote branch failed: %v", err)
	}
	if info.Branch != "feature-x" {
		t.Errorf("info.Branch = %q, want %q", info.Branch, "feature-x")
	}
}

func TestCreate_WithBaseBranch(t *testing.T) {
	dir := initGitRepo(t)
	r := NewRegistry(dir, "")

	// Set up: base-branch and main diverge so we can verify which one is used
	cmd := exec.Command("git", "-C", dir, "checkout", "-b", "base-branch")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git checkout -b failed: %s", out)
	}
	cmd = exec.Command("git", "-C", dir, "commit", "--allow-empty", "-m", "base commit")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git commit failed: %s", out)
	}
	cmd = exec.Command("git", "-C", dir, "rev-parse", "base-branch")
	baseCommit, err := cmd.Output()
	if err != nil {
		t.Fatalf("git rev-parse failed: %v", err)
	}
	cmd = exec.Command("git", "-C", dir, "checkout", "-")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git checkout failed: %s", out)
	}
	cmd = exec.Command("git", "-C", dir, "commit", "--allow-empty", "-m", "main commit")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git commit failed: %s", out)
	}

	info, _, err := r.Create("feature", "feature-branch", "base-branch")
	if err != nil {
		t.Fatalf("Create() with base branch failed: %v", err)
	}
	if info.Branch != "feature-branch" {
		t.Errorf("info.Branch = %q, want %q", info.Branch, "feature-branch")
	}

	// Verify worktree is based on base-branch, not HEAD
	cmd = exec.Command("git", "-C", info.Path, "rev-parse", "HEAD")
	worktreeCommit, err := cmd.Output()
	if err != nil {
		t.Fatalf("git rev-parse in worktree failed: %v", err)
	}
	if string(worktreeCommit) != string(baseCommit) {
		t.Error("worktree should be based on base-branch, not current HEAD")
	}
}

func TestCreate_EmptyName(t *testing.T) {
	dir := initGitRepo(t)
	r := NewRegistry(dir, "")

	_, _, err := r.Create("", "branch", "")
	if err == nil {
		t.Error("Create() with empty name should fail")
	}
}

func TestCreate_EmptyBranch(t *testing.T) {
	dir := initGitRepo(t)
	r := NewRegistry(dir, "")

	_, _, err := r.Create("feature", "", "")
	if err == nil {
		t.Error("Create() with empty branch should fail")
	}
}

func TestCreate_Duplicate(t *testing.T) {
	dir := initGitRepo(t)
	r := NewRegistry(dir, "")

	_, _, err := r.Create("feature", "branch1", "")
	if err != nil {
		t.Fatalf("first Create() failed: %v", err)
	}

	_, _, err = r.Create("feature", "branch2", "")
	if err != ErrWorktreeAlreadyExist {
		t.Errorf("duplicate Create() error = %v, want ErrWorktreeAlreadyExist", err)
	}
}

func TestCreate_PathTraversal(t *testing.T) {
	dir := initGitRepo(t)
	r := NewRegistry(dir, "")

	_, _, err := r.Create("../escape", "branch", "")
	if err == nil {
		t.Fatal("Create() with path traversal should fail")
	}
	if !strings.Contains(err.Error(), "path traversal") {
		t.Errorf("expected path traversal error, got %v", err)
	}
}

func TestCreate_NonGitRepo(t *testing.T) {
	dir := t.TempDir()
	r := NewRegistry(dir, "")

	_, _, err := r.Create("feature", "branch", "")
	if err != ErrNotGitRepo {
		t.Errorf("Create() error = %v, want ErrNotGitRepo", err)
	}
}

func TestCreate_SetupHookFailure_CleansUpWorktree(t *testing.T) {
	// The rollback is triggered by the hook exiting non-zero, so the hook has to
	// actually run. With no shell RunSetupHook skips it and Create succeeds.
	requireHookShell(t)

	dir := initGitRepo(t)
	dataDir := t.TempDir()

	hookScript := `#!/bin/bash
exit 1
`
	hookPath := filepath.Join(dataDir, "worktree-setup.sh")
	if err := os.WriteFile(hookPath, []byte(hookScript), 0644); err != nil {
		t.Fatal(err)
	}

	r := NewRegistry(dir, dataDir)

	_, _, err := r.Create("feature", "feature-branch", "")
	if err == nil {
		t.Fatal("Create() should fail when setup hook fails")
	}
	if !strings.Contains(err.Error(), "setup hook failed") {
		t.Errorf("expected setup hook error, got: %v", err)
	}

	worktreePath := filepath.Join(r.worktreesDir(), "feature")
	if _, err := os.Stat(worktreePath); !os.IsNotExist(err) {
		t.Error("worktree should be cleaned up after hook failure")
	}

	_, err = r.Resolve("feature")
	if err != ErrWorktreeNotFound {
		t.Errorf("Resolve() error = %v, want ErrWorktreeNotFound", err)
	}
}

// A skipped hook must not fail creation, but it must not vanish either: the
// worktree is handed to the user as if it had been set up.
func TestCreate_SkippedSetupHookIsReported(t *testing.T) {
	dir := initGitRepo(t)
	dataDir := writeHook(t, "#!/bin/bash\nexit 0\n")
	stubMissingShell(t, "no bash found")

	r := NewRegistry(dir, dataDir)

	info, skipped, err := r.Create("feature", "feature-branch", "")
	if err != nil {
		t.Fatalf("a skipped hook must not fail creation: %v", err)
	}
	if info.Name != "feature" {
		t.Errorf("worktree should still be created, got name %q", info.Name)
	}
	if skipped == nil {
		t.Fatal("Create() must report the skipped setup hook")
	}
	if !strings.Contains(skipped.Reason, "no bash found") {
		t.Errorf("reason should carry the lookup failure, got: %q", skipped.Reason)
	}
}

func TestCreate_NoSkipReportedWhenHookRuns(t *testing.T) {
	requireHookShell(t)

	dir := initGitRepo(t)
	dataDir := writeHook(t, "#!/bin/bash\nexit 0\n")

	r := NewRegistry(dir, dataDir)

	if _, skipped, err := r.Create("feature", "feature-branch", ""); err != nil {
		t.Fatalf("unexpected error: %v", err)
	} else if skipped != nil {
		t.Errorf("hook ran, nothing was skipped, got: %+v", skipped)
	}
}

func TestDelete_Success(t *testing.T) {
	dir := initGitRepo(t)
	r := NewRegistry(dir, "")

	info, _, err := r.Create("to-delete", "delete-branch", "")
	if err != nil {
		t.Fatalf("Create() failed: %v", err)
	}

	err = r.Delete("to-delete")
	if err != nil {
		t.Fatalf("Delete() failed: %v", err)
	}

	// Verify worktree is removed from disk
	if _, err := os.Stat(info.Path); !os.IsNotExist(err) {
		t.Error("worktree directory still exists after Delete")
	}

	// Verify Resolve returns not found
	_, err = r.Resolve("to-delete")
	if err != ErrWorktreeNotFound {
		t.Errorf("Resolve() after Delete error = %v, want ErrWorktreeNotFound", err)
	}
}

func TestDelete_WithModifiedTrackedFile(t *testing.T) {
	dir := initGitRepo(t)
	r := NewRegistry(dir, "")

	info, _, err := r.Create("dirty-worktree", "dirty-branch", "")
	if err != nil {
		t.Fatalf("Create() failed: %v", err)
	}

	testFile := filepath.Join(info.Path, "tracked.txt")
	if err := os.WriteFile(testFile, []byte("original content"), 0644); err != nil {
		t.Fatalf("WriteFile() failed: %v", err)
	}
	cmd := exec.Command("git", "-C", info.Path, "add", "tracked.txt")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git add failed: %s", out)
	}
	cmd = exec.Command("git", "-C", info.Path, "commit", "-m", "add tracked file")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git commit failed: %s", out)
	}

	// Modified tracked files require --force to delete worktree
	if err := os.WriteFile(testFile, []byte("modified content"), 0644); err != nil {
		t.Fatalf("WriteFile() failed: %v", err)
	}

	err = r.Delete("dirty-worktree")
	if err != nil {
		t.Fatalf("Delete() with modified tracked file failed: %v", err)
	}

	if _, err := os.Stat(info.Path); !os.IsNotExist(err) {
		t.Error("worktree directory still exists after Delete")
	}
}

func TestDelete_MainWorktree(t *testing.T) {
	dir := initGitRepo(t)
	r := NewRegistry(dir, "")

	err := r.Delete("")
	if err != ErrMainWorktree {
		t.Errorf("Delete(\"\") error = %v, want ErrMainWorktree", err)
	}
}

func TestDelete_NotFound(t *testing.T) {
	dir := initGitRepo(t)
	r := NewRegistry(dir, "")

	err := r.Delete("nonexistent")
	if err != ErrWorktreeNotFound {
		t.Errorf("Delete() error = %v, want ErrWorktreeNotFound", err)
	}
}

func TestDelete_ExternalWorktreeNotVisible(t *testing.T) {
	dir := initGitRepo(t)
	r := NewRegistry(dir, "")

	// Create worktree outside of worktreesDir
	externalPath := filepath.Join(filepath.Dir(dir), "external-worktree")
	cmd := exec.Command("git", "-C", dir, "worktree", "add", "-b", "ext-branch", externalPath)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git worktree add failed: %s", out)
	}
	defer func() {
		exec.Command("git", "-C", dir, "worktree", "remove", "--force", externalPath).Run()
	}()

	r.invalidateCache()

	// External worktrees are not visible in List
	list := r.List()
	for _, info := range list {
		if info.Name == "external-worktree" {
			t.Error("external worktree should not be visible")
		}
	}

	// Delete returns not found since external worktrees are ignored
	err := r.Delete("external-worktree")
	if err != ErrWorktreeNotFound {
		t.Errorf("Delete() error = %v, want ErrWorktreeNotFound", err)
	}
}

func TestDelete_NonGitRepo(t *testing.T) {
	dir := t.TempDir()
	r := NewRegistry(dir, "")

	err := r.Delete("feature")
	if err != ErrNotGitRepo {
		t.Errorf("Delete() error = %v, want ErrNotGitRepo", err)
	}
}

func TestWorktreesDir(t *testing.T) {
	r := NewRegistry(absPath(t, "path", "to", "myproject"), "")

	got := r.worktreesDir()
	want := absPath(t, "path", "to", "myproject-worktrees")

	if got != want {
		t.Errorf("worktreesDir() = %q, want %q", got, want)
	}
}

func TestWorktreesDir_ConfiguredBase(t *testing.T) {
	r := NewRegistry(absPath(t, "path", "to", "myproject"), "")

	base := absPath(t, "custom", "worktrees")
	r.SetBaseDirProvider(func() string { return base })
	if got := r.worktreesDir(); got != base {
		t.Errorf("worktreesDir() with configured base = %q, want %q", got, base)
	}

	// Cleaned before use.
	r.SetBaseDirProvider(func() string { return base + string(filepath.Separator) })
	if got := r.worktreesDir(); got != base {
		t.Errorf("worktreesDir() should clean base, = %q, want %q", got, base)
	}

	// Empty provider value falls back to the default.
	r.SetBaseDirProvider(func() string { return "" })
	if got, want := r.worktreesDir(), absPath(t, "path", "to", "myproject-worktrees"); got != want {
		t.Errorf("worktreesDir() with empty base = %q, want default %q", got, want)
	}
}

func TestWorktreesDir_RelativeBase(t *testing.T) {
	r := NewRegistry(absPath(t, "path", "to", "myproject"), "")

	tests := []struct {
		name string
		base string
		want string
	}{
		{"dot prefix resolves against repo root", "./worktrees", absPath(t, "path", "to", "myproject", "worktrees")},
		{"parent prefix resolves against repo parent", "../worktrees", absPath(t, "path", "to", "worktrees")},
		{"deep parent prefix", "../../shared/wt", absPath(t, "path", "shared", "wt")},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r.SetBaseDirProvider(func() string { return tt.base })
			if got := r.worktreesDir(); got != tt.want {
				t.Errorf("worktreesDir(%q) = %q, want %q", tt.base, got, tt.want)
			}
		})
	}
}

// git prints worktree paths with forward slashes on every platform, so the
// parser has to translate them before comparing against native paths. Getting
// this wrong on Windows drops every worktree — including the main one — as
// "external", leaving the user with an empty list and no error.
func TestParseWorktreeList_NormalizesGitPaths(t *testing.T) {
	r := NewRegistry(t.TempDir(), "")
	mainDir := r.MainDir()
	r.SetBaseDirProvider(func() string { return "./wt" })

	worktreesDir := r.worktreesDir()
	featurePath := filepath.Join(worktreesDir, "feature")
	externalPath := filepath.Join(filepath.Dir(mainDir), "elsewhere")

	// Exactly the shape git emits: forward slashes, blank line between entries.
	output := "worktree " + filepath.ToSlash(mainDir) + "\nHEAD abc\nbranch refs/heads/main\n\n" +
		"worktree " + filepath.ToSlash(featurePath) + "\nHEAD def\nbranch refs/heads/feature-branch\n\n" +
		"worktree " + filepath.ToSlash(externalPath) + "\nHEAD ghi\nbranch refs/heads/other\n"

	got := r.parseWorktreeList(output)

	main, ok := got[""]
	if !ok {
		t.Fatalf("main worktree missing from %+v", got)
	}
	if main.Path != mainDir || !main.IsMain || main.Branch != "main" {
		t.Errorf("main worktree = %+v, want path %q, IsMain, branch main", main, mainDir)
	}

	feature, ok := got["feature"]
	if !ok {
		t.Fatalf("managed worktree missing from %+v", got)
	}
	if feature.Path != featurePath || feature.IsMain || feature.Branch != "feature-branch" {
		t.Errorf("feature worktree = %+v, want path %q, not main, branch feature-branch", feature, featurePath)
	}

	if len(got) != 2 {
		t.Errorf("worktrees outside the base directory should be skipped, got %+v", got)
	}
}

// Nothing keeps git's spelling of a path and ours in the same case: git reports
// what was recorded when the worktree was added, while our paths come from
// --work via EvalSymlinks, which upper-cases the drive letter. Windows resolves
// both to the same file, so discovery has to as well — otherwise every
// worktree, the main one included, is written off as external and the list
// comes back empty with no error to explain it.
func TestParseWorktreeList_DriveLetterCaseMismatch(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("case-insensitive path matching only holds on Windows; unix paths that differ in case are different files")
	}

	r := NewRegistry(t.TempDir(), "")
	r.SetBaseDirProvider(func() string { return "./wt" })

	featurePath := filepath.Join(r.worktreesDir(), "feature")

	// Same paths git would report, but with the drive letter git happens to
	// have recorded rather than the one EvalSymlinks handed us.
	output := "worktree " + swapDriveLetterCase(filepath.ToSlash(r.MainDir())) + "\nHEAD abc\nbranch refs/heads/main\n\n" +
		"worktree " + swapDriveLetterCase(filepath.ToSlash(featurePath)) + "\nHEAD def\nbranch refs/heads/feature-branch\n"

	got := r.parseWorktreeList(output)

	if _, ok := got[""]; !ok {
		t.Errorf("main worktree lost to a drive letter case difference, got %+v", got)
	}
	if _, ok := got["feature"]; !ok {
		t.Errorf("managed worktree lost to a drive letter case difference, got %+v", got)
	}
}

func swapDriveLetterCase(path string) string {
	if len(path) < 2 || path[1] != ':' {
		return path
	}
	return strings.ToLower(path[:1]) + path[1:]
}

// A base directory is hand-written and often shared between machines, so `/`
// must work as a separator everywhere. Both spellings have to resolve to the
// same directory, otherwise a Windows user's worktrees land somewhere the
// registry will not discover them. Where each base resolves to is covered by
// TestWorktreesDir_RelativeBase and TestWorktreesDir_HomeBase.
func TestWorktreesDir_SeparatorSpellingsAgree(t *testing.T) {
	r := NewRegistry(t.TempDir(), "")

	bases := []string{"./worktrees", "../worktrees", "../../shared/wt", "~/worktrees"}

	for _, base := range bases {
		t.Run(base, func(t *testing.T) {
			r.SetBaseDirProvider(func() string { return base })
			slashed := r.worktreesDir()

			native := filepath.FromSlash(base)
			r.SetBaseDirProvider(func() string { return native })
			if got := r.worktreesDir(); got != slashed {
				t.Errorf("worktreesDir(%q) = %q, but worktreesDir(%q) = %q", native, got, base, slashed)
			}
		})
	}
}

func TestWorktreesDir_HomeBase(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skipf("no home directory: %v", err)
	}

	r := NewRegistry(absPath(t, "path", "to", "myproject"), "")
	r.SetBaseDirProvider(func() string { return "~/pockode-worktrees" })

	// worktreesDir resolves symlinks in the longest existing prefix (the home
	// directory exists) before appending the not-yet-created remainder.
	want := filepath.Join(resolveSymlinks(t, home), "pockode-worktrees")
	if got := r.worktreesDir(); got != want {
		t.Errorf("worktreesDir(~/pockode-worktrees) = %q, want %q", got, want)
	}
}

func TestCreate_RelativeBaseDir(t *testing.T) {
	dir := initGitRepo(t)
	wantPath := filepath.Join(filepath.Dir(dir), "custom-wt", "feature")

	r := NewRegistry(dir, "")
	r.SetBaseDirProvider(func() string { return "../custom-wt" })

	info, _, err := r.Create("feature", "feature-branch", "")
	if err != nil {
		t.Fatalf("Create() failed: %v", err)
	}
	if info.Path != wantPath {
		t.Errorf("worktree created at %q, want %q", info.Path, wantPath)
	}
	if _, err := os.Stat(wantPath); err != nil {
		t.Errorf("worktree directory not found at relative base: %v", err)
	}

	resolved, err := r.Resolve("feature")
	if err != nil {
		t.Fatalf("Resolve() failed: %v", err)
	}
	if resolved != wantPath {
		t.Errorf("Resolve() = %q, want %q", resolved, wantPath)
	}
}

func TestCreate_ConfiguredBaseDir(t *testing.T) {
	dir := initGitRepo(t)
	// Intentionally use the raw (possibly symlinked, e.g. macOS /var) temp dir:
	// the registry must resolve it so `git worktree list` matches and the
	// worktree stays discoverable rather than being treated as external.
	base := t.TempDir()
	wantPath := filepath.Join(resolveSymlinks(t, base), "feature")

	r := NewRegistry(dir, "")
	r.SetBaseDirProvider(func() string { return base })

	info, _, err := r.Create("feature", "feature-branch", "")
	if err != nil {
		t.Fatalf("Create() failed: %v", err)
	}

	if info.Path != wantPath {
		t.Errorf("worktree created at %q, want %q", info.Path, wantPath)
	}
	if _, err := os.Stat(wantPath); err != nil {
		t.Errorf("worktree directory not found at configured base: %v", err)
	}

	// It must be discoverable through the configured base as well.
	resolved, err := r.Resolve("feature")
	if err != nil {
		t.Fatalf("Resolve() failed: %v", err)
	}
	if resolved != wantPath {
		t.Errorf("Resolve() = %q, want %q", resolved, wantPath)
	}
}

// initGitRepo creates a temporary git repository with an initial commit.
func initGitRepo(t *testing.T) string {
	t.Helper()

	dir := resolveSymlinks(t, t.TempDir())

	commands := [][]string{
		{"git", "init"},
		{"git", "config", "user.email", "test@test.com"},
		{"git", "config", "user.name", "Test"},
		{"git", "config", "commit.gpgsign", "false"},
		{"git", "config", "core.autocrlf", "false"},
		{"git", "commit", "--allow-empty", "-m", "initial"},
	}

	for _, args := range commands {
		cmd := exec.Command(args[0], args[1:]...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("%v failed: %s", args, out)
		}
	}

	return dir
}

// absPath builds an absolute path from plain segments. A literal "/path/to/x"
// is only absolute on unix — on Windows filepath.IsAbs reports false for it, so
// the registry would treat it as repo-relative and the expectations below would
// be testing a different code path than intended. Deriving the root from the
// working directory keeps the same table meaningful on both platforms.
func absPath(t *testing.T, segments ...string) string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatalf("Getwd() failed: %v", err)
	}
	root := filepath.VolumeName(wd) + string(filepath.Separator)
	path := filepath.Join(append([]string{root}, segments...)...)
	// The callers exist to exercise the absolute-path branch. If this ever came
	// back relative they would silently test the repo-relative branch instead
	// and still pass, because the expected values are built the same way.
	if !filepath.IsAbs(path) {
		t.Fatalf("absPath(%v) = %q, which is not absolute on this platform", segments, path)
	}
	return path
}

// resolveSymlinks resolves symlinks for consistent path comparison (e.g., /var -> /private/var on macOS).
func resolveSymlinks(t *testing.T, path string) string {
	t.Helper()
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		t.Fatalf("EvalSymlinks(%q) failed: %v", path, err)
	}
	return resolved
}
