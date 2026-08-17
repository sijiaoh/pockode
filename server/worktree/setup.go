package worktree

import (
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const setupHookFilename = "worktree-setup.sh"

const defaultSetupHookContent = `#!/bin/bash
set -eu

# Worktree setup hook for Pockode
# Runs automatically when creating a new worktree.
#
# Environment variables:
#   $POCKODE_MAIN_DIR      - Path to main worktree
#   $POCKODE_WORKTREE_PATH - Path to newly created worktree (= cwd)
#   $POCKODE_WORKTREE_NAME - Name of the worktree

# Symlink Claude Code local settings (share permissions across worktrees)
# if [ -f "$POCKODE_MAIN_DIR/.claude/settings.local.json" ]; then
#     mkdir -p .claude
#     ln -s "$POCKODE_MAIN_DIR/.claude/settings.local.json" .claude/settings.local.json
# fi

# Install npm dependencies
# if [ -f package.json ]; then
#     npm install
# fi
`

// InitSetupHook creates the default setup hook file if it doesn't exist.
func InitSetupHook(dataDir string) error {
	hookPath := filepath.Join(dataDir, setupHookFilename)

	if _, err := os.Stat(hookPath); err == nil {
		return nil // Already exists
	} else if !os.IsNotExist(err) {
		return err
	}

	if err := os.MkdirAll(dataDir, 0755); err != nil {
		return err
	}

	return os.WriteFile(hookPath, []byte(defaultSetupHookContent), 0644)
}

// hookShell resolves the interpreter for the setup hook. It is a variable so
// tests can exercise the "no shell available" path on any platform.
var hookShell = lookupHookShell

// SetupHookSkip explains why the setup hook does not run. It exists so the skip
// can travel back to the client instead of living only in the server log: a
// worktree whose setup never ran looks exactly like a prepared one, and Pockode
// users are on a phone, nowhere near that log.
type SetupHookSkip struct {
	// Reason is what stops the hook from running. The platform that looked for
	// the shell owns this wording, including how to make it runnable — it is the
	// only layer that knows which interpreter it wanted.
	Reason string
	// Hint is the hook-side way out, for users who do not want it to run at all.
	Hint string
}

func newSetupHookSkip(err error) *SetupHookSkip {
	return &SetupHookSkip{
		Reason: err.Error(),
		Hint:   "delete " + setupHookFilename + " from the data directory to stop Pockode from trying to run it",
	}
}

// CheckSetupHook reports why the setup hook would be skipped on the next
// worktree creation, or nil if it would run. It answers the same question
// RunSetupHook answers after the fact, so the UI can warn before the user
// creates a worktree that will silently miss its setup step.
func CheckSetupHook(dataDir string) *SetupHookSkip {
	if _, err := os.Stat(filepath.Join(dataDir, setupHookFilename)); err != nil {
		// No hook means nothing is being skipped. A stat error other than
		// not-exist is left for RunSetupHook, which can fail loudly.
		return nil
	}
	if _, err := hookShell(); err != nil {
		return newSetupHookSkip(err)
	}
	return nil
}

// RunSetupHook executes the worktree setup hook if it exists.
// The hook script receives environment variables:
//   - POCKODE_MAIN_DIR: path to main worktree
//   - POCKODE_WORKTREE_PATH: path to newly created worktree
//   - POCKODE_WORKTREE_NAME: name of the worktree
//
// Returns a non-nil SetupHookSkip when the hook existed but could not be run.
// That is not an error: on Windows bash is optional, and refusing to create the
// worktree over it would make the whole feature unusable there. The caller is
// expected to pass the skip on to the user rather than drop it.
func RunSetupHook(dataDir, mainDir, worktreePath, worktreeName string) (*SetupHookSkip, error) {
	hookPath := filepath.Join(dataDir, setupHookFilename)

	if _, err := os.Stat(hookPath); os.IsNotExist(err) {
		return nil, nil
	} else if err != nil {
		return nil, err
	}

	shell, err := hookShell()
	if err != nil {
		skip := newSetupHookSkip(err)
		slog.Warn("worktree setup hook skipped: no shell available to run it",
			"name", worktreeName,
			"hook", hookPath,
			"reason", skip.Reason,
			"hint", skip.Hint,
		)
		return skip, nil
	}

	// Paths are handed to the hook with forward slashes: the hook is a bash
	// script, and on Windows a backslash in a shell variable is an escape
	// character. Git for Windows accepts `C:/...` everywhere it accepts `C:\...`.
	cmd := exec.Command(shell, filepath.ToSlash(hookPath))
	cmd.Dir = worktreePath
	cmd.Env = append(os.Environ(),
		"POCKODE_MAIN_DIR="+filepath.ToSlash(mainDir),
		"POCKODE_WORKTREE_PATH="+filepath.ToSlash(worktreePath),
		"POCKODE_WORKTREE_NAME="+worktreeName,
	)

	output, err := cmd.CombinedOutput()
	if err != nil {
		outputStr := strings.TrimSpace(string(output))
		slog.Warn("worktree setup hook failed",
			"name", worktreeName,
			"error", err,
			"output", outputStr,
		)
		if outputStr != "" {
			return nil, fmt.Errorf("%w: %s", err, outputStr)
		}
		return nil, err
	}

	slog.Info("worktree setup hook completed", "name", worktreeName)
	return nil, nil
}
