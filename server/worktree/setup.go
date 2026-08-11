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

// RunSetupHook executes the worktree setup hook if it exists.
// The hook script receives environment variables:
//   - POCKODE_MAIN_DIR: path to main worktree
//   - POCKODE_WORKTREE_PATH: path to newly created worktree
//   - POCKODE_WORKTREE_NAME: name of the worktree
//
// Returns nil if no hook exists or if execution succeeds. A missing shell is
// also not an error: on Windows bash is optional, and refusing to create the
// worktree over it would make the whole feature unusable there. The skip is
// logged at warn level instead, since a silently unconfigured worktree is worse
// than a noisy one.
func RunSetupHook(dataDir, mainDir, worktreePath, worktreeName string) error {
	hookPath := filepath.Join(dataDir, setupHookFilename)

	if _, err := os.Stat(hookPath); os.IsNotExist(err) {
		return nil
	} else if err != nil {
		return err
	}

	shell, err := hookShell()
	if err != nil {
		// The remediation for the missing shell itself belongs to the platform
		// that knows which shell it looked for; only the hook-side way out is
		// stated here.
		slog.Warn("worktree setup hook skipped: no shell available to run it",
			"name", worktreeName,
			"hook", hookPath,
			"reason", err,
			"hint", "delete the hook file to stop Pockode from trying to run it",
		)
		return nil
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
			return fmt.Errorf("%w: %s", err, outputStr)
		}
		return err
	}

	slog.Info("worktree setup hook completed", "name", worktreeName)
	return nil
}
