// Package settings provides server-side settings management.
package settings

import (
	"errors"
	"path/filepath"
	"strings"

	"github.com/pockode/server/session"
)

type Settings struct {
	DefaultAgentRoleID string            `json:"default_agent_role_id,omitempty"`
	DefaultAgentType   session.AgentType `json:"default_agent_type,omitempty"`
	DefaultMode        session.Mode      `json:"default_mode,omitempty"`

	// WorktreeBaseDir overrides the directory under which git worktrees are
	// created. Empty means "use the default" (`../<repo>-worktrees`, alongside
	// the repository), preserving legacy behavior.
	WorktreeBaseDir string `json:"worktree_base_dir,omitempty"`
}

func Default() Settings {
	return Settings{}
}

// ValidateWorktreeBaseDir checks a user-provided worktree base directory.
// Empty is valid and means "use the default" (`../<repo>-worktrees`).
//
// A configured value must be one of:
//   - absolute (`/...`)
//   - repo-relative (`./...` or `../...`, resolved against the repository root)
//   - home-relative (`~` or `~/...`, resolved against the user's home directory)
//
// The remainder must be clean (no redundant separators, no trailing slash, no
// interior `..` back-and-forth). Leading `..` segments are only permitted on
// repo-relative paths, so a home-relative value can never escape the home
// directory. Actual expansion to an absolute path happens in the worktree
// registry, which has the repository and home directory context.
func ValidateWorktreeBaseDir(path string) error {
	if path == "" {
		return nil
	}

	switch {
	case path == "~" || strings.HasPrefix(path, "~/"):
		rest := strings.TrimPrefix(strings.TrimPrefix(path, "~"), "/")
		return validateWorktreeRelativeSegment(rest, false)
	case filepath.IsAbs(path):
		if filepath.Clean(path) != path {
			return errors.New("worktree base directory must be a clean path (no '..' or redundant separators)")
		}
		return nil
	case path == "." || path == ".." || strings.HasPrefix(path, "./") || strings.HasPrefix(path, "../"):
		return validateWorktreeRelativeSegment(strings.TrimPrefix(path, "./"), true)
	default:
		return errors.New("worktree base directory must be absolute or start with './', '../', or '~/'")
	}
}

// validateWorktreeRelativeSegment checks the relative remainder of a
// repo-relative or home-relative worktree base directory. It must be clean, and
// may only begin with `..` when allowParent is true (repo-relative paths).
func validateWorktreeRelativeSegment(rest string, allowParent bool) error {
	if rest == "" {
		return nil
	}
	if filepath.IsAbs(rest) || filepath.Clean(rest) != rest {
		return errors.New("worktree base directory must be a clean path (no redundant separators or interior '..')")
	}
	if !allowParent && (rest == ".." || strings.HasPrefix(rest, ".."+string(filepath.Separator))) {
		return errors.New("worktree base directory under '~' must not escape the home directory")
	}
	return nil
}
