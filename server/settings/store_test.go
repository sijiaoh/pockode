package settings

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
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

	if err := os.WriteFile(path, []byte(`{}`), 0644); err != nil {
		t.Fatalf("WriteFile failed: %v", err)
	}

	store, err := NewStore(dir)
	if err != nil {
		t.Fatalf("NewStore failed: %v", err)
	}

	got := store.Get()
	want := Settings{}
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

	newSettings := Settings{DefaultAgentRoleID: "role-123"}
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
	store1.Update(Settings{DefaultAgentRoleID: "role-456"})

	// Create new store from same directory
	store2, _ := NewStore(dir)
	got := store2.Get()
	want := Settings{DefaultAgentRoleID: "role-456"}
	if got != want {
		t.Errorf("expected persisted settings %+v, got %+v", want, got)
	}
}

func TestStore_ExternalChange_NotifiesListener(t *testing.T) {
	dir := t.TempDir()
	store, err := NewStore(dir)
	if err != nil {
		t.Fatalf("NewStore failed: %v", err)
	}

	var mu sync.Mutex
	var received Settings
	var called bool
	store.SetOnChangeListener(listenerFunc(func(s Settings) {
		mu.Lock()
		defer mu.Unlock()
		received = s
		called = true
	}))

	if err := store.StartWatching(); err != nil {
		t.Fatalf("StartWatching failed: %v", err)
	}
	defer store.StopWatching()

	// Simulate external write (another process modifying the file)
	path := filepath.Join(dir, "settings.json")
	if err := os.WriteFile(path, []byte(`{"default_agent_role_id":"ext-role"}`), 0644); err != nil {
		t.Fatalf("WriteFile failed: %v", err)
	}

	// Wait for fsnotify debounce (100ms) + processing time
	time.Sleep(300 * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()

	if !called {
		t.Fatal("expected listener to be called on external change")
	}
	if received.DefaultAgentRoleID != "ext-role" {
		t.Errorf("expected DefaultAgentRoleID=ext-role, got %q", received.DefaultAgentRoleID)
	}

	got := store.Get()
	if got.DefaultAgentRoleID != "ext-role" {
		t.Errorf("expected in-memory DefaultAgentRoleID=ext-role, got %q", got.DefaultAgentRoleID)
	}
}

// listenerFunc adapts a function to OnChangeListener.
type listenerFunc func(Settings)

func (f listenerFunc) OnSettingsChange(s Settings) { f(s) }
