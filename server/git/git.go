// Package git provides git repository operations including initialization, status, and diff.
package git

import (
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// Config holds configuration for git initialization.
type Config struct {
	RepoURL   string
	RepoToken string
	UserName  string
	UserEmail string
	WorkDir   string
}

// Init initializes a git repository with the provided configuration.
// It performs the following steps:
// 1. git init (if .git doesn't exist)
// 2. Configure local credential helper
// 3. Write .git/.git-credentials
// 4. git remote add origin
// 5. git fetch + checkout default branch
// 6. Configure user info (local)
func Init(cfg Config) error {
	gitDir := filepath.Join(cfg.WorkDir, ".git")

	if err := os.MkdirAll(cfg.WorkDir, 0755); err != nil {
		return fmt.Errorf("failed to create work directory: %w", err)
	}

	if _, err := os.Stat(gitDir); err == nil {
		slog.Info("repository already exists, skipping initialization", "workDir", cfg.WorkDir)
		return nil
	}

	host, err := extractHost(cfg.RepoURL)
	if err != nil {
		return fmt.Errorf("failed to extract host from URL: %w", err)
	}

	slog.Info("initializing git repository", "workDir", cfg.WorkDir)

	if err := initRepo(cfg.WorkDir); err != nil {
		return err
	}
	if err := setupLocalCredential(cfg.WorkDir, host, cfg.RepoToken); err != nil {
		return err
	}
	if err := addRemote(cfg.WorkDir, cfg.RepoURL); err != nil {
		return err
	}
	if err := fetchAndCheckout(cfg.WorkDir); err != nil {
		return err
	}
	if err := configUser(cfg.WorkDir, cfg.UserName, cfg.UserEmail); err != nil {
		return err
	}

	slog.Info("git repository initialized successfully")
	return nil
}

// initRepo executes git init in the specified directory.
func initRepo(dir string) error {
	cmd := exec.Command("git", "init")
	cmd.Dir = dir
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("git init failed: %w", err)
	}
	return nil
}

// setupLocalCredential configures a local credential helper and writes the credentials file.
func setupLocalCredential(dir, host, token string) error {
	gitDir := filepath.Join(dir, ".git")
	credFile := filepath.Join(gitDir, ".git-credentials")

	cmd := exec.Command("git", "config", "--local", "credential.helper", fmt.Sprintf("store --file=%s", credFile))
	cmd.Dir = dir
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("failed to configure credential helper: %w", err)
	}

	// x-access-token is GitHub's required username for PAT authentication
	credContent := fmt.Sprintf("https://x-access-token:%s@%s\n", token, host)
	if err := os.WriteFile(credFile, []byte(credContent), 0600); err != nil {
		return fmt.Errorf("failed to write credentials file: %w", err)
	}

	slog.Info("local credential configured", "host", host)
	return nil
}

// addRemote adds the origin remote to the repository.
func addRemote(dir, repoURL string) error {
	cmd := exec.Command("git", "remote", "add", "origin", repoURL)
	cmd.Dir = dir
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("git remote add failed: %w", err)
	}
	return nil
}

// fetchAndCheckout fetches from origin and checks out the default branch.
func fetchAndCheckout(dir string) error {
	fetchCmd := exec.Command("git", "fetch", "origin")
	fetchCmd.Dir = dir
	fetchCmd.Stdout = os.Stdout
	fetchCmd.Stderr = os.Stderr

	if err := fetchCmd.Run(); err != nil {
		return fmt.Errorf("git fetch failed: %w", err)
	}

	defaultBranch := getDefaultBranch(dir)

	checkoutCmd := exec.Command("git", "checkout", "-t", fmt.Sprintf("origin/%s", defaultBranch))
	checkoutCmd.Dir = dir
	checkoutCmd.Stdout = os.Stdout
	checkoutCmd.Stderr = os.Stderr

	if err := checkoutCmd.Run(); err != nil {
		return fmt.Errorf("git checkout failed: %w", err)
	}
	return nil
}

// getDefaultBranch determines the default branch name.
func getDefaultBranch(dir string) string {
	cmd := exec.Command("git", "symbolic-ref", "refs/remotes/origin/HEAD")
	cmd.Dir = dir
	output, err := cmd.Output()
	if err == nil {
		ref := strings.TrimSpace(string(output))
		parts := strings.Split(ref, "/")
		if len(parts) > 0 {
			return parts[len(parts)-1]
		}
	}

	for _, branch := range []string{"main", "master"} {
		cmd := exec.Command("git", "rev-parse", "--verify", fmt.Sprintf("origin/%s", branch))
		cmd.Dir = dir
		if err := cmd.Run(); err == nil {
			return branch
		}
	}

	return "main"
}

// configUser sets the local git user name and email.
func configUser(dir, name, email string) error {
	cmd := exec.Command("git", "config", "--local", "user.name", name)
	cmd.Dir = dir
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("failed to set user.name: %w", err)
	}

	cmd = exec.Command("git", "config", "--local", "user.email", email)
	cmd.Dir = dir
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("failed to set user.email: %w", err)
	}

	return nil
}

// FileStatus represents a file's git status.
type FileStatus struct {
	Path   string `json:"path"`
	Status string `json:"status"` // M=modified, A=added, D=deleted, R=renamed, ?=untracked
}

// GitStatus represents the overall git status.
type GitStatus struct {
	Staged   []FileStatus `json:"staged"`
	Unstaged []FileStatus `json:"unstaged"`
}

// Status returns the current git status (staged and unstaged files).
// It recursively includes changes from submodules with prefixed paths.
func Status(dir string) (*GitStatus, error) {
	return statusRecursive(dir, "")
}

func statusRecursive(dir, prefix string) (*GitStatus, error) {
	cmd := exec.Command("git", "status", "--porcelain=v1", "-uall", "--ignore-submodules=none")
	cmd.Dir = dir
	output, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("git status failed: %w", err)
	}

	result := &GitStatus{
		Staged:   []FileStatus{},
		Unstaged: []FileStatus{},
	}

	submodules := getSubmodulePaths(dir)

	for _, line := range strings.Split(string(output), "\n") {
		if len(line) < 3 {
			continue
		}

		// Porcelain v1: XY PATH where X=staged, Y=unstaged
		stagedStatus := line[0]
		unstagedStatus := line[1]
		path := strings.TrimSpace(line[3:])

		// Handle renames: "old -> new"
		if idx := strings.Index(path, " -> "); idx != -1 {
			path = path[idx+4:]
		}

		fullPath := joinPath(prefix, path)

		// Recurse into submodules
		if contains(submodules, path) {
			subStatus, err := statusRecursive(filepath.Join(dir, path), fullPath)
			if err != nil {
				slog.Warn("failed to get submodule status", "submodule", path, "error", err)
				continue
			}
			result.Staged = append(result.Staged, subStatus.Staged...)
			result.Unstaged = append(result.Unstaged, subStatus.Unstaged...)
			continue
		}

		if stagedStatus != ' ' && stagedStatus != '?' {
			result.Staged = append(result.Staged, FileStatus{Path: fullPath, Status: string(stagedStatus)})
		}
		if unstagedStatus != ' ' {
			result.Unstaged = append(result.Unstaged, FileStatus{Path: fullPath, Status: string(unstagedStatus)})
		}
	}

	return result, nil
}

func joinPath(prefix, path string) string {
	if prefix == "" {
		return path
	}
	return prefix + "/" + path
}

func contains(slice []string, item string) bool {
	for _, s := range slice {
		if s == item {
			return true
		}
	}
	return false
}

func getSubmodulePaths(dir string) []string {
	cmd := exec.Command("git", "config", "--file", ".gitmodules", "--get-regexp", "path")
	cmd.Dir = dir
	output, err := cmd.Output()
	if err != nil {
		return nil
	}

	var paths []string
	lines := strings.Split(string(output), "\n")
	for _, line := range lines {
		// Format: "submodule.<name>.path <path>"
		parts := strings.Fields(line)
		if len(parts) >= 2 {
			paths = append(paths, parts[1])
		}
	}
	return paths
}

// Diff returns the unified diff for a specific file.
// If staged is true, returns diff of staged changes (index vs HEAD).
// If staged is false, returns diff of unstaged changes (worktree vs index).
// For submodule paths (e.g., "submodule/path/to/file"), it runs diff inside the submodule.
func Diff(dir, path string, staged bool) (string, error) {
	// Resolve submodule path if needed
	actualDir, relativePath := resolveSubmodulePath(dir, path)

	var args []string
	if staged {
		args = []string{"diff", "--cached", "--", relativePath}
	} else {
		args = []string{"diff", "--", relativePath}
	}

	cmd := exec.Command("git", args...)
	cmd.Dir = actualDir
	output, err := cmd.CombinedOutput()
	if err != nil {
		fullPath := filepath.Join(actualDir, relativePath)
		if _, statErr := os.Stat(fullPath); os.IsNotExist(statErr) {
			return "", fmt.Errorf("file not found: %s", path)
		}
		if !staged {
			untrackedDiff, untrackedErr := showUntrackedFile(actualDir, relativePath)
			if untrackedErr == nil {
				return untrackedDiff, nil
			}
		}
		return "", fmt.Errorf("git diff failed: %w (output: %s)", err, string(output))
	}

	if len(output) == 0 && !staged {
		return showUntrackedFile(actualDir, relativePath)
	}

	return string(output), nil
}

// resolveSubmodulePath resolves "submodule/path/to/file" to (dir/submodule, "path/to/file").
func resolveSubmodulePath(dir, path string) (string, string) {
	submodules := getSubmodulePaths(dir)

	for _, sub := range submodules {
		prefix := sub + "/"
		if strings.HasPrefix(path, prefix) {
			subDir := filepath.Join(dir, sub)
			relativePath := strings.TrimPrefix(path, prefix)
			return subDir, relativePath
		}
	}

	return dir, path
}

// showUntrackedFile generates a diff-like output for untracked files.
func showUntrackedFile(dir, path string) (string, error) {
	fullPath := filepath.Join(dir, path)
	content, err := os.ReadFile(fullPath)
	if err != nil {
		return "", fmt.Errorf("failed to read file: %w", err)
	}

	if len(content) == 0 {
		var result strings.Builder
		result.WriteString(fmt.Sprintf("diff --git a/%s b/%s\n", path, path))
		result.WriteString("new file mode 100644\n")
		return result.String(), nil
	}

	text := string(content)
	hasTrailingNewline := strings.HasSuffix(text, "\n")
	if hasTrailingNewline {
		text = text[:len(text)-1]
	}

	lines := strings.Split(text, "\n")
	var result strings.Builder

	result.WriteString(fmt.Sprintf("diff --git a/%s b/%s\n", path, path))
	result.WriteString("new file mode 100644\n")
	result.WriteString("--- /dev/null\n")
	result.WriteString(fmt.Sprintf("+++ b/%s\n", path))
	result.WriteString(fmt.Sprintf("@@ -0,0 +1,%d @@\n", len(lines)))

	for _, line := range lines {
		result.WriteString("+" + line + "\n")
	}

	if !hasTrailingNewline {
		result.WriteString("\\ No newline at end of file\n")
	}

	return result.String(), nil
}

// DiffResult contains diff output and file contents for syntax highlighting.
type DiffResult struct {
	Diff       string `json:"diff"`
	OldContent string `json:"old_content"`
	NewContent string `json:"new_content"`
}

// DiffWithContent returns the unified diff along with old and new file contents.
// For staged changes: old = HEAD, new = index
// For unstaged changes: old = index, new = worktree
// Supports submodule paths (e.g., "submodule/path/to/file").
func DiffWithContent(dir, path string, staged bool) (*DiffResult, error) {
	diff, err := Diff(dir, path, staged)
	if err != nil {
		return nil, err
	}

	// Resolve submodule path for content retrieval
	actualDir, relativePath := resolveSubmodulePath(dir, path)

	var oldContent, newContent string

	if staged {
		oldContent, _ = getFileFromRef(actualDir, "HEAD", relativePath)
		newContent, _ = getFileFromIndex(actualDir, relativePath)
	} else {
		oldContent, _ = getFileFromIndex(actualDir, relativePath)
		newContent, _ = getFileFromWorktree(actualDir, relativePath)
	}

	return &DiffResult{
		Diff:       diff,
		OldContent: oldContent,
		NewContent: newContent,
	}, nil
}

// getFileFromRef gets file content from a git ref (e.g., HEAD).
// Returns (content, found) where found indicates if the file exists in that ref.
func getFileFromRef(dir, ref, path string) (string, bool) {
	cmd := exec.Command("git", "show", ref+":"+path)
	cmd.Dir = dir
	output, err := cmd.Output()
	if err != nil {
		return "", false
	}
	return string(output), true
}

// getFileFromIndex gets file content from git index (staging area).
// Returns (content, found) where found indicates if the file exists in the index.
func getFileFromIndex(dir, path string) (string, bool) {
	cmd := exec.Command("git", "show", ":"+path)
	cmd.Dir = dir
	output, err := cmd.Output()
	if err != nil {
		return "", false
	}
	return string(output), true
}

// getFileFromWorktree reads file content from working directory.
// Returns (content, found) where found indicates if the file exists.
func getFileFromWorktree(dir, path string) (string, bool) {
	fullPath := filepath.Join(dir, path)
	content, err := os.ReadFile(fullPath)
	if err != nil {
		return "", false
	}
	return string(content), true
}

// extractHost extracts the host from a git URL (HTTPS or SSH format).
func extractHost(repoURL string) (string, error) {
	if strings.HasPrefix(repoURL, "git@") {
		parts := strings.SplitN(repoURL, ":", 2)
		if len(parts) < 2 {
			return "", fmt.Errorf("invalid SSH URL format: %s", repoURL)
		}
		host := strings.TrimPrefix(parts[0], "git@")
		return host, nil
	}

	parsed, err := url.Parse(repoURL)
	if err != nil {
		return "", fmt.Errorf("failed to parse URL: %w", err)
	}

	if parsed.Host == "" {
		return "", fmt.Errorf("URL has no host: %s", repoURL)
	}

	return parsed.Host, nil
}
