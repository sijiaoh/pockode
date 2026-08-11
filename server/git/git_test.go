package git

import (
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

func TestExtractHost(t *testing.T) {
	tests := []struct {
		name    string
		repoURL string
		want    string
		wantErr bool
	}{
		{
			name:    "HTTPS GitHub URL",
			repoURL: "https://github.com/user/repo.git",
			want:    "github.com",
		},
		{
			name:    "HTTPS GitLab URL",
			repoURL: "https://gitlab.com/user/repo.git",
			want:    "gitlab.com",
		},
		{
			name:    "HTTPS URL without .git suffix",
			repoURL: "https://github.com/user/repo",
			want:    "github.com",
		},
		{
			name:    "SSH GitHub URL",
			repoURL: "git@github.com:user/repo.git",
			want:    "github.com",
		},
		{
			name:    "SSH GitLab URL",
			repoURL: "git@gitlab.com:user/repo.git",
			want:    "gitlab.com",
		},
		{
			name:    "HTTPS URL with port",
			repoURL: "https://git.example.com:8443/user/repo.git",
			want:    "git.example.com:8443",
		},
		{
			name:    "empty URL",
			repoURL: "",
			wantErr: true,
		},
		{
			name:    "invalid URL",
			repoURL: "not-a-url",
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := extractHost(tt.repoURL)
			if (err != nil) != tt.wantErr {
				t.Errorf("extractHost() error = %v, wantErr %v", err, tt.wantErr)
				return
			}
			if got != tt.want {
				t.Errorf("extractHost() = %v, want %v", got, tt.want)
			}
		})
	}
}

func setupTestRepoWithSubmodule(t *testing.T) (string, func()) {
	return setupTestRepoWithSubmoduleOpts(t, true)
}

func setupTestRepoWithSubmoduleOpts(t *testing.T, initSubmodule bool) (string, func()) {
	t.Helper()

	tempDir, err := os.MkdirTemp("", "git-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}

	cleanup := func() {
		os.RemoveAll(tempDir)
	}

	parentRepo := tempDir

	// Initialize parent repo
	cmds := [][]string{
		{"git", "init"},
		{"git", "config", "user.email", "test@test.com"},
		{"git", "config", "user.name", "Test"},
		// Pinned: Git for Windows defaults autocrlf on, which would rewrite
		// line endings underneath the content assertions.
		{"git", "config", "core.autocrlf", "false"},
	}
	for _, args := range cmds {
		cmd := exec.Command(args[0], args[1:]...)
		cmd.Dir = parentRepo
		if out, err := cmd.CombinedOutput(); err != nil {
			cleanup()
			t.Fatalf("failed to run %v: %v\n%s", args, err, out)
		}
	}

	// Create a file in parent and commit
	parentFile := filepath.Join(parentRepo, "parent.txt")
	if err := os.WriteFile(parentFile, []byte("parent content\n"), 0644); err != nil {
		cleanup()
		t.Fatalf("failed to write parent.txt: %v", err)
	}

	cmds = [][]string{
		{"git", "add", "parent.txt"},
		{"git", "commit", "--no-gpg-sign", "-m", "initial"},
	}
	for _, args := range cmds {
		cmd := exec.Command(args[0], args[1:]...)
		cmd.Dir = parentRepo
		if out, err := cmd.CombinedOutput(); err != nil {
			cleanup()
			t.Fatalf("failed to run %v: %v\n%s", args, err, out)
		}
	}

	// Create .gitmodules file manually
	gitmodules := `[submodule "mysub"]
	path = mysub
	url = https://example.com/mysub.git
`
	if err := os.WriteFile(filepath.Join(parentRepo, ".gitmodules"), []byte(gitmodules), 0644); err != nil {
		cleanup()
		t.Fatalf("failed to write .gitmodules: %v", err)
	}

	// Create submodule directory
	subDir := filepath.Join(parentRepo, "mysub")
	if err := os.MkdirAll(subDir, 0755); err != nil {
		cleanup()
		t.Fatalf("failed to create mysub dir: %v", err)
	}

	if initSubmodule {
		// Initialize submodule as a git repo
		cmds = [][]string{
			{"git", "init"},
			{"git", "config", "user.email", "test@test.com"},
			{"git", "config", "user.name", "Test"},
			// Pinned: Git for Windows defaults autocrlf on, which would rewrite
			// line endings underneath the content assertions.
			{"git", "config", "core.autocrlf", "false"},
		}
		for _, args := range cmds {
			cmd := exec.Command(args[0], args[1:]...)
			cmd.Dir = subDir
			if out, err := cmd.CombinedOutput(); err != nil {
				cleanup()
				t.Fatalf("failed to run %v in submodule: %v\n%s", args, err, out)
			}
		}

		// Create and commit a file in submodule
		subFile := filepath.Join(subDir, "sub.txt")
		if err := os.WriteFile(subFile, []byte("sub content\n"), 0644); err != nil {
			cleanup()
			t.Fatalf("failed to write sub.txt: %v", err)
		}

		cmds = [][]string{
			{"git", "add", "sub.txt"},
			{"git", "commit", "--no-gpg-sign", "-m", "initial"},
		}
		for _, args := range cmds {
			cmd := exec.Command(args[0], args[1:]...)
			cmd.Dir = subDir
			if out, err := cmd.CombinedOutput(); err != nil {
				cleanup()
				t.Fatalf("failed to run %v in submodule: %v\n%s", args, err, out)
			}
		}

		// Commit .gitmodules and submodule in parent
		cmds = [][]string{
			{"git", "add", ".gitmodules"},
			{"git", "add", "mysub"},
			{"git", "commit", "--no-gpg-sign", "-m", "add submodule"},
		}
	} else {
		// Only commit .gitmodules
		cmds = [][]string{
			{"git", "add", ".gitmodules"},
			{"git", "commit", "--no-gpg-sign", "-m", "add gitmodules"},
		}
	}

	for _, args := range cmds {
		cmd := exec.Command(args[0], args[1:]...)
		cmd.Dir = parentRepo
		if out, err := cmd.CombinedOutput(); err != nil {
			cleanup()
			t.Fatalf("failed to run %v: %v\n%s", args, err, out)
		}
	}

	return parentRepo, cleanup
}

func TestStatus_WithSubmodule(t *testing.T) {
	parentRepo, cleanup := setupTestRepoWithSubmodule(t)
	defer cleanup()

	// Modify a file in the submodule
	subFile := filepath.Join(parentRepo, "mysub", "sub.txt")
	if err := os.WriteFile(subFile, []byte("modified content\n"), 0644); err != nil {
		t.Fatalf("failed to modify sub.txt: %v", err)
	}

	status, err := Status(parentRepo)
	if err != nil {
		t.Fatalf("Status() error: %v", err)
	}

	// Submodule changes should be in Submodules["mysub"].Unstaged
	subStatus, ok := status.Submodules["mysub"]
	if !ok {
		t.Fatalf("expected submodule 'mysub' in status.Submodules, got %v", status.Submodules)
	}

	found := false
	for _, f := range subStatus.Unstaged {
		if f.Path == "sub.txt" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("expected 'sub.txt' in submodule unstaged, got %v", subStatus.Unstaged)
	}

	// Also verify HasFile works with full path
	if !status.HasFile("mysub/sub.txt", false) {
		t.Error("HasFile('mysub/sub.txt', false) should return true")
	}
}

func TestStatus_UninitializedSubmodule(t *testing.T) {
	parentRepo, cleanup := setupTestRepoWithSubmoduleOpts(t, false)
	defer cleanup()

	status, err := Status(parentRepo)
	if err != nil {
		t.Fatalf("Status() error: %v", err)
	}

	subStatus, ok := status.Submodules["mysub"]
	if !ok {
		t.Fatalf("expected submodule 'mysub' in status.Submodules")
	}
	if len(subStatus.Staged) != 0 {
		t.Errorf("expected empty staged, got %v", subStatus.Staged)
	}
	if len(subStatus.Unstaged) != 0 {
		t.Errorf("expected empty unstaged, got %v", subStatus.Unstaged)
	}
}

func setupTestRepo(t *testing.T) (string, func()) {
	t.Helper()
	tempDir, err := os.MkdirTemp("", "git-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	cleanup := func() { os.RemoveAll(tempDir) }

	cmds := [][]string{
		{"git", "init"},
		{"git", "config", "user.email", "test@test.com"},
		{"git", "config", "user.name", "Test"},
		// Pinned: Git for Windows defaults autocrlf on, which would rewrite
		// line endings underneath the content assertions.
		{"git", "config", "core.autocrlf", "false"},
	}
	for _, args := range cmds {
		cmd := exec.Command(args[0], args[1:]...)
		cmd.Dir = tempDir
		if out, err := cmd.CombinedOutput(); err != nil {
			cleanup()
			t.Fatalf("failed to run %v: %v\n%s", args, err, out)
		}
	}
	return tempDir, cleanup
}

func TestDiff_FileNotInStatus(t *testing.T) {
	dir, cleanup := setupTestRepo(t)
	defer cleanup()

	// Create and commit a file
	testFile := filepath.Join(dir, "test.txt")
	if err := os.WriteFile(testFile, []byte("original"), 0644); err != nil {
		t.Fatalf("failed to write file: %v", err)
	}
	runGit(t, dir, "add", "test.txt")
	runGit(t, dir, "commit", "--no-gpg-sign", "-m", "initial")

	// Modify and stage (no unstaged changes)
	if err := os.WriteFile(testFile, []byte("modified"), 0644); err != nil {
		t.Fatalf("failed to write file: %v", err)
	}
	runGit(t, dir, "add", "test.txt")

	// Request unstaged diff - file is staged only, not in unstaged status
	diff, err := Diff(dir, "test.txt", DiffOptions{Staged: false})
	if err != nil {
		t.Fatalf("Diff() error: %v", err)
	}
	if diff != "" {
		t.Errorf("expected empty diff for file not in unstaged status, got: %q", diff)
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

func TestDiff_WithSubmodule(t *testing.T) {
	parentRepo, cleanup := setupTestRepoWithSubmodule(t)
	defer cleanup()

	// Modify a file in the submodule
	subFile := filepath.Join(parentRepo, "mysub", "sub.txt")
	if err := os.WriteFile(subFile, []byte("modified content\n"), 0644); err != nil {
		t.Fatalf("failed to modify sub.txt: %v", err)
	}

	diff, err := Diff(parentRepo, "mysub/sub.txt", DiffOptions{Staged: false})
	if err != nil {
		t.Fatalf("Diff() error: %v", err)
	}

	if diff == "" {
		t.Error("expected non-empty diff")
	}

	if !strings.Contains(diff, "-sub content") || !strings.Contains(diff, "+modified content") {
		t.Errorf("diff doesn't contain expected changes:\n%s", diff)
	}
}

func TestDiffWithContent_WithSubmodule(t *testing.T) {
	parentRepo, cleanup := setupTestRepoWithSubmodule(t)
	defer cleanup()

	// Modify a file in the submodule
	subFile := filepath.Join(parentRepo, "mysub", "sub.txt")
	if err := os.WriteFile(subFile, []byte("modified content\n"), 0644); err != nil {
		t.Fatalf("failed to modify sub.txt: %v", err)
	}

	result, err := DiffWithContent(parentRepo, "mysub/sub.txt", DiffOptions{Staged: false})
	if err != nil {
		t.Fatalf("DiffWithContent() error: %v", err)
	}

	if result.Diff == "" {
		t.Error("expected non-empty diff")
	}
	if result.OldContent != "sub content\n" {
		t.Errorf("OldContent = %q, want %q", result.OldContent, "sub content\n")
	}
	if result.NewContent != "modified content\n" {
		t.Errorf("NewContent = %q, want %q", result.NewContent, "modified content\n")
	}
}

func TestDiff_HideWhitespace(t *testing.T) {
	dir, cleanup := setupTestRepo(t)
	defer cleanup()

	// Create and commit a file (must be tracked for git diff -w to work)
	testFile := filepath.Join(dir, "test.txt")
	if err := os.WriteFile(testFile, []byte("hello world\n"), 0644); err != nil {
		t.Fatalf("failed to write file: %v", err)
	}
	runGit(t, dir, "add", "test.txt")
	runGit(t, dir, "commit", "--no-gpg-sign", "-m", "initial")

	// Modify with only whitespace changes (add trailing spaces)
	if err := os.WriteFile(testFile, []byte("hello world  \n"), 0644); err != nil {
		t.Fatalf("failed to write file: %v", err)
	}

	// Without HideWhitespace, diff should show changes
	diffWithWS, err := Diff(dir, "test.txt", DiffOptions{Staged: false, HideWhitespace: false})
	if err != nil {
		t.Fatalf("Diff() error: %v", err)
	}
	if diffWithWS == "" {
		t.Error("expected non-empty diff when HideWhitespace=false")
	}
	if !strings.Contains(diffWithWS, "-hello world") || !strings.Contains(diffWithWS, "+hello world  ") {
		t.Errorf("diff should show whitespace change, got: %q", diffWithWS)
	}

	// With HideWhitespace, diff should be empty (only whitespace changed)
	diffNoWS, err := Diff(dir, "test.txt", DiffOptions{Staged: false, HideWhitespace: true})
	if err != nil {
		t.Fatalf("Diff() error: %v", err)
	}
	if diffNoWS != "" {
		t.Errorf("expected empty diff when HideWhitespace=true, got: %q", diffNoWS)
	}

	// Now add a real content change along with whitespace
	if err := os.WriteFile(testFile, []byte("hello world  \nnew line\n"), 0644); err != nil {
		t.Fatalf("failed to write file: %v", err)
	}

	// With HideWhitespace, should still show content changes
	diffMixed, err := Diff(dir, "test.txt", DiffOptions{Staged: false, HideWhitespace: true})
	if err != nil {
		t.Fatalf("Diff() error: %v", err)
	}
	if diffMixed == "" {
		t.Error("expected non-empty diff for content changes even with HideWhitespace=true")
	}
	if !strings.Contains(diffMixed, "+new line") {
		t.Errorf("diff should contain content change, got: %q", diffMixed)
	}
}

func TestValidatePath(t *testing.T) {
	tests := []struct {
		name    string
		path    string
		wantErr bool
	}{
		{name: "valid relative path", path: "file.txt", wantErr: false},
		{name: "valid nested path", path: "dir/file.txt", wantErr: false},
		{name: "valid deep path", path: "a/b/c/file.txt", wantErr: false},
		{name: "valid dotfile", path: ".gitignore", wantErr: false},
		{name: "valid ..foo", path: "..foo", wantErr: false},
		{name: "empty path", path: "", wantErr: true},
		{name: "absolute path unix", path: "/etc/passwd", wantErr: true},
		{name: "parent traversal", path: "..", wantErr: true},
		{name: "parent traversal with path", path: "../secret", wantErr: true},
		{name: "nested parent traversal", path: "foo/../../secret", wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validatePath(tt.path)
			if (err != nil) != tt.wantErr {
				t.Errorf("validatePath(%q) error = %v, wantErr %v", tt.path, err, tt.wantErr)
			}
		})
	}
}

// On other platforms these are ordinary (if odd) file names, so they can only be
// asserted where the OS actually resolves them outside the repository.
func TestValidatePath_WindowsAnchoredForms(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("anchored path forms are Windows-specific")
	}

	paths := []string{
		`C:\Windows\system32\config\SAM`, // absolute
		`C:secret`,                       // drive-relative
		`\Windows\system32`,              // root-relative
		`..\secret`,                      // traversal with native separator
	}

	for _, path := range paths {
		t.Run(path, func(t *testing.T) {
			if err := validatePath(path); err == nil {
				t.Errorf("validatePath(%q) = nil, want error", path)
			}
		})
	}
}

func TestCredentialHelperConfig(t *testing.T) {
	tests := []struct {
		name     string
		credFile string
		want     string
	}{
		{"plain path", "/home/me/repo/.git/.git-credentials", "store --file='/home/me/repo/.git/.git-credentials'"},
		{"path with spaces", "/home/my name/repo/.git/.git-credentials", "store --file='/home/my name/repo/.git/.git-credentials'"},
		{"path with single quote", "/home/o'brien/.git-credentials", `store --file='/home/o'\''brien/.git-credentials'`},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := credentialHelperConfig(tt.credFile); got != tt.want {
				t.Errorf("credentialHelperConfig(%q) = %q, want %q", tt.credFile, got, tt.want)
			}
		})
	}
}

// Git hands the helper string to a shell, which treats a backslash as an escape
// character rather than a path separator. A native Windows path must therefore
// come out with forward slashes.
func TestCredentialHelperConfig_NoBackslashesInNativePath(t *testing.T) {
	credFile := filepath.Join(t.TempDir(), ".git", ".git-credentials")

	got := credentialHelperConfig(credFile)
	if strings.Contains(got, `\`) {
		t.Errorf("credentialHelperConfig(%q) = %q, must not contain backslashes", credFile, got)
	}
	if !strings.Contains(got, filepath.ToSlash(credFile)) {
		t.Errorf("credentialHelperConfig(%q) = %q, should carry the credentials path", credFile, got)
	}
}

// The contract that matters is what the shell hands to the helper process, so
// assert it against a real shell rather than against the quoting rules.
func TestShellQuote_SurvivesShellParsing(t *testing.T) {
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Skipf("no POSIX shell available: %v", err)
	}

	paths := []string{
		"/home/me/.git-credentials",
		"C:/Users/My Name/repo/.git/.git-credentials",
		"/home/o'brien/.git-credentials",
		"/home/me/$HOME `whoami`/.git-credentials",
		`/home/me/back\slash/.git-credentials`,
	}

	for _, path := range paths {
		t.Run(path, func(t *testing.T) {
			// Mirrors how git invokes a helper: the whole configured string is
			// parsed by the shell, so the quoted path must survive as one word.
			out, err := exec.Command(sh, "-c", "printf %s "+shellQuote(path)).Output()
			if err != nil {
				t.Fatalf("shell rejected quoted path: %v", err)
			}
			if string(out) != path {
				t.Errorf("shell parsed %q as %q, want %q", shellQuote(path), out, path)
			}
		})
	}
}

func TestShowFileDiff(t *testing.T) {
	dir, cleanup := setupTestRepo(t)
	defer cleanup()

	// Create and commit initial file
	testFile := filepath.Join(dir, "test.txt")
	if err := os.WriteFile(testFile, []byte("line1\n"), 0644); err != nil {
		t.Fatalf("failed to write file: %v", err)
	}
	runGit(t, dir, "add", "test.txt")
	runGit(t, dir, "commit", "--no-gpg-sign", "-m", "initial")

	// Modify and commit
	if err := os.WriteFile(testFile, []byte("line1\nline2\n"), 0644); err != nil {
		t.Fatalf("failed to write file: %v", err)
	}
	runGit(t, dir, "add", "test.txt")
	runGit(t, dir, "commit", "--no-gpg-sign", "-m", "add line2")

	// Get latest commit hash
	cmd := exec.Command("git", "rev-parse", "HEAD")
	cmd.Dir = dir
	hashBytes, err := cmd.Output()
	if err != nil {
		t.Fatalf("failed to get commit hash: %v", err)
	}
	hash := strings.TrimSpace(string(hashBytes))

	result, err := ShowFileDiff(dir, hash, "test.txt", false)
	if err != nil {
		t.Fatalf("ShowFileDiff() error: %v", err)
	}

	if result.Diff == "" {
		t.Error("expected non-empty diff")
	}
	if !strings.Contains(result.Diff, "+line2") {
		t.Errorf("diff should contain '+line2', got: %s", result.Diff)
	}
	if result.OldContent != "line1\n" {
		t.Errorf("OldContent = %q, want %q", result.OldContent, "line1\n")
	}
	if result.NewContent != "line1\nline2\n" {
		t.Errorf("NewContent = %q, want %q", result.NewContent, "line1\nline2\n")
	}
}

func TestShowFileDiff_DeletedFile(t *testing.T) {
	dir, cleanup := setupTestRepo(t)
	defer cleanup()

	// Create and commit a file
	testFile := filepath.Join(dir, "to-delete.txt")
	if err := os.WriteFile(testFile, []byte("delete me\n"), 0644); err != nil {
		t.Fatalf("failed to write file: %v", err)
	}
	runGit(t, dir, "add", "to-delete.txt")
	runGit(t, dir, "commit", "--no-gpg-sign", "-m", "add file")

	// Delete and commit
	if err := os.Remove(testFile); err != nil {
		t.Fatalf("failed to delete file: %v", err)
	}
	runGit(t, dir, "add", "to-delete.txt")
	runGit(t, dir, "commit", "--no-gpg-sign", "-m", "delete file")

	// Get latest commit hash
	cmd := exec.Command("git", "rev-parse", "HEAD")
	cmd.Dir = dir
	hashBytes, err := cmd.Output()
	if err != nil {
		t.Fatalf("failed to get commit hash: %v", err)
	}
	hash := strings.TrimSpace(string(hashBytes))

	result, err := ShowFileDiff(dir, hash, "to-delete.txt", false)
	if err != nil {
		t.Fatalf("ShowFileDiff() error: %v", err)
	}

	if result.Diff == "" {
		t.Error("expected non-empty diff")
	}
	if result.OldContent != "delete me\n" {
		t.Errorf("OldContent = %q, want %q", result.OldContent, "delete me\n")
	}
	if result.NewContent != "" {
		t.Errorf("NewContent = %q, want empty", result.NewContent)
	}
}

func TestShowFileDiff_NewFile(t *testing.T) {
	dir, cleanup := setupTestRepo(t)
	defer cleanup()

	// Create initial commit
	dummyFile := filepath.Join(dir, "dummy.txt")
	if err := os.WriteFile(dummyFile, []byte("dummy\n"), 0644); err != nil {
		t.Fatalf("failed to write file: %v", err)
	}
	runGit(t, dir, "add", "dummy.txt")
	runGit(t, dir, "commit", "--no-gpg-sign", "-m", "initial")

	// Create and commit a new file
	testFile := filepath.Join(dir, "new.txt")
	if err := os.WriteFile(testFile, []byte("new content\n"), 0644); err != nil {
		t.Fatalf("failed to write file: %v", err)
	}
	runGit(t, dir, "add", "new.txt")
	runGit(t, dir, "commit", "--no-gpg-sign", "-m", "add new file")

	// Get latest commit hash
	cmd := exec.Command("git", "rev-parse", "HEAD")
	cmd.Dir = dir
	hashBytes, err := cmd.Output()
	if err != nil {
		t.Fatalf("failed to get commit hash: %v", err)
	}
	hash := strings.TrimSpace(string(hashBytes))

	result, err := ShowFileDiff(dir, hash, "new.txt", false)
	if err != nil {
		t.Fatalf("ShowFileDiff() error: %v", err)
	}

	if result.Diff == "" {
		t.Error("expected non-empty diff")
	}
	// Old content should be empty for new file
	if result.OldContent != "" {
		t.Errorf("OldContent = %q, want empty", result.OldContent)
	}
	if result.NewContent != "new content\n" {
		t.Errorf("NewContent = %q, want %q", result.NewContent, "new content\n")
	}
}

func TestShowFileDiff_HideWhitespace(t *testing.T) {
	dir, cleanup := setupTestRepo(t)
	defer cleanup()

	// Create initial commit with a file
	testFile := filepath.Join(dir, "test.txt")
	if err := os.WriteFile(testFile, []byte("hello world\n"), 0644); err != nil {
		t.Fatalf("failed to write file: %v", err)
	}
	runGit(t, dir, "add", "test.txt")
	runGit(t, dir, "commit", "--no-gpg-sign", "-m", "initial")

	// Create second commit with only whitespace changes
	if err := os.WriteFile(testFile, []byte("hello world  \n"), 0644); err != nil {
		t.Fatalf("failed to write file: %v", err)
	}
	runGit(t, dir, "add", "test.txt")
	runGit(t, dir, "commit", "--no-gpg-sign", "-m", "whitespace only")

	// Get the commit hash
	cmd := exec.Command("git", "rev-parse", "HEAD")
	cmd.Dir = dir
	hashBytes, err := cmd.Output()
	if err != nil {
		t.Fatalf("failed to get commit hash: %v", err)
	}
	hash := strings.TrimSpace(string(hashBytes))

	// Without hideWhitespace, should show the diff
	resultWithWS, err := ShowFileDiff(dir, hash, "test.txt", false)
	if err != nil {
		t.Fatalf("ShowFileDiff() error: %v", err)
	}
	if resultWithWS.Diff == "" {
		t.Error("expected non-empty diff when hideWhitespace=false")
	}

	// With hideWhitespace, diff should be empty (only whitespace changed)
	resultNoWS, err := ShowFileDiff(dir, hash, "test.txt", true)
	if err != nil {
		t.Fatalf("ShowFileDiff() error: %v", err)
	}
	if resultNoWS.Diff != "" {
		t.Errorf("expected empty diff when hideWhitespace=true, got: %q", resultNoWS.Diff)
	}

	// Create third commit with real content change
	if err := os.WriteFile(testFile, []byte("hello world  \nnew line\n"), 0644); err != nil {
		t.Fatalf("failed to write file: %v", err)
	}
	runGit(t, dir, "add", "test.txt")
	runGit(t, dir, "commit", "--no-gpg-sign", "-m", "content change")

	// Get the new commit hash
	cmd = exec.Command("git", "rev-parse", "HEAD")
	cmd.Dir = dir
	hashBytes, err = cmd.Output()
	if err != nil {
		t.Fatalf("failed to get commit hash: %v", err)
	}
	hashContent := strings.TrimSpace(string(hashBytes))

	// With hideWhitespace, should still show content changes
	resultMixed, err := ShowFileDiff(dir, hashContent, "test.txt", true)
	if err != nil {
		t.Fatalf("ShowFileDiff() error: %v", err)
	}
	if resultMixed.Diff == "" {
		t.Error("expected non-empty diff for content changes even with hideWhitespace=true")
	}
	if !strings.Contains(resultMixed.Diff, "+new line") {
		t.Errorf("diff should contain content change, got: %q", resultMixed.Diff)
	}
}

// TestShow_FileDiffRoundTrip pins the contract that ties the two commit-history
// paths together: every file Show lists must yield a non-empty ShowFileDiff.
// Merge commits used to break it, so all commit shapes are checked together.
func TestShow_FileDiffRoundTrip(t *testing.T) {
	dir, cleanup := setupTestRepo(t)
	defer cleanup()

	commitAll := func(msg string) string {
		t.Helper()
		runGit(t, dir, "add", "-A")
		runGit(t, dir, "commit", "--no-gpg-sign", "-m", msg)
		return gitHead(t, dir)
	}

	type commitCase struct {
		name      string
		hash      string
		wantFiles map[string]string
	}
	var cases []commitCase

	writeTestFile(t, dir, "a.txt", "a\n")
	cases = append(cases, commitCase{"initial", commitAll("initial"), map[string]string{"a.txt": "A"}})

	writeTestFile(t, dir, "a.txt", "a\nb\n")
	cases = append(cases, commitCase{"ordinary", commitAll("ordinary"), map[string]string{"a.txt": "M"}})

	runGit(t, dir, "commit", "--no-gpg-sign", "--allow-empty", "-m", "empty")
	cases = append(cases, commitCase{"empty", gitHead(t, dir), map[string]string{}})

	// Windows has no executable bit for git to record, so os.Chmod produces no
	// change to commit and the case cannot be constructed there at all.
	if runtime.GOOS != "windows" {
		// Pinned on: with a globally disabled core.fileMode git sees no change here
		// and the commit below would fail instead of exercising a mode change.
		runGit(t, dir, "config", "core.fileMode", "true")
		if err := os.Chmod(filepath.Join(dir, "a.txt"), 0755); err != nil {
			t.Fatalf("failed to chmod a.txt: %v", err)
		}
		cases = append(cases, commitCase{"mode change", commitAll("mode change"), map[string]string{"a.txt": "M"}})
	}

	runGit(t, dir, "mv", "a.txt", "renamed.txt")
	cases = append(cases, commitCase{"rename", commitAll("rename"), map[string]string{"renamed.txt": "R"}})

	// The branch file is identical in the merge and in the second parent, so a
	// combined diff would render it empty.
	base := gitOutput(t, dir, "rev-parse", "--abbrev-ref", "HEAD")
	runGit(t, dir, "checkout", "-b", "feature")
	writeTestFile(t, dir, "feature.txt", "feature\n")
	commitAll("add feature file")
	runGit(t, dir, "checkout", base)
	writeTestFile(t, dir, "base.txt", "base\n")
	commitAll("add base file")
	runGit(t, dir, "merge", "--no-ff", "--no-gpg-sign", "-m", "merge feature", "feature")
	cases = append(cases, commitCase{"merge", gitHead(t, dir), map[string]string{"feature.txt": "A"}})

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			result, err := Show(dir, tc.hash)
			if err != nil {
				t.Fatalf("Show() error: %v", err)
			}

			got := make(map[string]string, len(result.Files))
			for _, f := range result.Files {
				got[f.Path] = f.Status

				diff, err := ShowFileDiff(dir, tc.hash, f.Path, false)
				if err != nil {
					t.Fatalf("ShowFileDiff(%q) error: %v", f.Path, err)
				}
				if diff.Diff == "" {
					t.Errorf("ShowFileDiff(%q) is empty although Show listed the file", f.Path)
				}
			}
			if !reflect.DeepEqual(got, tc.wantFiles) {
				t.Errorf("files = %v, want %v", got, tc.wantFiles)
			}
		})
	}
}

// TestShowFileDiff_MergeCommit checks the merge diff is taken against the first
// parent, matching the file list and the OldContent/NewContent pair.
func TestShowFileDiff_MergeCommit(t *testing.T) {
	dir, cleanup := setupTestRepo(t)
	defer cleanup()

	writeTestFile(t, dir, "shared.txt", "base\n")
	runGit(t, dir, "add", "-A")
	runGit(t, dir, "commit", "--no-gpg-sign", "-m", "initial")

	base := gitOutput(t, dir, "rev-parse", "--abbrev-ref", "HEAD")
	runGit(t, dir, "checkout", "-b", "feature")
	writeTestFile(t, dir, "shared.txt", "base\nfeature\n")
	runGit(t, dir, "add", "-A")
	runGit(t, dir, "commit", "--no-gpg-sign", "-m", "extend on feature")

	runGit(t, dir, "checkout", base)
	writeTestFile(t, dir, "other.txt", "other\n")
	runGit(t, dir, "add", "-A")
	runGit(t, dir, "commit", "--no-gpg-sign", "-m", "unrelated change")
	runGit(t, dir, "merge", "--no-ff", "--no-gpg-sign", "-m", "merge feature", "feature")

	hash := gitHead(t, dir)
	result, err := ShowFileDiff(dir, hash, "shared.txt", false)
	if err != nil {
		t.Fatalf("ShowFileDiff() error: %v", err)
	}

	if !strings.Contains(result.Diff, "+feature") {
		t.Errorf("diff should contain '+feature', got: %q", result.Diff)
	}
	if result.OldContent != "base\n" {
		t.Errorf("OldContent = %q, want %q", result.OldContent, "base\n")
	}
	if result.NewContent != "base\nfeature\n" {
		t.Errorf("NewContent = %q, want %q", result.NewContent, "base\nfeature\n")
	}
}

func TestParseStatusZ(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected []statusEntry
	}{
		{
			name:  "modified and untracked",
			input: " M file.go\x00?? new.go\x00",
			expected: []statusEntry{
				{staged: ' ', unstaged: 'M', path: "file.go"},
				{staged: '?', unstaged: '?', path: "new.go"},
			},
		},
		{
			name:  "rename reports new path and skips source field",
			input: "RM new.go\x00old.go\x00 M other.go\x00",
			expected: []statusEntry{
				{staged: 'R', unstaged: 'M', path: "new.go"},
				{staged: ' ', unstaged: 'M', path: "other.go"},
			},
		},
		{
			name:  "non-ASCII path is kept verbatim",
			input: " M 中文文件.txt\x00?? 目录/子文件.md\x00",
			expected: []statusEntry{
				{staged: ' ', unstaged: 'M', path: "中文文件.txt"},
				{staged: '?', unstaged: '?', path: "目录/子文件.md"},
			},
		},
		{
			name:  "path containing spaces and arrow",
			input: " M a -> b.txt\x00",
			expected: []statusEntry{
				{staged: ' ', unstaged: 'M', path: "a -> b.txt"},
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := parseStatusZ(tt.input)
			if len(got) != len(tt.expected) {
				t.Fatalf("expected %d entries, got %d (%+v)", len(tt.expected), len(got), got)
			}
			for i, entry := range got {
				if entry != tt.expected[i] {
					t.Errorf("entry[%d] = %+v, want %+v", i, entry, tt.expected[i])
				}
			}
		})
	}
}

// nonASCIIPaths covers CJK plus names that git's line-based output would make
// ambiguous even without escaping. Names that only some platforms can represent
// live in platformNonASCIIPaths (paths_unix_test.go / paths_windows_test.go).
var nonASCIIPaths = append([]string{"中文文件.txt", "目录/子文件.md", "带 空格 的 文件.txt"}, platformNonASCIIPaths...)

// setupQuotedTestRepo is setupTestRepo with git's default path quoting pinned on,
// so these tests still exercise escaped output when the host disables it globally.
func setupQuotedTestRepo(t *testing.T) (string, func()) {
	t.Helper()
	dir, cleanup := setupTestRepo(t)
	runGit(t, dir, "config", "core.quotePath", "true")
	return dir, cleanup
}

func TestStatus_NonASCIIPaths(t *testing.T) {
	dir, cleanup := setupQuotedTestRepo(t)
	defer cleanup()

	for _, path := range nonASCIIPaths {
		writeTestFile(t, dir, path, "original\n")
	}
	runGit(t, dir, "add", "-A")
	runGit(t, dir, "commit", "--no-gpg-sign", "-m", "initial")

	for _, path := range nonASCIIPaths {
		writeTestFile(t, dir, path, "modified\n")
	}
	writeTestFile(t, dir, "未跟踪的文件.txt", "untracked\n")

	status, err := Status(dir)
	if err != nil {
		t.Fatalf("Status() error: %v", err)
	}

	for _, path := range nonASCIIPaths {
		if !status.HasFile(path, false) {
			t.Errorf("expected %q in unstaged status, got %+v", path, status.Unstaged)
		}
	}
	if !status.IsUntracked("未跟踪的文件.txt") {
		t.Errorf("expected 未跟踪的文件.txt to be untracked, got %+v", status.Unstaged)
	}
}

// TestAddReset_NonASCIIPath verifies the other half of the round trip: the path
// reported by Status must also work as-is as a pathspec for staging commands,
// which fail loudly (rather than silently) when it doesn't match.
func TestAddReset_NonASCIIPath(t *testing.T) {
	dir, cleanup := setupQuotedTestRepo(t)
	defer cleanup()

	for _, path := range nonASCIIPaths {
		writeTestFile(t, dir, path, "original\n")
	}
	runGit(t, dir, "add", "-A")
	runGit(t, dir, "commit", "--no-gpg-sign", "-m", "initial")
	for _, path := range nonASCIIPaths {
		writeTestFile(t, dir, path, "modified\n")
	}

	status, err := Status(dir)
	if err != nil {
		t.Fatalf("Status() error: %v", err)
	}
	for _, file := range status.Unstaged {
		if err := Add(dir, file.Path); err != nil {
			t.Fatalf("Add(%q) error: %v", file.Path, err)
		}
	}

	staged, err := Status(dir)
	if err != nil {
		t.Fatalf("Status() error: %v", err)
	}
	if len(staged.Unstaged) != 0 {
		t.Errorf("expected nothing left unstaged, got %+v", staged.Unstaged)
	}
	for _, path := range nonASCIIPaths {
		if !staged.HasFile(path, true) {
			t.Errorf("expected %q to be staged, got %+v", path, staged.Staged)
		}
	}

	for _, file := range staged.Staged {
		if err := Reset(dir, file.Path); err != nil {
			t.Fatalf("Reset(%q) error: %v", file.Path, err)
		}
	}

	unstaged, err := Status(dir)
	if err != nil {
		t.Fatalf("Status() error: %v", err)
	}
	if len(unstaged.Staged) != 0 {
		t.Errorf("expected nothing left staged, got %+v", unstaged.Staged)
	}
	for _, path := range nonASCIIPaths {
		if !unstaged.HasFile(path, false) {
			t.Errorf("expected %q back in unstaged after Reset, got %+v", path, unstaged.Unstaged)
		}
	}
}

// TestGetSubmodulePaths pins that a submodule path is read as a whole value:
// splitting the line on whitespace used to truncate paths containing spaces.
func TestGetSubmodulePaths(t *testing.T) {
	dir, cleanup := setupTestRepo(t)
	defer cleanup()

	writeTestFile(t, dir, ".gitmodules", `[submodule "plain"]
	path = vendor/plain
	url = ./plain
[submodule "spaced"]
	path = vendor/with spaces
	url = ./spaced
[submodule "cjk"]
	path = vendor/中文子模块
	url = ./cjk
`)

	got := getSubmodulePaths(dir)
	want := []string{"vendor/plain", "vendor/with spaces", "vendor/中文子模块"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("getSubmodulePaths() = %q, want %q", got, want)
	}
}

// TestDiffWithContent_NonASCIIPath verifies the full round trip: the path
// reported by Status must be usable as-is to fetch that file's diff.
func TestDiffWithContent_NonASCIIPath(t *testing.T) {
	dir, cleanup := setupQuotedTestRepo(t)
	defer cleanup()

	const path = "中文文件.txt"
	writeTestFile(t, dir, path, "original\n")
	runGit(t, dir, "add", "-A")
	runGit(t, dir, "commit", "--no-gpg-sign", "-m", "initial")
	writeTestFile(t, dir, path, "modified\n")

	status, err := Status(dir)
	if err != nil {
		t.Fatalf("Status() error: %v", err)
	}
	if len(status.Unstaged) != 1 {
		t.Fatalf("expected 1 unstaged file, got %+v", status.Unstaged)
	}

	result, err := DiffWithContent(dir, status.Unstaged[0].Path, DiffOptions{})
	if err != nil {
		t.Fatalf("DiffWithContent() error: %v", err)
	}
	if !strings.Contains(result.Diff, "-original") || !strings.Contains(result.Diff, "+modified") {
		t.Errorf("diff doesn't contain expected changes:\n%s", result.Diff)
	}
	if !strings.Contains(result.Diff, path) {
		t.Errorf("diff header should carry the unescaped path %q:\n%s", path, result.Diff)
	}
	if result.OldContent != "original\n" {
		t.Errorf("OldContent = %q, want %q", result.OldContent, "original\n")
	}
	if result.NewContent != "modified\n" {
		t.Errorf("NewContent = %q, want %q", result.NewContent, "modified\n")
	}
}

func TestShow_NonASCIIPaths(t *testing.T) {
	dir, cleanup := setupQuotedTestRepo(t)
	defer cleanup()

	writeTestFile(t, dir, "seed.txt", "seed\n")
	runGit(t, dir, "add", "-A")
	runGit(t, dir, "commit", "--no-gpg-sign", "-m", "seed")

	for _, path := range nonASCIIPaths {
		writeTestFile(t, dir, path, "content\n")
	}
	runGit(t, dir, "add", "-A")
	runGit(t, dir, "commit", "--no-gpg-sign", "-m", "add non-ASCII files")

	hash := gitHead(t, dir)
	result, err := Show(dir, hash)
	if err != nil {
		t.Fatalf("Show() error: %v", err)
	}

	got := make(map[string]string, len(result.Files))
	for _, f := range result.Files {
		got[f.Path] = f.Status
	}
	for _, path := range nonASCIIPaths {
		if got[path] != "A" {
			t.Errorf("expected %q with status A, got %+v", path, result.Files)
		}
	}

	// The reported path must be usable as-is to fetch the file's diff
	diff, err := ShowFileDiff(dir, hash, nonASCIIPaths[0], false)
	if err != nil {
		t.Fatalf("ShowFileDiff() error: %v", err)
	}
	if !strings.Contains(diff.Diff, "+content") {
		t.Errorf("diff doesn't contain expected content:\n%s", diff.Diff)
	}
	if diff.NewContent != "content\n" {
		t.Errorf("NewContent = %q, want %q", diff.NewContent, "content\n")
	}
}

func TestStatus_NonASCIIRename(t *testing.T) {
	dir, cleanup := setupQuotedTestRepo(t)
	defer cleanup()

	writeTestFile(t, dir, "旧名.txt", "content\n")
	runGit(t, dir, "add", "-A")
	runGit(t, dir, "commit", "--no-gpg-sign", "-m", "initial")
	runGit(t, dir, "mv", "旧名.txt", "新名.txt")

	status, err := Status(dir)
	if err != nil {
		t.Fatalf("Status() error: %v", err)
	}

	if len(status.Staged) != 1 {
		t.Fatalf("expected 1 staged entry, got %+v", status.Staged)
	}
	if status.Staged[0].Path != "新名.txt" || status.Staged[0].Status != "R" {
		t.Errorf("staged entry = %+v, want {Path: 新名.txt, Status: R}", status.Staged[0])
	}
}

func writeTestFile(t *testing.T, dir, path, content string) {
	t.Helper()
	fullPath := filepath.Join(dir, path)
	if err := os.MkdirAll(filepath.Dir(fullPath), 0755); err != nil {
		t.Fatalf("failed to create dir for %q: %v", path, err)
	}
	if err := os.WriteFile(fullPath, []byte(content), 0644); err != nil {
		t.Fatalf("failed to write %q: %v", path, err)
	}
}

func gitOutput(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("git %v failed: %v", args, err)
	}
	return strings.TrimSpace(string(out))
}

func gitHead(t *testing.T, dir string) string {
	t.Helper()
	return gitOutput(t, dir, "rev-parse", "HEAD")
}
