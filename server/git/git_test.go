package git

import (
	"os"
	"os/exec"
	"path/filepath"
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
	diff, err := Diff(dir, "test.txt", false)
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

	diff, err := Diff(parentRepo, "mysub/sub.txt", false)
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

	result, err := DiffWithContent(parentRepo, "mysub/sub.txt", false)
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

	result, err := ShowFileDiff(dir, hash, "test.txt")
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

	result, err := ShowFileDiff(dir, hash, "to-delete.txt")
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

	result, err := ShowFileDiff(dir, hash, "new.txt")
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
