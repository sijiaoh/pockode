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
	want := Default()
	if got != want {
		t.Errorf("expected default settings %+v, got %+v", want, got)
	}
}

func TestNewStore_LoadsExistingFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "settings.json")

	if err := os.WriteFile(path, []byte(`{"autorun": true}`), 0644); err != nil {
		t.Fatalf("WriteFile failed: %v", err)
	}

	store, err := NewStore(dir)
	if err != nil {
		t.Fatalf("NewStore failed: %v", err)
	}

	got := store.Get()
	want := Settings{Autorun: true}
	if got != want {
		t.Errorf("expected settings %+v, got %+v", want, got)
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
	want := Default()
	if got != want {
		t.Errorf("expected default settings %+v, got %+v", want, got)
	}
}

func TestStore_Update(t *testing.T) {
	store, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewStore failed: %v", err)
	}

	newSettings := Settings{Autorun: true}
	if err := store.Update(newSettings); err != nil {
		t.Fatalf("Update failed: %v", err)
	}

	got := store.Get()
	if got != newSettings {
		t.Errorf("expected settings %+v, got %+v", newSettings, got)
	}
}

func TestStore_Update_PersistsToDisk(t *testing.T) {
	dir := t.TempDir()

	store1, _ := NewStore(dir)
	store1.Update(Settings{Autorun: true})

	// Create new store from same directory
	store2, _ := NewStore(dir)
	got := store2.Get()
	want := Settings{Autorun: true}
	if got != want {
		t.Errorf("expected persisted settings %+v, got %+v", want, got)
	}
}
