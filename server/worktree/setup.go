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

// RunSetupHook executes the worktree setup hook if it exists.
// The hook script receives environment variables:
//   - POCKODE_MAIN_DIR: path to main worktree
//   - POCKODE_WORKTREE_PATH: path to newly created worktree
//   - POCKODE_WORKTREE_NAME: name of the worktree
//
// Returns nil if no hook exists or if execution succeeds.
func RunSetupHook(dataDir, mainDir, worktreePath, worktreeName string) error {
	hookPath := filepath.Join(dataDir, setupHookFilename)

	if _, err := os.Stat(hookPath); os.IsNotExist(err) {
		return nil
	} else if err != nil {
		return err
	}

	cmd := exec.Command("bash", hookPath)
	cmd.Dir = worktreePath
	cmd.Env = append(os.Environ(),
		"POCKODE_MAIN_DIR="+mainDir,
		"POCKODE_WORKTREE_PATH="+worktreePath,
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
			return fmt.Errorf("%s: %s", err, outputStr)
		}
		return err
	}

	slog.Info("worktree setup hook completed", "name", worktreeName)
	return nil
}
