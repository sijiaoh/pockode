package worktree

import (
	"bufio"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

var (
	ErrNotGitRepo           = errors.New("not a git repository")
	ErrWorktreeNotFound     = errors.New("worktree not found")
	ErrMainWorktree         = errors.New("cannot delete main worktree")
	ErrWorktreeAlreadyExist = errors.New("worktree already exists")
)

type Info struct {
	Name   string `json:"name"`
	Path   string `json:"path"`
	Branch string `json:"branch"`
	IsMain bool   `json:"is_main"`
}

// Registry manages worktree discovery with TTL-based caching.
type Registry struct {
	mainDir string
	dataDir string

	// baseDirProvider returns the configured worktree base directory, or "" to
	// use the default alongside the repository. It is read on every worktree
	// operation so runtime settings changes take effect without a restart.
	baseDirProvider func() string

	cacheMu   sync.RWMutex
	cache     map[string]Info
	isGitRepo bool
	cacheTime time.Time
	cacheTTL  time.Duration
}

func NewRegistry(mainDir, dataDir string) *Registry {
	// Resolve symlinks for consistent path comparison (e.g., /var -> /private/var on macOS)
	if resolved, err := filepath.EvalSymlinks(mainDir); err == nil {
		mainDir = resolved
	}

	return &Registry{
		mainDir:  mainDir,
		dataDir:  dataDir,
		cache:    make(map[string]Info),
		cacheTTL: 3 * time.Second,
	}
}

func (r *Registry) IsGitRepo() bool {
	r.refreshIfNeeded()
	r.cacheMu.RLock()
	defer r.cacheMu.RUnlock()
	return r.isGitRepo
}

func (r *Registry) MainDir() string {
	return r.mainDir
}

// SetBaseDirProvider wires a source for the configurable worktree base
// directory. The provider returns a value validated at the settings boundary:
// absolute, `./`/`../` (repo-relative), `~`/`~/...` (home-relative), or "" for
// the default. expandBaseDir turns it into an absolute path.
func (r *Registry) SetBaseDirProvider(provider func() string) {
	r.baseDirProvider = provider
}

func (r *Registry) worktreesDir() string {
	if r.baseDirProvider != nil {
		if base := r.baseDirProvider(); base != "" {
			return resolveExistingPrefix(r.expandBaseDir(base))
		}
	}
	dirname := filepath.Base(r.mainDir)
	return filepath.Join(filepath.Dir(r.mainDir), dirname+"-worktrees")
}

// expandBaseDir turns a configured base directory into an absolute path.
// It mirrors the prefixes accepted by settings.ValidateWorktreeBaseDir:
//   - `~`/`~/...`  → relative to the user's home directory
//   - absolute     → used as-is
//   - `./`/`../`   → relative to the repository root (main worktree)
func (r *Registry) expandBaseDir(base string) string {
	switch {
	case base == "~" || strings.HasPrefix(base, "~/"):
		home, err := os.UserHomeDir()
		if err != nil {
			// Home directory is unknown; fall back to a cleaned literal so the
			// path stays deterministic rather than silently using the default.
			return filepath.Clean(base)
		}
		return filepath.Join(home, strings.TrimPrefix(strings.TrimPrefix(base, "~"), "/"))
	case filepath.IsAbs(base):
		return filepath.Clean(base)
	default:
		return filepath.Join(r.mainDir, base)
	}
}

// resolveExistingPrefix resolves symlinks in the longest existing prefix of
// path and re-appends the not-yet-created remainder. The configured base dir
// may not exist yet (git creates it on first worktree add), yet
// `git worktree list` reports fully symlink-resolved paths — so discovery must
// compare against a resolved base, otherwise managed worktrees created under a
// symlinked base (e.g. macOS /var -> /private/var) are mistaken for external
// ones and silently disappear.
func resolveExistingPrefix(path string) string {
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		return resolved
	}
	parent := filepath.Dir(path)
	if parent == path {
		// Reached the filesystem root without finding an existing ancestor.
		return path
	}
	return filepath.Join(resolveExistingPrefix(parent), filepath.Base(path))
}

// Resolve returns the full path for a worktree name (empty string = main worktree).
func (r *Registry) Resolve(name string) (string, error) {
	if name == "" {
		return r.mainDir, nil
	}

	r.refreshIfNeeded()

	r.cacheMu.RLock()
	isGitRepo := r.isGitRepo
	info, ok := r.cache[name]
	r.cacheMu.RUnlock()

	if !isGitRepo {
		return "", ErrNotGitRepo
	}
	if !ok {
		return "", ErrWorktreeNotFound
	}

	return info.Path, nil
}

func (r *Registry) List() []Info {
	r.refreshIfNeeded()

	r.cacheMu.RLock()
	defer r.cacheMu.RUnlock()

	result := make([]Info, 0, len(r.cache))

	if main, ok := r.cache[""]; ok {
		result = append(result, main)
	}
	for name, info := range r.cache {
		if name != "" {
			result = append(result, info)
		}
	}

	return result
}

func (r *Registry) Create(name, branch, baseBranch string) (Info, error) {
	if name == "" {
		return Info{}, errors.New("name cannot be empty")
	}
	if branch == "" {
		return Info{}, errors.New("branch cannot be empty")
	}

	worktreesDir := r.worktreesDir()
	worktreePath := filepath.Join(worktreesDir, name)
	if !strings.HasPrefix(worktreePath, worktreesDir+string(filepath.Separator)) {
		return Info{}, errors.New("invalid name: path traversal detected")
	}

	r.refreshIfNeeded()

	r.cacheMu.RLock()
	isGitRepo := r.isGitRepo
	_, exists := r.cache[name]
	r.cacheMu.RUnlock()

	if !isGitRepo {
		return Info{}, ErrNotGitRepo
	}
	if exists {
		return Info{}, ErrWorktreeAlreadyExist
	}

	// Try without -b first (works for existing local/remote branches),
	// fall back to -b for new branches.
	cmd := exec.Command("git", "worktree", "add", worktreePath, branch)
	cmd.Dir = r.mainDir
	if _, err := cmd.CombinedOutput(); err != nil {
		// Create new branch: git worktree add -b <branch> <path> [<base>]
		args := []string{"worktree", "add", "-b", branch, worktreePath}
		if baseBranch != "" {
			args = append(args, baseBranch)
		}
		cmd = exec.Command("git", args...)
		cmd.Dir = r.mainDir
		if output, err := cmd.CombinedOutput(); err != nil {
			return Info{}, fmt.Errorf("git worktree add: %w: %s", err, strings.TrimSpace(string(output)))
		}
	}

	r.invalidateCache()
	r.refreshIfNeeded()

	r.cacheMu.RLock()
	info, ok := r.cache[name]
	r.cacheMu.RUnlock()

	if !ok {
		return Info{}, errors.New("worktree created but not found in list")
	}

	if err := RunSetupHook(r.dataDir, r.mainDir, info.Path, name); err != nil {
		if delErr := r.Delete(name); delErr != nil {
			slog.Warn("failed to cleanup worktree after setup hook failure", "name", name, "error", delErr)
		}
		return Info{}, fmt.Errorf("setup hook failed: %w", err)
	}

	return info, nil
}

func (r *Registry) Delete(name string) error {
	if name == "" {
		return ErrMainWorktree
	}

	r.refreshIfNeeded()

	r.cacheMu.RLock()
	isGitRepo := r.isGitRepo
	info, ok := r.cache[name]
	r.cacheMu.RUnlock()

	if !isGitRepo {
		return ErrNotGitRepo
	}
	if !ok {
		return ErrWorktreeNotFound
	}

	cmd := exec.Command("git", "worktree", "remove", "--force", info.Path)
	cmd.Dir = r.mainDir
	if output, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("git worktree remove: %w: %s", err, strings.TrimSpace(string(output)))
	}

	r.invalidateCache()

	return nil
}

func (r *Registry) refreshIfNeeded() {
	r.cacheMu.RLock()
	needsRefresh := time.Since(r.cacheTime) > r.cacheTTL
	r.cacheMu.RUnlock()

	if needsRefresh {
		r.refresh()
	}
}

func (r *Registry) invalidateCache() {
	r.cacheMu.Lock()
	r.cacheTime = time.Time{}
	r.cacheMu.Unlock()
}

func (r *Registry) refresh() {
	r.cacheMu.Lock()
	defer r.cacheMu.Unlock()

	if time.Since(r.cacheTime) <= r.cacheTTL {
		return
	}

	cmd := exec.Command("git", "worktree", "list", "--porcelain")
	cmd.Dir = r.mainDir
	output, err := cmd.Output()
	if err != nil {
		// Not a git repo or git not available
		r.isGitRepo = false
		r.cache = map[string]Info{
			"": {Name: "", Path: r.mainDir, Branch: "", IsMain: true},
		}
		r.cacheTime = time.Now()
		return
	}

	r.isGitRepo = true
	worktrees := make(map[string]Info)

	var currentPath, currentBranch string
	worktreesDir := r.worktreesDir()

	scanner := bufio.NewScanner(strings.NewReader(string(output)))
	for scanner.Scan() {
		line := scanner.Text()

		if strings.HasPrefix(line, "worktree ") {
			// New worktree entry; reset state
			currentPath = strings.TrimPrefix(line, "worktree ")
			currentBranch = ""
		} else if strings.HasPrefix(line, "branch ") {
			branch := strings.TrimPrefix(line, "branch ")
			if strings.HasPrefix(branch, "refs/heads/") {
				currentBranch = strings.TrimPrefix(branch, "refs/heads/")
			} else {
				currentBranch = branch
			}
		} else if line == "" && currentPath != "" {
			if info := r.createInfo(currentPath, currentBranch, worktreesDir); info != nil {
				worktrees[info.Name] = *info
			}
			currentPath = ""
			currentBranch = ""
		}
	}

	if currentPath != "" {
		if info := r.createInfo(currentPath, currentBranch, worktreesDir); info != nil {
			worktrees[info.Name] = *info
		}
	}

	r.cache = worktrees
	r.cacheTime = time.Now()
}

// createInfo returns Info for a worktree path.
// Returns nil if the worktree should be skipped (external worktrees not managed by Pockode).
func (r *Registry) createInfo(path, branch, worktreesDir string) *Info {
	isMain := path == r.mainDir

	var name string
	switch {
	case isMain:
		name = ""
	case strings.HasPrefix(path, worktreesDir+string(filepath.Separator)):
		name = strings.TrimPrefix(path, worktreesDir+string(filepath.Separator))
	default:
		// External worktree: skip
		return nil
	}

	return &Info{
		Name:   name,
		Path:   path,
		Branch: branch,
		IsMain: isMain,
	}
}
