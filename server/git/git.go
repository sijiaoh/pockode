// Package git provides git repository operations including initialization, status, and diff.
package git

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"

	"github.com/pockode/server/contents"
	"github.com/pockode/server/internal/fsperm"
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

// credentialHelperConfig builds the credential.helper value that points git at
// our credentials file.
//
// Git runs a helper whose configured value contains shell metacharacters through
// `sh -c`, and the space before `--file=` always triggers that. So the path has
// to survive shell parsing: on Windows `C:\Users\me\.git-credentials` reaches
// the helper as `C:Usersme.git-credentials`, because the shell consumes each
// backslash as an escape. Forward slashes avoid that (git accepts them on
// Windows), and quoting keeps a path with spaces — `C:/Users/My Name/...`, the
// common case there — from being split into two arguments.
func credentialHelperConfig(credFile string) string {
	return "store --file=" + shellQuote(filepath.ToSlash(credFile))
}

// shellQuote renders s as a single POSIX shell word. An embedded single quote
// cannot be escaped inside a quoted run, so the run is closed, the quote emitted
// as a backslash escape, and a new run opened.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// setupLocalCredential configures a local credential helper and writes the credentials file.
func setupLocalCredential(dir, host, token string) error {
	gitDir := filepath.Join(dir, ".git")
	credFile := filepath.Join(gitDir, ".git-credentials")

	// Restrict .git before the PAT lands inside it. The directory rather than
	// the file, for the usual reason plus a specific one: git's `store` helper
	// rewrites the credentials file on every successful authentication, through
	// a lock file it renames over the target. That replacement carries the
	// permissions it was created with, so anything set on the file itself is
	// gone after the first push. Its umask(077) keeps the rewrite at 0600 on
	// unix, but a umask means nothing on Windows — there only an inherited ACL
	// survives.
	//
	// Restricting a directory Pockode does not own would be presumptuous; this
	// one it does. Init returns early when .git already exists, so reaching
	// here means git init created it moments ago.
	if err := fsperm.RestrictDir(gitDir); err != nil {
		return fmt.Errorf("failed to restrict git directory: %w", err)
	}

	cmd := exec.Command("git", "config", "--local", "credential.helper", credentialHelperConfig(credFile))
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
//
// An entry describes one side of the file — the staged list compares HEAD with
// the index, the unstaged list the index with the working tree — and so do its
// line counts. A file changed on both sides appears in both lists, each with
// the counts of its own diff, so the file's whole change is their sum: exactly
// the two diffs a reviewer reads for it.
//
// Lines is nil when the side has no lines to count. Binary then says whether
// that is because git treats the file as binary; with Binary false the count is
// simply unknown — a conflicted file, an untracked one too large, unreadable or
// past the read budget to count, or a rename the status and the numstat paired
// differently (only a `status.renameLimit` set apart from `diff.renameLimit`
// can still do that).
type FileStatus struct {
	Path   string    `json:"path"`
	Status string    `json:"status"` // M=modified, A=added, D=deleted, R=renamed, ?=untracked
	Lines  *LineStat `json:"lines,omitempty"`
	Binary bool      `json:"binary,omitempty"`
	// OrigPath is the path a renamed file had in HEAD, set on the staged
	// entry of a rename only. An unstaged move is a deletion plus an untracked
	// file — except after `git add -N`, whose unstaged rename is left without a
	// source and is counted and diffed as its new path alone.
	OrigPath string `json:"orig_path,omitempty"`
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
	return s.file(path, staged) != nil
}

// file is path's entry on one side, nil when that side has none. Supports
// submodule paths; the entry's own paths are relative to the submodule.
func (s *GitStatus) file(path string, staged bool) *FileStatus {
	// Check submodules first
	for subPath, subStatus := range s.Submodules {
		prefix := subPath + "/"
		if strings.HasPrefix(path, prefix) {
			relativePath := strings.TrimPrefix(path, prefix)
			return subStatus.file(relativePath, staged)
		}
	}

	// Check root level
	files := s.Unstaged
	if staged {
		files = s.Staged
	}
	for i := range files {
		if files[i].Path == path {
			return &files[i]
		}
	}
	return nil
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

// Status returns the current git status (staged and unstaged files), with
// each file's line counts (see FileStatus).
// Submodules are returned as nested GitStatus with their relative paths as keys.
// Note: Pockode does not support nested submodules.
//
// --no-optional-locks prevents git from writing to .git/index (e.g., refreshing stat cache).
// Combined with ignoring CHMOD events in watcher.go, this prevents an infinite loop
// when watching .git/index. If issues persist, consider switching to periodic polling.
func Status(dir string) (*GitStatus, error) {
	return StatusContext(context.Background(), dir)
}

// StatusContext is Status bounded by ctx, for a caller that has to be able to
// give up on it.
func StatusContext(ctx context.Context, dir string) (*GitStatus, error) {
	return readStatus(ctx, dir, getSubmodulePaths(dir), true)
}

// statusWithSubmodules is Status without the line counts, which only the
// client displays, and with the directory's submodule paths already computed,
// letting callers that also need the paths (Diff) avoid re-forking
// `git config --file .gitmodules` for the same directory.
func statusWithSubmodules(dir string, submodules []string) (*GitStatus, error) {
	return readStatus(context.Background(), dir, submodules, false)
}

func readStatus(ctx context.Context, dir string, submodules []string, countLines bool) (*GitStatus, error) {
	// The status and both numstats are independent reads of the repository, so
	// they run together: each may take a while in a large one.
	var output string
	var staged, unstaged numstat
	var statusErr, stagedErr, unstagedErr error
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		// Renames are always detected, whatever status.renames says: the
		// staged numstat and the review's diff pair them the same way
		// (readNumstat, DiffWithContent), and all three have to agree.
		output, statusErr = execGitRaw(ctx, dir, "--no-optional-locks", "status", "--porcelain=v1", "-z", "-uall", "--ignore-submodules=none", "--find-renames")
	}()
	if countLines {
		wg.Add(2)
		go func() {
			defer wg.Done()
			staged, stagedErr = readNumstat(ctx, dir, true)
		}()
		go func() {
			defer wg.Done()
			unstaged, unstagedErr = readNumstat(ctx, dir, false)
		}()
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
			subStatus, err := readStatus(ctx, subDir, getSubmodulePaths(subDir), countLines)
			if err != nil {
				slog.Warn("failed to get submodule status", "submodule", sub, "error", err)
				result.Submodules[sub] = &GitStatus{Staged: []FileStatus{}, Unstaged: []FileStatus{}}
				continue
			}
			result.Submodules[sub] = subStatus
		}
	}

	wg.Wait()
	// A repository git cannot read fails all three the same way; status's own
	// account is the one to show, once.
	if statusErr != nil {
		return nil, statusErr
	}
	if err := errors.Join(stagedErr, unstagedErr); err != nil {
		return nil, err
	}

	budget := int64(untrackedBudget)
	for _, entry := range parseStatusZ(output) {
		// Skip submodule entries (already handled recursively)
		if contains(submodules, entry.path) {
			continue
		}

		// A conflicted file's numstat describes no diff anyone reads: the index
		// holds its stages rather than a version, so it is left uncounted.
		count := countLines && !entry.unmerged()

		if entry.staged != ' ' && entry.staged != '?' {
			file := FileStatus{Path: entry.path, Status: string(entry.staged), OrigPath: entry.origPath}
			if count {
				staged.fill(&file)
			}
			result.Staged = append(result.Staged, file)
		}
		if entry.unstaged != ' ' {
			file := FileStatus{Path: entry.path, Status: string(entry.unstaged)}
			if count && entry.unstaged == '?' {
				countUntracked(dir, &file, &budget)
			} else if count {
				unstaged.fill(&file)
			}
			result.Unstaged = append(result.Unstaged, file)
		}
	}

	return result, nil
}

// statusEntry is one parsed record of `git status --porcelain=v1 -z`.
type statusEntry struct {
	staged   byte
	unstaged byte
	path     string
	// origPath is the rename or copy source, empty for any other entry.
	origPath string
}

// unmerged reports a conflicted path: either side "U", or both sides added or
// both deleted ("AA", "DD"), as `git status --porcelain` documents them.
func (e statusEntry) unmerged() bool {
	return e.staged == 'U' || e.unstaged == 'U' ||
		(e.staged == 'A' && e.unstaged == 'A') ||
		(e.staged == 'D' && e.unstaged == 'D')
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
			i++
			if i < len(fields) {
				entry.origPath = fields[i]
			}
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

// DiffOptions contains options for git diff operations.
type DiffOptions struct {
	Staged         bool
	HideWhitespace bool
}

// diffFile runs git diff for a tracked path git status reports as changed,
// with dir and path already resolved into the submodule that holds it.
//
// origPath is a staged rename's source, or empty. With it the diff names both
// paths, so git pairs them as the status did; limited to the new path alone,
// it would show the whole file as added.
func diffFile(dir, path, origPath string, opts DiffOptions) (string, error) {
	// The format is pinned against the user's diff config, because a hunk of
	// this output is what StageHunk hands to `git apply`: the file's own
	// content, not an external driver's or a textconv's rendering of it —
	// applied, a textconv'd hunk would write the rendering into the index — no
	// colour, the a/ b/ prefixes apply expects, and three lines of context,
	// which apply needs at least one of to place a hunk.
	args := []string{"diff", "--no-ext-diff", "--no-textconv", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", "--unified=3"}
	if opts.Staged {
		args = append(args, "--cached", "--find-renames")
	} else {
		// As the working tree's numstat counts it (readNumstat).
		args = append(args, "--no-renames")
	}
	if opts.HideWhitespace {
		args = append(args, "-w")
	}
	paths := []string{path}
	if origPath != "" {
		paths = append(paths, origPath)
	}
	args = append(args, "--")
	for _, p := range paths {
		pathspec, err := literalPathspec(p)
		if err != nil {
			return "", fmt.Errorf("%w: %s", err, p)
		}
		args = append(args, pathspec)
	}

	// stdout alone: git warns on stderr (autocrlf's "LF will be replaced"),
	// and a warning inside the diff would end up in a hunk.
	output, err := execGitRaw(context.Background(), dir, args...)
	if err != nil {
		return "", fmt.Errorf("git diff failed: %w", err)
	}
	return output, nil
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

// untrackedDiff generates a diff-like output for an untracked file, which has
// no diff against the index for git to produce.
func untrackedDiff(path, content string) string {
	if len(content) == 0 {
		var result strings.Builder
		result.WriteString(fmt.Sprintf("diff --git a/%s b/%s\n", path, path))
		result.WriteString("new file mode 100644\n")
		return result.String()
	}

	text := content
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

	return result.String()
}

// DiffResult contains diff output and file contents for syntax highlighting.
//
// When either version of the file is over contents.MaxFileSize, none of the
// three is sent: they travel together in one message, and no part of it may be
// larger than file.get would send (contents.MaxFileSize says why). Omitted,
// Size, MIME and Limit then describe the larger version in the words a
// FileContent uses for the same refusal, so a client explains it the way it
// explains a file too large to open; all four are empty otherwise.
//
// The limit is per version, not per message: a full rewrite of a file just
// within it still costs about four times the file.
type DiffResult struct {
	Diff       string              `json:"diff"`
	OldContent string              `json:"old_content"`
	NewContent string              `json:"new_content"`
	Omitted    contents.OmitReason `json:"omitted,omitempty"`
	Size       int64               `json:"size,omitempty"`
	MIME       string              `json:"mime,omitempty"`
	Limit      int64               `json:"limit,omitempty"`
	// HunkIDs names the hunks of Diff in the order their `@@` lines appear,
	// for StageHunk and UnstageHunk. Absent when the hunks cannot be applied
	// as shown: with whitespace hidden, for a binary or conflicted file, and
	// for a commit's diff, which is history rather than something to stage.
	HunkIDs []string `json:"hunk_ids,omitempty"`
}

// diffSide is one of the two versions of a file a diff compares.
type diffSide struct {
	dir string
	// spec names a git object — "HEAD:<path>", ":<path>" for the index — and is
	// empty for the file in the working tree at dir/path.
	spec string
	path string
}

func objectSide(dir, rev, path string) diffSide {
	return diffSide{dir: dir, spec: rev + ":" + path, path: path}
}

// indexSide is the staged version: a revision left empty in "<rev>:<path>"
// names the index.
func indexSide(dir, path string) diffSide {
	return objectSide(dir, "", path)
}

func worktreeSide(dir, path string) diffSide {
	return diffSide{dir: dir, path: path}
}

// read returns the side's content bounded the way contents.ReadBounded bounds
// it. A version that does not exist — the old side of an added file, the new
// side of a deleted one — reads as empty, which is what the diff shows for it.
//
// A git object that cannot be read reads as empty too, since git's exit status
// does not tell a missing path from any other failure. That costs at most the
// highlighting the content would have fed: a repository that is really broken
// fails the diff itself.
func (s diffSide) read() (size int64, content []byte, err error) {
	if s.spec == "" {
		return readWorktree(filepath.Join(s.dir, s.path))
	}
	size, content, err = readBlobBounded(s.dir, s.spec, nil)
	if err != nil {
		return 0, nil, nil
	}
	return size, content, nil
}

// readWorktree reads a working-tree file as git would store it. For a symlink
// that is the link's target, not the file it points to: that is what the index
// holds and what git diff compares, and following the link would size, or
// show, an unrelated file.
func readWorktree(fullPath string) (int64, []byte, error) {
	info, err := os.Lstat(fullPath)
	if errors.Is(err, fs.ErrNotExist) {
		return 0, nil, nil
	}
	if err != nil {
		return 0, nil, err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		target, err := os.Readlink(fullPath)
		if err != nil {
			return 0, nil, err
		}
		// git records the target with forward slashes on every platform.
		target = filepath.ToSlash(target)
		return int64(len(target)), []byte(target), nil
	}
	return contents.ReadBounded(fullPath)
}

// diffSides reads both versions of path, or returns the too-large result when
// either is over contents.MaxFileSize. Callers produce the diff only after
// this, so a file too large to send is never diffed either.
func diffSides(path string, oldSide, newSide diffSide) (oldContent, newContent string, tooLarge *DiffResult, err error) {
	oldSize, oldBytes, err := oldSide.read()
	if err != nil {
		return "", "", nil, err
	}
	newSize, newBytes, err := newSide.read()
	if err != nil {
		return "", "", nil, err
	}

	size, head := newSize, newBytes
	if oldSize > newSize {
		size, head = oldSize, oldBytes
	}
	if size > contents.MaxFileSize {
		return "", "", &DiffResult{
			Omitted: contents.OmitTooLarge,
			Size:    size,
			MIME:    contents.DetectMIME(path, head),
			Limit:   contents.MaxFileSize,
		}, nil
	}
	return string(oldBytes), string(newBytes), nil, nil
}

// DiffWithContent returns the unified diff along with old and new file contents.
// For staged changes: old = HEAD, new = index
// For unstaged changes: old = index, new = worktree
// The result is empty when the file has no changes of the kind opts.Staged
// asks for, and carries no content when the file is too large to send (see
// DiffResult).
// Supports submodule paths (e.g., "submodule/path/to/file").
func DiffWithContent(dir, path string, opts DiffOptions) (*DiffResult, error) {
	submodules := getSubmodulePaths(dir)

	status, err := statusWithSubmodules(dir, submodules)
	if err != nil {
		return nil, err
	}
	file := status.file(path, opts.Staged)
	if file == nil {
		return &DiffResult{}, nil
	}

	actualDir, relativePath := resolveSubmodulePathWith(submodules, dir, path)

	var oldSide, newSide diffSide
	if opts.Staged {
		oldPath := relativePath
		if file.OrigPath != "" {
			oldPath = file.OrigPath
		}
		oldSide = objectSide(actualDir, "HEAD", oldPath)
		newSide = indexSide(actualDir, relativePath)
	} else {
		oldSide = indexSide(actualDir, relativePath)
		newSide = worktreeSide(actualDir, relativePath)
	}

	oldContent, newContent, tooLarge, err := diffSides(path, oldSide, newSide)
	if err != nil {
		return nil, fmt.Errorf("failed to read %s: %w", path, err)
	}
	if tooLarge != nil {
		return tooLarge, nil
	}

	var diff string
	var hunkIDs []string
	if !opts.Staged && status.IsUntracked(path) {
		// From the content already read rather than the file again, which may
		// have grown past the limit in between.
		diff = untrackedDiff(relativePath, newContent)
		// A binary file is drawn as text here, but staged as the file it is.
		if !strings.Contains(newContent[:min(len(newContent), binarySniffLen)], "\x00") {
			hunkIDs = hunkIDsFor(path, file, opts, diff)
		}
	} else {
		diff, err = diffFile(actualDir, relativePath, file.OrigPath, opts)
		if err != nil {
			return nil, err
		}
		hunkIDs = hunkIDsFor(path, file, opts, diff)
	}
	if diff == "" {
		return &DiffResult{}, nil
	}

	return &DiffResult{
		Diff:       diff,
		OldContent: oldContent,
		NewContent: newContent,
		HunkIDs:    hunkIDs,
	}, nil
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

// Add stages files to the git index.
// For submodule paths (e.g., "submodule/path/to/file"), it runs git add inside the submodule.
//
// The whole request is one locked operation rather than one per path: a commit
// slipping between two of them would record half of what the user staged.
func Add(dir string, paths ...string) error {
	return stagingOp(dir, opStage, paths, func(actualDir, pathspec string) error {
		_, err := execGit(actualDir, "add", "--", pathspec)
		return err
	})
}

// Reset unstages files from the git index.
// For submodule paths (e.g., "submodule/path/to/file"), it runs git reset inside the submodule.
// Uses "git restore --staged" which handles both existing and newly added files
// correctly, and "git rm --cached" before the first commit, where there is no
// HEAD to restore from.
func Reset(dir string, paths ...string) error {
	return stagingOp(dir, opUnstage, paths, func(actualDir, pathspec string) error {
		_, err := execGit(actualDir, "restore", "--staged", "--", pathspec)
		if err != nil && isUnborn(actualDir) {
			// Before the first commit unstaging is dropping the entry from the
			// index. -f only lifts rm's refusal of an entry that differs from the
			// file on disk; with --cached the file itself is never touched.
			_, err = execGit(actualDir, "rm", "--cached", "-f", "-r", "--quiet", "--", pathspec)
		}
		return err
	})
}

// isUnborn reports whether dir is a repository whose HEAD names a branch with
// no commits yet — the state `git init` leaves. Only exit 1 counts: that is
// `rev-parse --verify --quiet` saying HEAD resolves to nothing, where a broken
// or missing repository is fatal and exits otherwise.
func isUnborn(dir string) bool {
	_, err := execGit(dir, "rev-parse", "--verify", "--quiet", "HEAD")
	var exitErr *exec.ExitError
	return errors.As(err, &exitErr) && exitErr.ExitCode() == 1
}

// stagingOp is Add and Reset, which differ only in the command they run per
// path. Each path is resolved against the submodule it may live in and run
// there; every one is validated before any of them runs, so a rejected path
// stops the request rather than leaving half of it applied.
func stagingOp(dir string, op operation, paths []string, run func(actualDir, pathspec string) error) error {
	if len(paths) == 0 {
		return fmt.Errorf("no paths to %s", op.name)
	}
	for _, path := range paths {
		if err := validatePath(path); err != nil {
			return err
		}
	}

	return withLock(dir, op, func() error {
		for _, path := range paths {
			actualDir, relativePath := resolveSubmodulePath(dir, path)
			pathspec, err := literalPathspec(relativePath)
			if err != nil {
				return fmt.Errorf("%w: %s", err, path)
			}
			if err := run(actualDir, pathspec); err != nil {
				return err
			}
		}
		return nil
	})
}

// validatePath checks that a repository-relative path stays inside the
// repository.
func validatePath(path string) error {
	if path == "" {
		return fmt.Errorf("path is empty")
	}

	// filepath.IsLocal is the rest of the check: it accepts exactly those paths
	// the OS resolves inside the directory they are joined to. That is absolute and
	// `..`-escaping paths everywhere, plus, on Windows, the forms filepath.IsAbs
	// calls relative — root-relative (`\etc`, the current drive), drive-relative
	// (`C:etc`, that drive's working directory) — and the reserved device names
	// (`NUL`, `COM1`), which name a device rather than a file in the repository.
	//
	// contents.ValidatePath gates the same paths on the way in and must stay in
	// agreement with this; ws/rpc_git.go runs both over one path.
	if !filepath.IsLocal(path) {
		return fmt.Errorf("path must stay inside the repository: %s", path)
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
		// Asked only once log has failed, so the ordinary case pays for nothing.
		if isUnborn(dir) {
			return []Commit{}, nil
		}
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

	// hash^ is the first parent, the same one firstParentShowArgs diffs against.
	oldContent, newContent, tooLarge, err := diffSides(path, objectSide(dir, hash+"^", path), objectSide(dir, hash, path))
	if err != nil {
		return nil, fmt.Errorf("failed to read %s in commit %s: %w", path, hash, err)
	}
	if tooLarge != nil {
		return tooLarge, nil
	}

	args := firstParentShowArgs("--format=", hash)
	if hideWhitespace {
		args = append(args, "-w")
	}
	pathspec, err := literalPathspec(path)
	if err != nil {
		return nil, fmt.Errorf("%w: %s", err, path)
	}
	args = append(args, "--", pathspec)

	cmd := gitCommand(dir, args...)
	output, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("git show failed: %w", err)
	}

	return &DiffResult{
		Diff:       string(output),
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
