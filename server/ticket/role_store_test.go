package ticket

import (
	"context"
	"testing"
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
