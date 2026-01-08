package command

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestList_EmptyStore(t *testing.T) {
	dir := t.TempDir()
	store, err := NewStore(dir)
	if err != nil {
		t.Fatal(err)
	}

	commands := store.List()

	if len(commands) != len(BuiltinCommands) {
		t.Errorf("expected %d commands, got %d", len(BuiltinCommands), len(commands))
	}

	for i, cmd := range commands {
		if cmd.Name != BuiltinCommands[i] {
			t.Errorf("expected %s at index %d, got %s", BuiltinCommands[i], i, cmd.Name)
		}
		if !cmd.IsBuiltin {
			t.Errorf("expected %s to be builtin", cmd.Name)
		}
	}
}

func TestList_RecentCommandsFirst(t *testing.T) {
	dir := t.TempDir()
	store, err := NewStore(dir)
	if err != nil {
		t.Fatal(err)
	}

	store.Use("help")
	store.Use("model")

	commands := store.List()

	if commands[0].Name != "model" {
		t.Errorf("expected 'model' first, got %s", commands[0].Name)
	}
	if commands[1].Name != "help" {
		t.Errorf("expected 'help' second, got %s", commands[1].Name)
	}
}

func TestList_CustomCommandMarkedAsNotBuiltin(t *testing.T) {
	dir := t.TempDir()
	store, err := NewStore(dir)
	if err != nil {
		t.Fatal(err)
	}

	store.Use("my-custom-cmd")

	commands := store.List()

	if commands[0].Name != "my-custom-cmd" {
		t.Errorf("expected 'my-custom-cmd' first, got %s", commands[0].Name)
	}
	if commands[0].IsBuiltin {
		t.Error("expected custom command to not be builtin")
	}
}

func TestList_DuplicateUsageDeduped(t *testing.T) {
	dir := t.TempDir()
	store, err := NewStore(dir)
	if err != nil {
		t.Fatal(err)
	}

	store.Use("help")
	store.Use("model")
	store.Use("help")

	commands := store.List()

	if commands[0].Name != "help" {
		t.Errorf("expected 'help' first (most recent), got %s", commands[0].Name)
	}
	if commands[1].Name != "model" {
		t.Errorf("expected 'model' second, got %s", commands[1].Name)
	}

	helpCount := 0
	for _, cmd := range commands {
		if cmd.Name == "help" {
			helpCount++
		}
	}
	if helpCount != 1 {
		t.Errorf("expected 1 'help' entry, got %d", helpCount)
	}
}

func TestUse_TrimsOldEntries(t *testing.T) {
	dir := t.TempDir()
	store := &Store{dataDir: dir}

	for i := 0; i < maxRecentCommands+100; i++ {
		store.recent = append(store.recent, RecentCommand{Name: "cmd", UsedAt: time.Now()})
	}

	store.Use("final")

	if len(store.recent) != maxRecentCommands {
		t.Errorf("expected %d entries, got %d", maxRecentCommands, len(store.recent))
	}
}

func TestPersistence(t *testing.T) {
	dir := t.TempDir()
	store, err := NewStore(dir)
	if err != nil {
		t.Fatal(err)
	}

	store.Use("help")
	store.Use("model")

	store2, err := NewStore(dir)
	if err != nil {
		t.Fatal(err)
	}

	commands := store2.List()
	if commands[0].Name != "model" {
		t.Errorf("expected 'model' first after reload, got %s", commands[0].Name)
	}
}

func TestNewStore_InvalidJSON(t *testing.T) {
	dir := t.TempDir()
	filePath := filepath.Join(dir, "commands.json")
	os.WriteFile(filePath, []byte("invalid json"), 0644)

	_, err := NewStore(dir)
	if err == nil {
		t.Error("expected error for invalid JSON")
	}
}
