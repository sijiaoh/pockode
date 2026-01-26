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
	if got.Sandbox != SandboxModeHost {
		t.Errorf("expected default sandbox mode %q, got %q", SandboxModeHost, got.Sandbox)
	}
}

func TestNewStore_LoadsExistingFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "settings.json")

	if err := os.WriteFile(path, []byte(`{"sandbox":"always"}`), 0644); err != nil {
		t.Fatalf("WriteFile failed: %v", err)
	}

	store, err := NewStore(dir)
	if err != nil {
		t.Fatalf("NewStore failed: %v", err)
	}

	got := store.Get()
	if got.Sandbox != SandboxModeAlways {
		t.Errorf("expected sandbox mode %q, got %q", SandboxModeAlways, got.Sandbox)
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
	if got.Sandbox != SandboxModeHost {
		t.Errorf("expected default sandbox mode %q, got %q", SandboxModeHost, got.Sandbox)
	}
}

func TestNewStore_FallsBackOnInvalidValue(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "settings.json")

	if err := os.WriteFile(path, []byte(`{"sandbox":"invalid_mode"}`), 0644); err != nil {
		t.Fatalf("WriteFile failed: %v", err)
	}

	store, err := NewStore(dir)
	if err != nil {
		t.Fatalf("NewStore failed: %v", err)
	}

	got := store.Get()
	if got.Sandbox != SandboxModeHost {
		t.Errorf("expected default sandbox mode %q, got %q", SandboxModeHost, got.Sandbox)
	}
}

func TestStore_Update(t *testing.T) {
	store, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewStore failed: %v", err)
	}

	newSettings := Settings{Sandbox: SandboxModeYoloOnly}
	if err := store.Update(newSettings); err != nil {
		t.Fatalf("Update failed: %v", err)
	}

	got := store.Get()
	if got.Sandbox != SandboxModeYoloOnly {
		t.Errorf("expected sandbox mode %q, got %q", SandboxModeYoloOnly, got.Sandbox)
	}
}

func TestStore_Update_RejectsInvalidValue(t *testing.T) {
	store, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewStore failed: %v", err)
	}

	invalidSettings := Settings{Sandbox: "invalid"}
	if err := store.Update(invalidSettings); err == nil {
		t.Error("expected error for invalid sandbox mode")
	}

	// Should retain original value
	got := store.Get()
	if got.Sandbox != SandboxModeHost {
		t.Errorf("expected sandbox mode %q, got %q", SandboxModeHost, got.Sandbox)
	}
}

func TestStore_Update_PersistsToDisk(t *testing.T) {
	dir := t.TempDir()

	store1, _ := NewStore(dir)
	store1.Update(Settings{Sandbox: SandboxModeAlways})

	// Create new store from same directory
	store2, _ := NewStore(dir)
	got := store2.Get()
	if got.Sandbox != SandboxModeAlways {
		t.Errorf("expected persisted sandbox mode %q, got %q", SandboxModeAlways, got.Sandbox)
	}
}

func TestSandboxMode_IsValid(t *testing.T) {
	tests := []struct {
		mode  SandboxMode
		valid bool
	}{
		{SandboxModeHost, true},
		{SandboxModeYoloOnly, true},
		{SandboxModeAlways, true},
		{"invalid", false},
		{"", false},
	}

	for _, tt := range tests {
		if got := tt.mode.IsValid(); got != tt.valid {
			t.Errorf("SandboxMode(%q).IsValid() = %v, want %v", tt.mode, got, tt.valid)
		}
	}
}
