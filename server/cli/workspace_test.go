package cli

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/pockode/server/globalconfig"
)

func TestWorkspaceAdd(t *testing.T) {
	// Use temp directory for testing
	tempDir := t.TempDir()
	t.Setenv("POCKODE_HOME", tempDir)
	globalconfig.ResetDir()

	// Create a test workspace directory
	wsDir := filepath.Join(tempDir, "test-workspace")
	if err := os.MkdirAll(wsDir, 0755); err != nil {
		t.Fatalf("failed to create test workspace dir: %v", err)
	}

	// Run workspace add
	err := runWorkspaceAdd([]string{wsDir})
	if err != nil {
		t.Fatalf("workspace add failed: %v", err)
	}

	// Verify workspace was added
	store, err := globalconfig.NewWorkspaceStore()
	if err != nil {
		t.Fatalf("failed to create workspace store: %v", err)
	}

	workspaces, err := store.List()
	if err != nil {
		t.Fatalf("failed to list workspaces: %v", err)
	}

	if len(workspaces) != 1 {
		t.Fatalf("expected 1 workspace, got %d", len(workspaces))
	}

	ws := workspaces[0]
	if ws.Path != wsDir {
		t.Errorf("expected path %s, got %s", wsDir, ws.Path)
	}
	if ws.Name != "test-workspace" {
		t.Errorf("expected name 'test-workspace', got %s", ws.Name)
	}
}

func TestWorkspaceAdd_WithName(t *testing.T) {
	tempDir := t.TempDir()
	t.Setenv("POCKODE_HOME", tempDir)
	globalconfig.ResetDir()

	wsDir := filepath.Join(tempDir, "myproject")
	if err := os.MkdirAll(wsDir, 0755); err != nil {
		t.Fatalf("failed to create test workspace dir: %v", err)
	}

	err := runWorkspaceAdd([]string{"--name", "My Project", wsDir})
	if err != nil {
		t.Fatalf("workspace add failed: %v", err)
	}

	store, err := globalconfig.NewWorkspaceStore()
	if err != nil {
		t.Fatalf("failed to create workspace store: %v", err)
	}

	workspaces, err := store.List()
	if err != nil {
		t.Fatalf("failed to list workspaces: %v", err)
	}

	if len(workspaces) != 1 {
		t.Fatalf("expected 1 workspace, got %d", len(workspaces))
	}

	if workspaces[0].Name != "My Project" {
		t.Errorf("expected name 'My Project', got %s", workspaces[0].Name)
	}
}

func TestWorkspaceAdd_NonExistentPath(t *testing.T) {
	tempDir := t.TempDir()
	t.Setenv("POCKODE_HOME", tempDir)
	globalconfig.ResetDir()

	err := runWorkspaceAdd([]string{"/nonexistent/path"})
	if err == nil {
		t.Error("expected error for non-existent path")
	}
}

func TestWorkspaceAdd_FileNotDirectory(t *testing.T) {
	tempDir := t.TempDir()
	t.Setenv("POCKODE_HOME", tempDir)
	globalconfig.ResetDir()

	// Create a file instead of directory
	filePath := filepath.Join(tempDir, "afile.txt")
	if err := os.WriteFile(filePath, []byte("test"), 0644); err != nil {
		t.Fatalf("failed to create test file: %v", err)
	}

	err := runWorkspaceAdd([]string{filePath})
	if err == nil {
		t.Error("expected error for file path")
	}
}

func TestWorkspaceList_Empty(t *testing.T) {
	tempDir := t.TempDir()
	t.Setenv("POCKODE_HOME", tempDir)
	globalconfig.ResetDir()

	// Should not error even when empty
	err := runWorkspaceList([]string{})
	if err != nil {
		t.Fatalf("workspace list failed: %v", err)
	}
}

func TestWorkspaceList_WithWorkspaces(t *testing.T) {
	tempDir := t.TempDir()
	t.Setenv("POCKODE_HOME", tempDir)
	globalconfig.ResetDir()

	// Add a workspace
	wsDir := filepath.Join(tempDir, "test-ws")
	if err := os.MkdirAll(wsDir, 0755); err != nil {
		t.Fatalf("failed to create test workspace dir: %v", err)
	}
	if err := runWorkspaceAdd([]string{wsDir}); err != nil {
		t.Fatalf("workspace add failed: %v", err)
	}

	// List should work
	err := runWorkspaceList([]string{})
	if err != nil {
		t.Fatalf("workspace list failed: %v", err)
	}
}

func TestWorkspaceRemove(t *testing.T) {
	tempDir := t.TempDir()
	t.Setenv("POCKODE_HOME", tempDir)
	globalconfig.ResetDir()

	// Add a workspace
	wsDir := filepath.Join(tempDir, "to-remove")
	if err := os.MkdirAll(wsDir, 0755); err != nil {
		t.Fatalf("failed to create test workspace dir: %v", err)
	}
	if err := runWorkspaceAdd([]string{wsDir}); err != nil {
		t.Fatalf("workspace add failed: %v", err)
	}

	// Remove by path
	err := runWorkspaceRemove([]string{wsDir})
	if err != nil {
		t.Fatalf("workspace remove failed: %v", err)
	}

	// Verify removed
	store, err := globalconfig.NewWorkspaceStore()
	if err != nil {
		t.Fatalf("failed to create workspace store: %v", err)
	}

	workspaces, err := store.List()
	if err != nil {
		t.Fatalf("failed to list workspaces: %v", err)
	}

	if len(workspaces) != 0 {
		t.Errorf("expected 0 workspaces, got %d", len(workspaces))
	}
}

func TestWorkspaceRemove_ById(t *testing.T) {
	tempDir := t.TempDir()
	t.Setenv("POCKODE_HOME", tempDir)
	globalconfig.ResetDir()

	wsDir := filepath.Join(tempDir, "to-remove-by-id")
	if err := os.MkdirAll(wsDir, 0755); err != nil {
		t.Fatalf("failed to create test workspace dir: %v", err)
	}
	if err := runWorkspaceAdd([]string{wsDir}); err != nil {
		t.Fatalf("workspace add failed: %v", err)
	}

	// Get the workspace ID
	store, err := globalconfig.NewWorkspaceStore()
	if err != nil {
		t.Fatalf("failed to create workspace store: %v", err)
	}
	workspaces, err := store.List()
	if err != nil {
		t.Fatalf("failed to list workspaces: %v", err)
	}
	wsID := workspaces[0].ID

	// Remove by ID
	err = runWorkspaceRemove([]string{wsID})
	if err != nil {
		t.Fatalf("workspace remove by ID failed: %v", err)
	}

	// Verify removed
	workspaces, err = store.List()
	if err != nil {
		t.Fatalf("failed to list workspaces: %v", err)
	}

	if len(workspaces) != 0 {
		t.Errorf("expected 0 workspaces, got %d", len(workspaces))
	}
}

func TestWorkspaceRemove_NotFound(t *testing.T) {
	tempDir := t.TempDir()
	t.Setenv("POCKODE_HOME", tempDir)
	globalconfig.ResetDir()

	err := runWorkspaceRemove([]string{"nonexistent"})
	if err == nil {
		t.Error("expected error for non-existent workspace")
	}
}

func TestWorkspaceRemove_NoArgs(t *testing.T) {
	tempDir := t.TempDir()
	t.Setenv("POCKODE_HOME", tempDir)
	globalconfig.ResetDir()

	err := runWorkspaceRemove([]string{})
	if err == nil {
		t.Error("expected error when no args provided")
	}
}

func TestWorkspaceList_QuietMode(t *testing.T) {
	tempDir := t.TempDir()
	t.Setenv("POCKODE_HOME", tempDir)
	globalconfig.ResetDir()

	wsDir := filepath.Join(tempDir, "quiet-test")
	if err := os.MkdirAll(wsDir, 0755); err != nil {
		t.Fatalf("failed to create test workspace dir: %v", err)
	}
	if err := runWorkspaceAdd([]string{wsDir}); err != nil {
		t.Fatalf("workspace add failed: %v", err)
	}

	// -q should not error
	err := runWorkspaceList([]string{"-q"})
	if err != nil {
		t.Fatalf("workspace list -q failed: %v", err)
	}
}

func TestWorkspaceAdd_DuplicatePath(t *testing.T) {
	tempDir := t.TempDir()
	t.Setenv("POCKODE_HOME", tempDir)
	globalconfig.ResetDir()

	wsDir := filepath.Join(tempDir, "duplicate-test")
	if err := os.MkdirAll(wsDir, 0755); err != nil {
		t.Fatalf("failed to create test workspace dir: %v", err)
	}

	// Add first time
	if err := runWorkspaceAdd([]string{wsDir}); err != nil {
		t.Fatalf("first workspace add failed: %v", err)
	}

	// Add second time with different name (should update, not create new)
	if err := runWorkspaceAdd([]string{"--name", "Updated Name", wsDir}); err != nil {
		t.Fatalf("second workspace add failed: %v", err)
	}

	store, err := globalconfig.NewWorkspaceStore()
	if err != nil {
		t.Fatalf("failed to create workspace store: %v", err)
	}

	workspaces, err := store.List()
	if err != nil {
		t.Fatalf("failed to list workspaces: %v", err)
	}

	// Should still be only 1 workspace (updated, not duplicated)
	if len(workspaces) != 1 {
		t.Errorf("expected 1 workspace (updated), got %d", len(workspaces))
	}

	if workspaces[0].Name != "Updated Name" {
		t.Errorf("expected name 'Updated Name', got %s", workspaces[0].Name)
	}
}
