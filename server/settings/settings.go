// Package settings provides server-side settings management.
package settings

import (
	"errors"
	"path/filepath"
	"strings"

	"github.com/pockode/server/internal/pathutil"
	"github.com/pockode/server/session"
)

type Settings struct {
	DefaultAgentRoleID string            `json:"default_agent_role_id,omitempty"`
	DefaultAgentType   session.AgentType `json:"default_agent_type,omitempty"`
	DefaultMode        session.Mode      `json:"default_mode,omitempty"`

	// DefaultModel and DefaultEffort are the model and effort new sessions get,
	// and belong to DefaultAgentType: both are agent-specific lists (see
	// session/model.go and session/effort.go), so a value here is only ever
	// judged — and only ever applied — against that agent. Empty means no flag
	// is passed and the CLI decides for itself.
	DefaultModel  string `json:"default_model,omitempty"`
	DefaultEffort string `json:"default_effort,omitempty"`

	// WorktreeBaseDir overrides the directory under which git worktrees are
	// created. Empty means "use the default" (`../<repo>-worktrees`, alongside
	// the repository), preserving legacy behavior.
	WorktreeBaseDir string `json:"worktree_base_dir,omitempty"`
}

func Default() Settings {
	return Settings{}
}

// NormalizeWorktreeBaseDir converts a configured worktree base directory to the
// platform's native separator form.
//
// The value is hand-written by the user and often carried between machines, so
// `/` is accepted as a separator everywhere. Normalizing first is what makes the
// setting usable on Windows at all: validation and expansion both compare
// against filepath.Clean, which rewrites `../worktrees` to `..\worktrees` there,
// so an un-normalized value can never compare equal to itself.
//
// Callers that interpret the setting (validation here, expansion in the worktree
// registry) must run it through this first, or the two disagree.
func NormalizeWorktreeBaseDir(path string) string {
	return filepath.FromSlash(path)
}

// Engine is the global default engine: the agent new sessions run on, with the
// model and effort chosen for it.
//
// An unset DefaultAgentType is reported as the server's built-in default agent,
// because that is the agent an unset default actually starts sessions on — a
// user who never touched the agent setting can still pick a model, and it is
// judged against the agent that model will really run under. This is the one
// place where an empty agent type is filled in rather than deferred: on an agent
// role, empty means "follow this setting" and cannot be resolved without it.
func (s Settings) Engine() session.Engine {
	return session.Engine{
		AgentType: session.ResolveAgentType(s.DefaultAgentType),
		Model:     s.DefaultModel,
		Effort:    s.DefaultEffort,
	}
}

// ResolveEngine decides the engine a new session is born with, given whatever
// preference its agent role expresses (the zero Engine when there is none, as
// for a session created by hand).
//
// The role wins wherever it has an opinion, and the global defaults fill the
// rest — but only while the session stays on the global agent. A role that
// names a different agent takes the global model and effort with it to nothing:
// those values were picked from another agent's lists and are not offered by
// this one, so applying them would either fail validation or, worse, name a
// model that happens to exist on both and was never chosen for this agent.
func (s Settings) ResolveEngine(role session.Engine) session.Engine {
	global := s.Engine()

	resolved := role
	if resolved.AgentType == "" {
		resolved.AgentType = global.AgentType
	}
	if resolved.AgentType != global.AgentType {
		return resolved
	}
	if resolved.Model == "" {
		resolved.Model = global.Model
	}
	if resolved.Effort == "" {
		resolved.Effort = global.Effort
	}
	return resolved
}

// ValidateWorktreeBaseDir checks a user-provided worktree base directory.
// Empty is valid and means "use the default" (`../<repo>-worktrees`).
//
// A configured value must be one of:
//   - absolute (`/...`, or `C:\...` / `\\host\share\...` on Windows)
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

	native := NormalizeWorktreeBaseDir(path)
	sep := string(filepath.Separator)

	if rest, ok := pathutil.TrimTildePrefix(native); ok {
		return validateWorktreeRelativeSegment(rest, false)
	}

	switch {
	case filepath.IsAbs(native):
		if filepath.Clean(native) != native {
			return errors.New("worktree base directory must be a clean path (no '..' or redundant separators)")
		}
		return nil
	case native == "." || native == ".." || strings.HasPrefix(native, "."+sep) || strings.HasPrefix(native, ".."+sep):
		return validateWorktreeRelativeSegment(strings.TrimPrefix(native, "."+sep), true)
	default:
		return errors.New("worktree base directory must be absolute or start with './', '../', or '~/'")
	}
}

// validateWorktreeRelativeSegment checks the relative remainder of a
// repo-relative or home-relative worktree base directory. It must be clean, and
// may only begin with `..` when allowParent is true (repo-relative paths).
//
// The remainder is rejected outright if it is anchored rather than relative
// (see pathutil.IsAnchored), since joining an anchored path to the repository
// or home directory does not keep it there.
func validateWorktreeRelativeSegment(rest string, allowParent bool) error {
	if rest == "" {
		return nil
	}
	sep := string(filepath.Separator)
	if pathutil.IsAnchored(rest) || filepath.Clean(rest) != rest {
		return errors.New("worktree base directory must be a clean relative path (no redundant separators or interior '..')")
	}
	if !allowParent && (rest == ".." || strings.HasPrefix(rest, ".."+sep)) {
		return errors.New("worktree base directory under '~' must not escape the home directory")
	}
	return nil
}
