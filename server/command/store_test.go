package command

import (
	"encoding/json"
	"fmt"
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
	filePath := filepath.Join(dir, "commands.json")

	// Create initial data at max limit (all in the past)
	var initial []RecentCommand
	baseTime := time.Now().Add(-time.Hour)
	for i := 0; i < maxRecentCommands; i++ {
		initial = append(initial, RecentCommand{
			Name:   fmt.Sprintf("cmd%d", i),
			UsedAt: baseTime.Add(time.Duration(i) * time.Second),
		})
	}
	data, _ := json.Marshal(initial)
	os.WriteFile(filePath, data, 0644)

	store, err := NewStore(dir)
	if err != nil {
		t.Fatal(err)
	}

	// Adding one more triggers trim
	store.Use("final")

	commands := store.List()
	if len(commands) > maxRecentCommands+len(BuiltinCommands) {
		t.Errorf("expected at most %d commands, got %d", maxRecentCommands+len(BuiltinCommands), len(commands))
	}

	// Verify newest entry is kept
	if commands[0].Name != "final" {
		t.Errorf("expected 'final' first (newest), got %s", commands[0].Name)
	}

	// Verify oldest entries are removed
	for _, cmd := range commands {
		if cmd.Name == "cmd0" {
			t.Error("expected 'cmd0' (oldest) to be removed")
		}
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

func TestIsValidName(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		isValid bool
	}{
		// Valid commands
		{"simple", "help", true},
		{"with-hyphen", "my-command", true},
		{"with-numbers", "cmd123", true},
		{"namespaced", "plugin:command", true},
		{"namespaced-with-hyphen", "my-plugin:my-command", true},

		// Valid - underscores (e.g., pr_comments)
		{"underscore", "my_command", true},
		{"underscore-builtin", "pr_comments", true},

		// Invalid - file paths
		{"file-path", "path/to/file", false},
		{"absolute-path", "Users/name/file", false},

		// Invalid - dotfiles
		{"dotfile", ".env", false},
		{"dotfile-path", ".config/file", false},

		// Invalid - uppercase
		{"uppercase", "Help", false},
		{"mixed-case", "myCommand", false},

		// Invalid - special chars
		{"starts-with-number", "123cmd", false},
		{"starts-with-hyphen", "-cmd", false},
		{"empty", "", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := IsValidName(tt.input)
			if got != tt.isValid {
				t.Errorf("IsValidName(%q) = %v, want %v", tt.input, got, tt.isValid)
			}
		})
	}
}

func TestUse_InvalidName(t *testing.T) {
	dir := t.TempDir()
	store, err := NewStore(dir)
	if err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		name  string
		input string
	}{
		{"file-path", "path/to/file"},
		{"dotfile", ".env"},
		{"uppercase", "Help"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			recorded, err := store.Use(tt.input)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if recorded {
				t.Errorf("expected Use(%q) to return false, got true", tt.input)
			}
		})
	}

	// Verify nothing was recorded
	commands := store.List()
	for _, cmd := range commands {
		if !cmd.IsBuiltin {
			t.Errorf("unexpected custom command recorded: %s", cmd.Name)
		}
	}
}
