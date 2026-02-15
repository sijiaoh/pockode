package ticket

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"
)

func TestFileRoleStore_DefaultRole(t *testing.T) {
	store, err := NewFileRoleStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewFileRoleStore: %v", err)
	}

	roles, err := store.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(roles) != 1 {
		t.Fatalf("got %d roles, want 1", len(roles))
	}
	if roles[0].ID != "default" {
		t.Errorf("got ID %q, want %q", roles[0].ID, "default")
	}
}

func TestFileRoleStore_CRUD(t *testing.T) {
	store, err := NewFileRoleStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewFileRoleStore: %v", err)
	}

	ctx := context.Background()

	t.Run("Create", func(t *testing.T) {
		role, err := store.Create(ctx, "Engineer", "You are a software engineer.")
		if err != nil {
			t.Fatalf("Create: %v", err)
		}
		if role.ID == "" {
			t.Error("expected non-empty ID")
		}
		if role.Name != "Engineer" {
			t.Errorf("got name %q, want %q", role.Name, "Engineer")
		}
	})

	t.Run("List", func(t *testing.T) {
		roles, err := store.List()
		if err != nil {
			t.Fatalf("List: %v", err)
		}
		if len(roles) != 2 { // default + created
			t.Errorf("got %d roles, want 2", len(roles))
		}
	})

	t.Run("Get", func(t *testing.T) {
		role, found, err := store.Get("default")
		if err != nil {
			t.Fatalf("Get: %v", err)
		}
		if !found {
			t.Error("expected role to be found")
		}
		if role.Name != "Default" {
			t.Errorf("got name %q, want %q", role.Name, "Default")
		}
	})

	t.Run("Get not found", func(t *testing.T) {
		_, found, err := store.Get("nonexistent")
		if err != nil {
			t.Fatalf("Get: %v", err)
		}
		if found {
			t.Error("expected role not to be found")
		}
	})

	t.Run("Update", func(t *testing.T) {
		updated, err := store.Update(ctx, "default", "Default Updated", "New prompt")
		if err != nil {
			t.Fatalf("Update: %v", err)
		}
		if updated.Name != "Default Updated" {
			t.Errorf("got name %q, want %q", updated.Name, "Default Updated")
		}
		if updated.SystemPrompt != "New prompt" {
			t.Errorf("got prompt %q, want %q", updated.SystemPrompt, "New prompt")
		}
	})

	t.Run("Update not found", func(t *testing.T) {
		_, err := store.Update(ctx, "nonexistent", "Name", "Prompt")
		if err != ErrRoleNotFound {
			t.Errorf("got error %v, want %v", err, ErrRoleNotFound)
		}
	})

	t.Run("Delete", func(t *testing.T) {
		roles, _ := store.List()
		initialCount := len(roles)

		// Find the non-default role to delete
		var toDelete string
		for _, r := range roles {
			if r.ID != "default" {
				toDelete = r.ID
				break
			}
		}

		err := store.Delete(ctx, toDelete)
		if err != nil {
			t.Fatalf("Delete: %v", err)
		}

		roles, _ = store.List()
		if len(roles) != initialCount-1 {
			t.Errorf("got %d roles, want %d", len(roles), initialCount-1)
		}
	})

	t.Run("Delete not found", func(t *testing.T) {
		err := store.Delete(ctx, "nonexistent")
		if err != ErrRoleNotFound {
			t.Errorf("got error %v, want %v", err, ErrRoleNotFound)
		}
	})
}

func TestFileRoleStore_Persistence(t *testing.T) {
	dataDir := t.TempDir()
	ctx := context.Background()

	store1, err := NewFileRoleStore(dataDir)
	if err != nil {
		t.Fatalf("NewFileRoleStore: %v", err)
	}

	_, err = store1.Create(ctx, "Persistent Role", "Prompt")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	store2, err := NewFileRoleStore(dataDir)
	if err != nil {
		t.Fatalf("NewFileRoleStore (reload): %v", err)
	}

	roles, err := store2.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(roles) != 2 { // default + created
		t.Errorf("got %d roles, want 2", len(roles))
	}

	var found bool
	for _, r := range roles {
		if r.Name == "Persistent Role" {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected persistent role to be found after reload")
	}
}

func TestFileRoleStore_ChangeListener(t *testing.T) {
	store, err := NewFileRoleStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewFileRoleStore: %v", err)
	}
	defer store.Stop()

	ctx := context.Background()
	var events []RoleChangeEvent
	store.SetOnChangeListener(roleListenerFunc(func(e RoleChangeEvent) {
		events = append(events, e)
	}))

	role, _ := store.Create(ctx, "Test Role", "Prompt")
	store.Update(ctx, role.ID, "Updated", "New Prompt")
	store.Delete(ctx, role.ID)

	if len(events) != 3 {
		t.Fatalf("got %d events, want 3", len(events))
	}
	if events[0].Op != OperationCreate {
		t.Errorf("event[0].Op = %v, want %v", events[0].Op, OperationCreate)
	}
	if events[1].Op != OperationUpdate {
		t.Errorf("event[1].Op = %v, want %v", events[1].Op, OperationUpdate)
	}
	if events[2].Op != OperationDelete {
		t.Errorf("event[2].Op = %v, want %v", events[2].Op, OperationDelete)
	}
}

type roleListenerFunc func(RoleChangeEvent)

func (f roleListenerFunc) OnRoleChange(e RoleChangeEvent) { f(e) }

func TestFileRoleStore_FileWatcher(t *testing.T) {
	dataDir := t.TempDir()

	store, err := NewFileRoleStore(dataDir)
	if err != nil {
		t.Fatalf("NewFileRoleStore: %v", err)
	}
	defer store.Stop()

	eventCh := make(chan RoleChangeEvent, 10)
	store.SetOnChangeListener(roleListenerFunc(func(e RoleChangeEvent) {
		eventCh <- e
	}))

	// Wait for self-write detection window to pass
	time.Sleep(250 * time.Millisecond)

	// Externally modify the file
	newRoles := []AgentRole{
		DefaultRole,
		{ID: "external-role", Name: "External", SystemPrompt: "Added externally"},
	}
	data, err := json.MarshalIndent(newRoles, "", "  ")
	if err != nil {
		t.Fatalf("json.MarshalIndent: %v", err)
	}
	if err := os.WriteFile(store.filePath(), data, 0644); err != nil {
		t.Fatalf("os.WriteFile: %v", err)
	}

	// Wait for debounce + processing (debounce is 100ms)
	select {
	case event := <-eventCh:
		if event.Op != OperationCreate {
			t.Errorf("expected create operation, got %v", event.Op)
		}
		if event.Role.ID != "external-role" {
			t.Errorf("expected role ID 'external-role', got %q", event.Role.ID)
		}
	case <-time.After(500 * time.Millisecond):
		t.Error("timed out waiting for file change event")
	}

	// Verify the store reflects the change
	roles, err := store.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(roles) != 2 {
		t.Errorf("got %d roles, want 2", len(roles))
	}
}

func TestFileRoleStore_PromptFile(t *testing.T) {
	dataDir := t.TempDir()
	ctx := context.Background()

	store, err := NewFileRoleStore(dataDir)
	if err != nil {
		t.Fatalf("NewFileRoleStore: %v", err)
	}
	defer store.Stop()

	t.Run("Create writes prompt file", func(t *testing.T) {
		role, err := store.Create(ctx, "Test Role", "You are a test assistant.")
		if err != nil {
			t.Fatalf("Create: %v", err)
		}

		promptPath := store.GetPromptFilePath(role.ID)
		content, err := os.ReadFile(promptPath)
		if err != nil {
			t.Fatalf("ReadFile: %v", err)
		}

		if string(content) != "You are a test assistant." {
			t.Errorf("got prompt %q, want %q", string(content), "You are a test assistant.")
		}
	})

	t.Run("Update writes prompt file", func(t *testing.T) {
		role, err := store.Create(ctx, "Update Test", "Original prompt")
		if err != nil {
			t.Fatalf("Create: %v", err)
		}

		_, err = store.Update(ctx, role.ID, "Update Test", "Updated prompt")
		if err != nil {
			t.Fatalf("Update: %v", err)
		}

		promptPath := store.GetPromptFilePath(role.ID)
		content, err := os.ReadFile(promptPath)
		if err != nil {
			t.Fatalf("ReadFile: %v", err)
		}

		if string(content) != "Updated prompt" {
			t.Errorf("got prompt %q, want %q", string(content), "Updated prompt")
		}
	})

	t.Run("Delete removes prompt file", func(t *testing.T) {
		role, err := store.Create(ctx, "Delete Test", "To be deleted")
		if err != nil {
			t.Fatalf("Create: %v", err)
		}

		promptPath := store.GetPromptFilePath(role.ID)

		// Verify file exists
		if _, err := os.Stat(promptPath); err != nil {
			t.Fatalf("prompt file should exist: %v", err)
		}

		// Delete role
		if err := store.Delete(ctx, role.ID); err != nil {
			t.Fatalf("Delete: %v", err)
		}

		// Verify file is removed
		if _, err := os.Stat(promptPath); !os.IsNotExist(err) {
			t.Errorf("prompt file should be deleted, got error: %v", err)
		}
	})

	t.Run("Default role prompt file exists after init", func(t *testing.T) {
		promptPath := store.GetPromptFilePath("default")
		content, err := os.ReadFile(promptPath)
		if err != nil {
			t.Fatalf("ReadFile: %v", err)
		}

		if string(content) != DefaultRole.SystemPrompt {
			t.Errorf("got prompt %q, want %q", string(content), DefaultRole.SystemPrompt)
		}
	})
}

func TestFileRoleStore_GetPromptFilePath(t *testing.T) {
	dataDir := "/tmp/test-data"
	store := &FileRoleStore{dataDir: dataDir}

	got := store.GetPromptFilePath("role-123")
	want := "/tmp/test-data/roles/role-123/prompt.md"

	if got != want {
		t.Errorf("GetPromptFilePath() = %q, want %q", got, want)
	}
}
