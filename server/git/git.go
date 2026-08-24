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
	// Deliberately a plain write, not filestore.WriteFileAtomic: git's own
	// credential-store helper locks this path with "<file>.lock", the same name
	// WriteFileAtomic leaves behind, and git then dies with "unable to get
	// credential storage lock". A one-shot write of one line is the smaller risk.
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
	Staged     []FileStatus          `json:"staged"`
	Unstaged   []FileStatus          `json:"unstaged"`
	Submodules map[string]*GitStatus `json:"submodules,omitempty"`
}

// HasFile returns true if the file exists in staged or unstaged list.
// Supports submodule paths (e.g., "submodule/path/to/file").
func (s *GitStatus) HasFile(path string, staged bool) bool {
	// Check submodules first
	for subPath, subStatus := range s.Submodules {
		prefix := subPath + "/"
		if strings.HasPrefix(path, prefix) {
			relativePath := strings.TrimPrefix(path, prefix)
			return subStatus.HasFile(relativePath, staged)
		}
	}

	// Check root level
	files := s.Unstaged
	if staged {
		files = s.Staged
	}
	for _, f := range files {
		if f.Path == path {
			return true
		}
	}
	return false
}

// IsUntracked returns true if the file is untracked (status "?").
// Supports submodule paths (e.g., "submodule/path/to/file").
func (s *GitStatus) IsUntracked(path string) bool {
	// Check submodules first
	for subPath, subStatus := range s.Submodules {
		prefix := subPath + "/"
		if strings.HasPrefix(path, prefix) {
			relativePath := strings.TrimPrefix(path, prefix)
			return subStatus.IsUntracked(relativePath)
		}
	}

	// Check root level
	for _, f := range s.Unstaged {
		if f.Path == path {
			return f.Status == "?"
		}
	}
	return false
}

// Status returns the current git status (staged and unstaged files).
// Submodules are returned as nested GitStatus with their relative paths as keys.
// Note: Pockode does not support nested submodules.
//
// --no-optional-locks prevents git from writing to .git/index (e.g., refreshing stat cache).
// Combined with ignoring CHMOD events in watcher.go, this prevents an infinite loop
// when watching .git/index. If issues persist, consider switching to periodic polling.
func Status(dir string) (*GitStatus, error) {
	return statusWithSubmodules(dir, getSubmodulePaths(dir))
}

// statusWithSubmodules is Status with the directory's submodule paths already
// computed, letting callers that also need the paths (Diff) avoid re-forking
// `git config --file .gitmodules` for the same directory.
func statusWithSubmodules(dir string, submodules []string) (*GitStatus, error) {
	cmd := gitCommand(dir, "--no-optional-locks", "status", "--porcelain=v1", "-z", "-uall", "--ignore-submodules=none")
	output, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("git status failed: %w", err)
	}

	result := &GitStatus{
		Staged:   []FileStatus{},
		Unstaged: []FileStatus{},
	}

	// Initialize all submodules (even if empty) so clients know they exist
	if len(submodules) > 0 {
		result.Submodules = make(map[string]*GitStatus, len(submodules))
		for _, sub := range submodules {
			subDir := filepath.Join(dir, sub)
			if !isGitRepository(subDir) {
				result.Submodules[sub] = &GitStatus{Staged: []FileStatus{}, Unstaged: []FileStatus{}}
				continue
			}
			subStatus, err := Status(subDir)
			if err != nil {
				slog.Warn("failed to get submodule status", "submodule", sub, "error", err)
				result.Submodules[sub] = &GitStatus{Staged: []FileStatus{}, Unstaged: []FileStatus{}}
				continue
			}
			result.Submodules[sub] = subStatus
		}
	}

	for _, entry := range parseStatusZ(string(output)) {
		// Skip submodule entries (already handled recursively)
		if contains(submodules, entry.path) {
			continue
		}

		if entry.staged != ' ' && entry.staged != '?' {
			result.Staged = append(result.Staged, FileStatus{Path: entry.path, Status: string(entry.staged)})
		}
		if entry.unstaged != ' ' {
			result.Unstaged = append(result.Unstaged, FileStatus{Path: entry.path, Status: string(entry.unstaged)})
		}
	}

	return result, nil
}

// statusEntry is one parsed record of `git status --porcelain=v1 -z`.
type statusEntry struct {
	staged   byte
	unstaged byte
	path     string
}

// parseStatusZ parses `git status --porcelain=v1 -z` output.
//
// The -z format is used instead of the line-based one because git C-escapes
// paths that contain non-ASCII bytes or whitespace ("\344\270\255" instead of
// "中"), and because the line format renders renames as "old -> new", which is
// ambiguous for a file actually named "a -> b". With -z the path is emitted
// verbatim and the rename source follows in its own NUL-terminated field.
func parseStatusZ(output string) []statusEntry {
	var entries []statusEntry

	fields := strings.Split(output, "\x00")
	for i := 0; i < len(fields); i++ {
		field := fields[i]
		// "XY PATH": two status bytes, a space, then at least one path byte.
		if len(field) < 4 {
			continue
		}

		entry := statusEntry{staged: field[0], unstaged: field[1], path: field[3:]}
		if isRenameOrCopy(entry.staged) || isRenameOrCopy(entry.unstaged) {
			i++ // consume the source path field
		}

		entries = append(entries, entry)
	}

	return entries
}

func isRenameOrCopy(status byte) bool {
	return status == 'R' || status == 'C'
}

func contains(slice []string, item string) bool {
	for _, s := range slice {
		if s == item {
			return true
		}
	}
	return false
}

// isGitRepository checks if dir has its own .git (file or directory).
// Uninitialized submodules lack .git, causing git commands to use parent repo.
func isGitRepository(dir string) bool {
	gitPath := filepath.Join(dir, ".git")
	_, err := os.Stat(gitPath)
	return err == nil
}

func getSubmodulePaths(dir string) []string {
	// -z terminates each entry with NUL and separates key from value with a
	// newline, so submodule paths containing spaces stay intact.
	cmd := gitCommand(dir, "config", "-z", "--file", ".gitmodules", "--get-regexp", "path")
	output, err := cmd.Output()
	if err != nil {
		return nil
	}

	var paths []string
	for _, entry := range strings.Split(string(output), "\x00") {
		// Format: "submodule.<name>.path\n<path>"
		_, path, ok := strings.Cut(entry, "\n")
		if !ok || path == "" {
			continue
		}
		paths = append(paths, path)
	}
	return paths
}

// gitCommand builds a git command running in dir with core.quotePath disabled.
//
// git's default core.quotePath=true C-escapes non-ASCII paths (rendering "中"
// as "\344\270\255") in human-readable output such as diff headers. Disabling
// it keeps those paths as real UTF-8; paths containing quotes, backslashes or
// control characters are still quoted by git regardless of this setting.
func gitCommand(dir string, args ...string) *exec.Cmd {
	cmd := exec.Command("git", append([]string{"-c", "core.quotePath=false"}, args...)...)
	cmd.Dir = dir
	return cmd
}

// DiffOptions contains options for git diff operations.
type DiffOptions struct {
	Staged         bool
	HideWhitespace bool
}

// Diff returns the unified diff for a specific file.
// If staged is true, returns diff of staged changes (index vs HEAD).
// If staged is false, returns diff of unstaged changes (worktree vs index).
// If hideWhitespace is true, ignores whitespace changes (-w flag).
// Returns empty string if file is not in git status (no changes).
// For submodule paths (e.g., "submodule/path/to/file"), it runs diff inside the submodule.
func Diff(dir, path string, opts DiffOptions) (string, error) {
	return diffWith(dir, path, opts, getSubmodulePaths(dir))
}

// diffWith is Diff with the directory's submodule paths already computed, so a
// single DiffWithContent call resolves them once instead of forking git for
// Status, the diff-side path resolution, and the content-side path resolution.
func diffWith(dir, path string, opts DiffOptions, submodules []string) (string, error) {
	status, err := statusWithSubmodules(dir, submodules)
	if err != nil {
		return "", err
	}
	if !status.HasFile(path, opts.Staged) {
		return "", nil
	}

	// Untracked files don't have a diff against index, generate synthetic diff
	if !opts.Staged && status.IsUntracked(path) {
		actualDir, relativePath := resolveSubmodulePathWith(submodules, dir, path)
		return showUntrackedFile(actualDir, relativePath)
	}

	// Resolve submodule path if needed
	actualDir, relativePath := resolveSubmodulePathWith(submodules, dir, path)

	var args []string
	if opts.Staged {
		args = []string{"diff", "--cached"}
	} else {
		args = []string{"diff"}
	}
	if opts.HideWhitespace {
		args = append(args, "-w")
	}
	args = append(args, "--", relativePath)

	cmd := gitCommand(actualDir, args...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("git diff failed: %w (output: %s)", err, string(output))
	}

	return string(output), nil
}

// resolveSubmodulePath resolves "submodule/path/to/file" to (dir/submodule, "path/to/file").
func resolveSubmodulePath(dir, path string) (string, string) {
	return resolveSubmodulePathWith(getSubmodulePaths(dir), dir, path)
}

// resolveSubmodulePathWith is resolveSubmodulePath with submodule paths precomputed.
func resolveSubmodulePathWith(submodules []string, dir, path string) (string, string) {
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
func DiffWithContent(dir, path string, opts DiffOptions) (*DiffResult, error) {
	submodules := getSubmodulePaths(dir)

	diff, err := diffWith(dir, path, opts, submodules)
	if err != nil {
		return nil, err
	}
	if diff == "" {
		return &DiffResult{}, nil
	}

	// Resolve submodule path for content retrieval
	actualDir, relativePath := resolveSubmodulePathWith(submodules, dir, path)

	var oldContent, newContent string

	if opts.Staged {
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

// Add stages a file to the git index.
// For submodule paths (e.g., "submodule/path/to/file"), it runs git add inside the submodule.
func Add(dir, path string) error {
	if err := validatePath(path); err != nil {
		return err
	}

	actualDir, relativePath := resolveSubmodulePath(dir, path)

	cmd := exec.Command("git", "add", "--", relativePath)
	cmd.Dir = actualDir
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("git add failed: %w (output: %s)", err, string(output))
	}
	return nil
}

// Reset unstages a file from the git index.
// For submodule paths (e.g., "submodule/path/to/file"), it runs git reset inside the submodule.
// Uses "git restore --staged" which handles both existing and newly added files correctly.
func Reset(dir, path string) error {
	if err := validatePath(path); err != nil {
		return err
	}

	actualDir, relativePath := resolveSubmodulePath(dir, path)

	cmd := exec.Command("git", "restore", "--staged", "--", relativePath)
	cmd.Dir = actualDir
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("git restore --staged failed: %w (output: %s)", err, string(output))
	}
	return nil
}

// validatePath checks for path traversal attacks.
func validatePath(path string) error {
	if path == "" {
		return fmt.Errorf("path is empty")
	}

	cleanPath := filepath.Clean(path)

	if filepath.IsAbs(cleanPath) {
		return fmt.Errorf("absolute paths are not allowed")
	}

	// Check if path escapes the base directory
	if cleanPath == ".." || strings.HasPrefix(cleanPath, ".."+string(filepath.Separator)) {
		return fmt.Errorf("path traversal is not allowed")
	}

	return nil
}

// Commit represents a single git commit.
type Commit struct {
	Hash    string `json:"hash"`
	Subject string `json:"subject"`
	Body    string `json:"body,omitempty"`
	Author  string `json:"author"`
	Date    string `json:"date"`
}

// Delimiters for parsing git log/show output.
// Using unique strings to reliably parse multi-line body and empty body.
const (
	commitStartDelim = "---COMMIT_START---"
	bodyStartDelim   = "---BODY_START---"
	bodyEndDelim     = "---BODY_END---"
	commitEndDelim   = "---COMMIT_END---"
)

// commitFormat is the git log/show format string.
// Format: COMMIT_START, hash, subject, BODY_START, body, BODY_END, author, date, COMMIT_END
var commitFormat = fmt.Sprintf("%s%%n%%H%%n%%s%%n%s%%n%%b%s%%n%%an%%n%%aI%%n%s",
	commitStartDelim, bodyStartDelim, bodyEndDelim, commitEndDelim)

// FileChange represents a file changed in a commit.
type FileChange struct {
	Path   string `json:"path"`
	Status string `json:"status"` // M, A, D, R
}

// ShowResult is the result of git show.
type ShowResult struct {
	Commit
	Files []FileChange `json:"files"`
}

// Log returns the commit history for the repository.
func Log(dir string, limit int) ([]Commit, error) {
	if limit <= 0 {
		limit = 50
	}

	args := []string{
		"log",
		fmt.Sprintf("-n%d", limit),
		fmt.Sprintf("--format=%s", commitFormat),
	}

	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	output, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("git log failed: %w", err)
	}

	return parseLogOutput(string(output)), nil
}

// parseLogOutput parses the output of git log with our custom format.
func parseLogOutput(output string) []Commit {
	if output == "" {
		return []Commit{}
	}

	var commits []Commit

	// Split by commit delimiter
	commitBlocks := strings.Split(output, commitStartDelim)

	for _, block := range commitBlocks {
		block = strings.TrimSpace(block)
		if block == "" {
			continue
		}

		// Remove trailing COMMIT_END
		block = strings.TrimSuffix(block, commitEndDelim)
		block = strings.TrimSpace(block)

		// Extract body section
		bodyStartIdx := strings.Index(block, bodyStartDelim)
		bodyEndIdx := strings.Index(block, bodyEndDelim)

		if bodyStartIdx == -1 || bodyEndIdx == -1 {
			continue
		}

		// Header: hash and subject
		header := strings.TrimSpace(block[:bodyStartIdx])
		headerLines := strings.SplitN(header, "\n", 2)
		if len(headerLines) < 2 {
			continue
		}
		hash := headerLines[0]
		subject := headerLines[1]

		// Body (may be empty or multi-line)
		body := strings.TrimSpace(block[bodyStartIdx+len(bodyStartDelim) : bodyEndIdx])

		// Footer: author and date
		footer := strings.TrimSpace(block[bodyEndIdx+len(bodyEndDelim):])
		footerLines := strings.SplitN(footer, "\n", 2)
		if len(footerLines) < 2 {
			continue
		}
		author := footerLines[0]
		date := strings.TrimSpace(footerLines[1])

		commits = append(commits, Commit{
			Hash:    hash,
			Subject: subject,
			Body:    body,
			Author:  author,
			Date:    date,
		})
	}

	return commits
}

// firstParentShowArgs builds `git show` arguments that render a merge commit as
// an ordinary diff against its first parent (a no-op on non-merge commits).
//
// Show (the file list) and ShowFileDiff (a file's contents) must both go through
// it: plain `git show` on a merge produces a combined diff, which omits every
// file whose content matches one of the parents, so the files the list reports
// would open with an empty diff. hash^ in ShowFileDiff is that same parent.
func firstParentShowArgs(extra ...string) []string {
	return append([]string{"show", "-m", "--first-parent"}, extra...)
}

// Show returns detailed commit information including changed files.
func Show(dir, hash string) (*ShowResult, error) {
	if err := validateCommitHash(hash); err != nil {
		return nil, err
	}

	// Get commit metadata
	args := []string{
		"show",
		"--no-patch",
		fmt.Sprintf("--format=%s", commitFormat),
		hash,
	}

	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	output, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("git show failed: %w", err)
	}

	commits := parseLogOutput(string(output))
	if len(commits) == 0 {
		return nil, fmt.Errorf("commit not found: %s", hash)
	}

	commit := commits[0]

	// Get changed files with status
	filesArgs := firstParentShowArgs("--name-status", "-z", "--format=", hash)
	filesCmd := gitCommand(dir, filesArgs...)
	filesOutput, err := filesCmd.Output()
	if err != nil {
		return nil, fmt.Errorf("git show --name-status failed: %w", err)
	}

	files := parseNameStatus(string(filesOutput))

	return &ShowResult{
		Commit: commit,
		Files:  files,
	}, nil
}

// parseNameStatus parses git's `--name-status -z` output.
//
// Fields are NUL-terminated: "M\0path\0" for ordinary changes and
// "R100\0old\0new\0" for renames/copies. The tab-separated form is not used
// because git C-escapes non-ASCII paths there (see gitCommand).
func parseNameStatus(output string) []FileChange {
	var files []FileChange

	fields := strings.Split(output, "\x00")
	for i := 0; i < len(fields); {
		status := fields[i]
		i++
		if status == "" {
			continue
		}
		if i >= len(fields) {
			break
		}

		path := fields[i]
		i++

		// For renames/copies, use the new filename and normalize to "R"
		if isRenameOrCopy(status[0]) && i < len(fields) {
			path = fields[i]
			i++
			status = "R"
		}

		files = append(files, FileChange{
			Path:   path,
			Status: status[:1],
		})
	}

	return files
}

// ShowFileDiff returns the diff of a specific file in a commit.
// If hideWhitespace is true, ignores whitespace changes (-w flag).
func ShowFileDiff(dir, hash, path string, hideWhitespace bool) (*DiffResult, error) {
	if err := validateCommitHash(hash); err != nil {
		return nil, err
	}
	if err := validatePath(path); err != nil {
		return nil, err
	}

	// Get the diff using git show
	args := firstParentShowArgs("--format=", hash)
	if hideWhitespace {
		args = append(args, "-w")
	}
	args = append(args, "--", path)

	cmd := gitCommand(dir, args...)
	output, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("git show failed: %w", err)
	}

	diff := string(output)

	// Get old content (parent commit)
	oldContent, _ := getFileFromRef(dir, hash+"^", path)
	// Get new content (the commit itself)
	newContent, _ := getFileFromRef(dir, hash, path)

	return &DiffResult{
		Diff:       diff,
		OldContent: oldContent,
		NewContent: newContent,
	}, nil
}

// validateCommitHash validates a git commit hash to prevent injection.
func validateCommitHash(hash string) error {
	if hash == "" {
		return fmt.Errorf("commit hash is empty")
	}

	// Require at least 7 hex characters (short hash minimum)
	if len(hash) < 7 {
		return fmt.Errorf("commit hash too short")
	}

	// Only allow hex characters for security
	for _, c := range hash {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
			return fmt.Errorf("invalid commit hash character: %c", c)
		}
	}

	return nil
}
