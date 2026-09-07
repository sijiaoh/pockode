package session

import (
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"

	"github.com/pockode/server/filestore"
)

// ClearOrphanedNeedsInput resets NeedsInput to false for all sessions
// in the main data directory and all worktree subdirectories.
// Call at server startup before any session stores are created,
// since no agent processes survive a restart.
func ClearOrphanedNeedsInput(dataDir string) {
	// Main sessions
	clearNeedsInputInIndex(filepath.Join(dataDir, "sessions", "index.json"))

	// Worktree sessions
	worktreesDir := filepath.Join(dataDir, "worktrees")
	entries, err := os.ReadDir(worktreesDir)
	if err != nil {
		return // No worktrees directory is normal
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		clearNeedsInputInIndex(filepath.Join(worktreesDir, entry.Name(), "sessions", "index.json"))
	}
}

func clearNeedsInputInIndex(path string) {
	data, err := filestore.ReadFileLocked(path)
	if err != nil {
		slog.Warn("failed to read session index for cleanup", "path", path, "error", err)
		return
	}
	if data == nil {
		return // File doesn't exist
	}

	var idx indexData
	if err := json.Unmarshal(data, &idx); err != nil {
		slog.Warn("failed to parse session index for cleanup", "path", path, "error", err)
		return
	}

	changed := false
	for i := range idx.Sessions {
		if idx.Sessions[i].NeedsInput {
			idx.Sessions[i].NeedsInput = false
			changed = true
		}
	}
	if !changed {
		return
	}

	out, err := filestore.MarshalIndex(idx)
	if err != nil {
		slog.Warn("failed to marshal session index for cleanup", "path", path, "error", err)
		return
	}
	if err := filestore.WriteFileAtomic(path, out, 0644); err != nil {
		slog.Warn("failed to write session index for cleanup", "path", path, "error", err)
		return
	}

	slog.Info("cleared orphaned NeedsInput flags", "path", path)
}
