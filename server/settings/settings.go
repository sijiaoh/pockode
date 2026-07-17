// Package settings provides server-side settings management.
package settings

import (
	"errors"
	"path/filepath"

	"github.com/pockode/server/session"
)

type Settings struct {
	DefaultAgentRoleID string            `json:"default_agent_role_id,omitempty"`
	DefaultAgentType   session.AgentType `json:"default_agent_type,omitempty"`
	DefaultMode        session.Mode      `json:"default_mode,omitempty"`

	// WorktreeBaseDir overrides the directory under which git worktrees are
	// created. Empty means "use the default" (a `<repo>-worktrees` directory
	// alongside the repository), preserving legacy behavior.
	WorktreeBaseDir string `json:"worktree_base_dir,omitempty"`
}

func Default() Settings {
	return Settings{}
}

// ValidateWorktreeBaseDir checks a user-provided worktree base directory.
// Empty is valid and means "use the default". A configured value must be an
// absolute, clean path: absolute so it never depends on the server's working
// directory, and clean so it cannot contain `..` traversal segments.
func ValidateWorktreeBaseDir(path string) error {
	if path == "" {
		return nil
	}
	if !filepath.IsAbs(path) {
		return errors.New("worktree base directory must be an absolute path")
	}
	if filepath.Clean(path) != path {
		return errors.New("worktree base directory must be a clean path (no '..' or redundant separators)")
	}
	return nil
}
