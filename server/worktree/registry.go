package worktree

import (
	"bufio"
	"errors"
	"fmt"
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

	cacheMu   sync.RWMutex
	cache     map[string]Info
	isGitRepo bool
	cacheTime time.Time
	cacheTTL  time.Duration
}

func NewRegistry(mainDir string) *Registry {
	// Resolve symlinks for consistent path comparison (e.g., /var -> /private/var on macOS)
	if resolved, err := filepath.EvalSymlinks(mainDir); err == nil {
		mainDir = resolved
	}

	return &Registry{
		mainDir:  mainDir,
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

func (r *Registry) worktreesDir() string {
	dirname := filepath.Base(r.mainDir)
	return filepath.Join(filepath.Dir(r.mainDir), dirname+"-worktrees")
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
	cmd := exec.Command("git", "-C", r.mainDir, "worktree", "add", worktreePath, branch)
	if _, err := cmd.CombinedOutput(); err != nil {
		// Create new branch: git worktree add -b <branch> <path> [<base>]
		args := []string{"-C", r.mainDir, "worktree", "add", "-b", branch, worktreePath}
		if baseBranch != "" {
			args = append(args, baseBranch)
		}
		cmd = exec.Command("git", args...)
		if output, err := cmd.CombinedOutput(); err != nil {
			return Info{}, fmt.Errorf("git worktree add failed: %s", strings.TrimSpace(string(output)))
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

	args := []string{"-C", r.mainDir, "worktree", "remove", "--force", info.Path}

	cmd := exec.Command("git", args...)
	if output, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("git worktree remove failed: %s", strings.TrimSpace(string(output)))
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

	cmd := exec.Command("git", "-C", r.mainDir, "worktree", "list", "--porcelain")
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
