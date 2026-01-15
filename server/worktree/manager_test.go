package worktree

import (
	"os"
	"path/filepath"
	"testing"
)

func TestForceShutdown_RemovesDataDirectory(t *testing.T) {
	dataDir := t.TempDir()
	worktreesDir := filepath.Join(dataDir, "worktrees")
	wtDataDir := filepath.Join(worktreesDir, "feature-1")

	// Create the data directory structure
	if err := os.MkdirAll(filepath.Join(wtDataDir, "sessions"), 0755); err != nil {
		t.Fatalf("failed to create test directory: %v", err)
	}

	// Create a test file inside
	testFile := filepath.Join(wtDataDir, "sessions", "test.json")
	if err := os.WriteFile(testFile, []byte("{}"), 0644); err != nil {
		t.Fatalf("failed to create test file: %v", err)
	}

	m := &Manager{
		dataDir:   dataDir,
		worktrees: make(map[string]*Worktree),
	}

	m.ForceShutdown("feature-1")

	// Verify the data directory is removed
	if _, err := os.Stat(wtDataDir); !os.IsNotExist(err) {
		t.Errorf("worktree data directory still exists after ForceShutdown")
	}

	// Verify the parent worktrees directory still exists
	if _, err := os.Stat(worktreesDir); os.IsNotExist(err) {
		t.Errorf("parent worktrees directory was unexpectedly removed")
	}
}
