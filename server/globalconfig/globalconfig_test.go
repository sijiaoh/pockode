package globalconfig

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDir(t *testing.T) {
	// Create temp directory
	tmpDir := t.TempDir()

	// Reset any cached state
	ResetDir()

	// Set POCKODE_HOME to temp directory
	t.Setenv("POCKODE_HOME", tmpDir)

	dir, err := Dir()
	if err != nil {
		t.Fatalf("Dir() error: %v", err)
	}

	if dir != tmpDir {
		t.Errorf("Dir() = %q, want %q", dir, tmpDir)
	}

	// Verify directory was created
	info, err := os.Stat(dir)
	if err != nil {
		t.Fatalf("stat dir error: %v", err)
	}
	if !info.IsDir() {
		t.Errorf("Dir() path is not a directory")
	}
}

func TestConfigStore(t *testing.T) {
	tmpDir := t.TempDir()
	ResetDir()
	t.Setenv("POCKODE_HOME", tmpDir)

	store, err := NewConfigStore()
	if err != nil {
		t.Fatalf("NewConfigStore() error: %v", err)
	}

	// Get default config
	cfg := store.Get()
	if cfg.DefaultPort != 9870 {
		t.Errorf("DefaultPort = %d, want 9870", cfg.DefaultPort)
	}
	if cfg.CloudURL != "https://cloud.pockode.com" {
		t.Errorf("CloudURL = %q, want https://cloud.pockode.com", cfg.CloudURL)
	}

	// Update config
	cfg.AuthToken = "test-token"
	cfg.DefaultPort = 8080
	if err := store.Update(cfg); err != nil {
		t.Fatalf("Update() error: %v", err)
	}

	// Verify file permissions (should be 0600 for sensitive data)
	configPath := filepath.Join(tmpDir, configFileName)
	info, err := os.Stat(configPath)
	if err != nil {
		t.Fatalf("stat config error: %v", err)
	}
	perm := info.Mode().Perm()
	if perm != 0600 {
		t.Errorf("config file permissions = %o, want 0600", perm)
	}

	// Reload and verify
	ResetDir()
	store2, err := NewConfigStore()
	if err != nil {
		t.Fatalf("NewConfigStore() reload error: %v", err)
	}
	cfg2 := store2.Get()
	if cfg2.AuthToken != "test-token" {
		t.Errorf("AuthToken = %q, want test-token", cfg2.AuthToken)
	}
	if cfg2.DefaultPort != 8080 {
		t.Errorf("DefaultPort = %d, want 8080", cfg2.DefaultPort)
	}
}

func TestRelayStore(t *testing.T) {
	tmpDir := t.TempDir()
	ResetDir()
	t.Setenv("POCKODE_HOME", tmpDir)

	store, err := NewRelayStore()
	if err != nil {
		t.Fatalf("NewRelayStore() error: %v", err)
	}

	// Load empty
	creds, err := store.Load()
	if err != nil {
		t.Fatalf("Load() error: %v", err)
	}
	if creds != nil {
		t.Errorf("Load() = %v, want nil", creds)
	}

	// Save credentials
	creds = &RelayCredentials{
		Subdomain:   "test-subdomain",
		RelayToken:  "test-relay-token",
		RelayServer: "https://relay.test.com",
	}
	if err := store.Save(creds); err != nil {
		t.Fatalf("Save() error: %v", err)
	}

	// Verify file permissions
	relayPath := filepath.Join(tmpDir, relayFileName)
	info, err := os.Stat(relayPath)
	if err != nil {
		t.Fatalf("stat relay error: %v", err)
	}
	perm := info.Mode().Perm()
	if perm != 0600 {
		t.Errorf("relay file permissions = %o, want 0600", perm)
	}

	// Load and verify
	loaded, err := store.Load()
	if err != nil {
		t.Fatalf("Load() error: %v", err)
	}
	if loaded.Subdomain != "test-subdomain" {
		t.Errorf("Subdomain = %q, want test-subdomain", loaded.Subdomain)
	}
	if !loaded.IsValid() {
		t.Error("IsValid() = false, want true")
	}

	// Delete
	if err := store.Delete(); err != nil {
		t.Fatalf("Delete() error: %v", err)
	}
	deleted, err := store.Load()
	if err != nil {
		t.Fatalf("Load() after delete error: %v", err)
	}
	if deleted != nil {
		t.Errorf("Load() after delete = %v, want nil", deleted)
	}
}

func TestWorkspaceStore(t *testing.T) {
	tmpDir := t.TempDir()
	ResetDir()
	t.Setenv("POCKODE_HOME", tmpDir)

	store, err := NewWorkspaceStore()
	if err != nil {
		t.Fatalf("NewWorkspaceStore() error: %v", err)
	}

	// List empty
	workspaces, err := store.List()
	if err != nil {
		t.Fatalf("List() error: %v", err)
	}
	if len(workspaces) != 0 {
		t.Errorf("List() len = %d, want 0", len(workspaces))
	}

	// Register workspace
	ws1, err := store.Register("/path/to/project1", "Project 1")
	if err != nil {
		t.Fatalf("Register() error: %v", err)
	}
	if ws1.ID == "" {
		t.Error("workspace ID is empty")
	}
	if ws1.Name != "Project 1" {
		t.Errorf("Name = %q, want Project 1", ws1.Name)
	}

	// Register with default name
	ws2, err := store.Register("/path/to/my-project", "")
	if err != nil {
		t.Fatalf("Register() error: %v", err)
	}
	if ws2.Name != "my-project" {
		t.Errorf("Name = %q, want my-project", ws2.Name)
	}

	// List should have 2
	workspaces, err = store.List()
	if err != nil {
		t.Fatalf("List() error: %v", err)
	}
	if len(workspaces) != 2 {
		t.Errorf("List() len = %d, want 2", len(workspaces))
	}

	// Get by ID
	found, err := store.Get(ws1.ID)
	if err != nil {
		t.Fatalf("Get() error: %v", err)
	}
	if found == nil {
		t.Fatal("Get() = nil, want workspace")
	}
	if found.Name != "Project 1" {
		t.Errorf("Name = %q, want Project 1", found.Name)
	}

	// Get non-existent ID returns nil
	notFound, err := store.Get("non-existent-id")
	if err != nil {
		t.Fatalf("Get() error: %v", err)
	}
	if notFound != nil {
		t.Errorf("Get(non-existent) = %v, want nil", notFound)
	}

	// Get by path
	foundByPath, err := store.GetByPath("/path/to/project1")
	if err != nil {
		t.Fatalf("GetByPath() error: %v", err)
	}
	if foundByPath == nil {
		t.Fatal("GetByPath() = nil, want workspace")
	}
	if foundByPath.ID != ws1.ID {
		t.Errorf("ID = %q, want %q", foundByPath.ID, ws1.ID)
	}

	// GetByPath non-existent returns nil
	notFoundByPath, err := store.GetByPath("/non/existent/path")
	if err != nil {
		t.Fatalf("GetByPath() error: %v", err)
	}
	if notFoundByPath != nil {
		t.Errorf("GetByPath(non-existent) = %v, want nil", notFoundByPath)
	}

	// Re-register same path updates existing
	ws1Updated, err := store.Register("/path/to/project1", "Project 1 Updated")
	if err != nil {
		t.Fatalf("Register() update error: %v", err)
	}
	if ws1Updated.ID != ws1.ID {
		t.Errorf("updated ID = %q, want %q", ws1Updated.ID, ws1.ID)
	}
	if ws1Updated.Name != "Project 1 Updated" {
		t.Errorf("updated Name = %q, want Project 1 Updated", ws1Updated.Name)
	}

	// Still only 2 workspaces
	workspaces, err = store.List()
	if err != nil {
		t.Fatalf("List() error: %v", err)
	}
	if len(workspaces) != 2 {
		t.Errorf("List() len = %d, want 2", len(workspaces))
	}

	// UpdateLastAccessed
	if err := store.UpdateLastAccessed(ws2.ID); err != nil {
		t.Fatalf("UpdateLastAccessed() error: %v", err)
	}

	// Delete
	if err := store.Delete(ws1.ID); err != nil {
		t.Fatalf("Delete() error: %v", err)
	}
	workspaces, err = store.List()
	if err != nil {
		t.Fatalf("List() error: %v", err)
	}
	if len(workspaces) != 1 {
		t.Errorf("List() len = %d, want 1", len(workspaces))
	}

	// Delete non-existent ID is no-op
	if err := store.Delete("non-existent-id"); err != nil {
		t.Fatalf("Delete(non-existent) error: %v", err)
	}
}

func TestCorruptedJSON(t *testing.T) {
	tmpDir := t.TempDir()
	ResetDir()
	t.Setenv("POCKODE_HOME", tmpDir)

	// Write corrupted config.json
	configPath := filepath.Join(tmpDir, configFileName)
	if err := os.WriteFile(configPath, []byte("{invalid json"), 0600); err != nil {
		t.Fatalf("write corrupted config: %v", err)
	}

	// Should fall back to defaults
	store, err := NewConfigStore()
	if err != nil {
		t.Fatalf("NewConfigStore() error: %v", err)
	}
	cfg := store.Get()
	if cfg.DefaultPort != 9870 {
		t.Errorf("DefaultPort = %d, want 9870 (default)", cfg.DefaultPort)
	}

	// Write corrupted workspaces.json
	wsPath := filepath.Join(tmpDir, workspacesFileName)
	if err := os.WriteFile(wsPath, []byte("{invalid json"), 0644); err != nil {
		t.Fatalf("write corrupted workspaces: %v", err)
	}

	// Should return empty list
	wsStore, err := NewWorkspaceStore()
	if err != nil {
		t.Fatalf("NewWorkspaceStore() error: %v", err)
	}
	workspaces, err := wsStore.List()
	if err != nil {
		t.Fatalf("List() error: %v", err)
	}
	if len(workspaces) != 0 {
		t.Errorf("List() len = %d, want 0 (empty for corrupted)", len(workspaces))
	}

	// Write corrupted relay.json
	relayPath := filepath.Join(tmpDir, relayFileName)
	if err := os.WriteFile(relayPath, []byte("{invalid json"), 0600); err != nil {
		t.Fatalf("write corrupted relay: %v", err)
	}

	// Should return nil
	relayStore, err := NewRelayStore()
	if err != nil {
		t.Fatalf("NewRelayStore() error: %v", err)
	}
	creds, err := relayStore.Load()
	if err != nil {
		t.Fatalf("Load() error: %v", err)
	}
	if creds != nil {
		t.Errorf("Load() = %v, want nil (for corrupted)", creds)
	}
}

func TestRelayCredentialsIsValid(t *testing.T) {
	tests := []struct {
		name  string
		creds RelayCredentials
		want  bool
	}{
		{"all fields set", RelayCredentials{"sub", "token", "server"}, true},
		{"missing subdomain", RelayCredentials{"", "token", "server"}, false},
		{"missing token", RelayCredentials{"sub", "", "server"}, false},
		{"missing server", RelayCredentials{"sub", "token", ""}, false},
		{"all empty", RelayCredentials{}, false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.creds.IsValid(); got != tt.want {
				t.Errorf("IsValid() = %v, want %v", got, tt.want)
			}
		})
	}
}
