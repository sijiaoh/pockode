package settings

import (
	"os"
	"path/filepath"
	"testing"
)

func TestNewStore_DefaultsWhenNoFile(t *testing.T) {
	store, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewStore failed: %v", err)
	}

	got := store.Get()
	if got.Sandbox != false {
		t.Errorf("expected default sandbox false, got %v", got.Sandbox)
	}
}

func TestNewStore_LoadsExistingFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "settings.json")

	if err := os.WriteFile(path, []byte(`{"sandbox":true}`), 0644); err != nil {
		t.Fatalf("WriteFile failed: %v", err)
	}

	store, err := NewStore(dir)
	if err != nil {
		t.Fatalf("NewStore failed: %v", err)
	}

	got := store.Get()
	if got.Sandbox != true {
		t.Errorf("expected sandbox true, got %v", got.Sandbox)
	}
}

func TestNewStore_FallsBackOnCorruptedJSON(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "settings.json")

	if err := os.WriteFile(path, []byte(`{invalid json`), 0644); err != nil {
		t.Fatalf("WriteFile failed: %v", err)
	}

	store, err := NewStore(dir)
	if err != nil {
		t.Fatalf("NewStore failed: %v", err)
	}

	got := store.Get()
	if got.Sandbox != false {
		t.Errorf("expected default sandbox false, got %v", got.Sandbox)
	}
}

func TestStore_Update(t *testing.T) {
	store, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewStore failed: %v", err)
	}

	newSettings := Settings{Sandbox: true}
	if err := store.Update(newSettings); err != nil {
		t.Fatalf("Update failed: %v", err)
	}

	got := store.Get()
	if got.Sandbox != true {
		t.Errorf("expected sandbox true, got %v", got.Sandbox)
	}
}

func TestStore_Update_PersistsToDisk(t *testing.T) {
	dir := t.TempDir()

	store1, _ := NewStore(dir)
	store1.Update(Settings{Sandbox: true})

	// Create new store from same directory
	store2, _ := NewStore(dir)
	got := store2.Get()
	if got.Sandbox != true {
		t.Errorf("expected persisted sandbox true, got %v", got.Sandbox)
	}
}
