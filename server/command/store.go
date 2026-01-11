// Package command manages slash command history and builtin command definitions.
package command

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"sync"
	"time"
)

// namePattern validates slash command names per Claude Code naming conventions.
// Keep in sync with web/src/components/Chat/InputBar.tsx COMMAND_PATTERN.
var namePattern = regexp.MustCompile(`^[a-z][a-z0-9_-]*(:[a-z][a-z0-9_-]*)?$`)

// IsValidName reports whether name is a valid slash command name.
func IsValidName(name string) bool {
	return namePattern.MatchString(name)
}

// BuiltinCommands is the list of built-in Claude Code slash commands.
var BuiltinCommands = []string{
	"add-dir", "agents", "bug", "clear", "compact",
	"config", "cost", "doctor", "help", "init",
	"login", "logout", "mcp", "memory", "model",
	"permissions", "pr_comments", "review", "rewind",
	"status", "terminal-setup", "usage", "vim",
}

// RecentCommand represents a recently used slash command.
type RecentCommand struct {
	Name   string    `json:"name"`
	UsedAt time.Time `json:"usedAt"`
}

// Command is the API response type with builtin flag.
type Command struct {
	Name      string `json:"name"`
	IsBuiltin bool   `json:"isBuiltin"`
}

// Store manages slash command history.
type Store struct {
	dataDir string
	mu      sync.RWMutex
	recent  []RecentCommand // in-memory cache
}

// NewStore creates a new command store.
func NewStore(dataDir string) (*Store, error) {
	store := &Store{dataDir: dataDir}

	recent, err := store.readFromDisk()
	if err != nil {
		return nil, err
	}
	store.recent = recent

	return store, nil
}

func (s *Store) filePath() string {
	return filepath.Join(s.dataDir, "commands.json")
}

func (s *Store) readFromDisk() ([]RecentCommand, error) {
	data, err := os.ReadFile(s.filePath())
	if os.IsNotExist(err) {
		return []RecentCommand{}, nil
	}
	if err != nil {
		return nil, err
	}

	var recent []RecentCommand
	if err := json.Unmarshal(data, &recent); err != nil {
		return nil, err
	}
	return recent, nil
}

func (s *Store) persist() error {
	data, err := json.MarshalIndent(s.recent, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.filePath(), data, 0644)
}

// List returns commands sorted by most recently used, with unused builtins appended at the end.
func (s *Store) List() []Command {
	s.mu.RLock()
	defer s.mu.RUnlock()

	sorted := make([]RecentCommand, len(s.recent))
	copy(sorted, s.recent)
	sort.Slice(sorted, func(i, j int) bool {
		return sorted[i].UsedAt.After(sorted[j].UsedAt)
	})

	seen := make(map[string]bool)
	commands := []Command{}
	for _, rc := range sorted {
		if seen[rc.Name] {
			continue
		}
		seen[rc.Name] = true
		commands = append(commands, Command{
			Name:      rc.Name,
			IsBuiltin: slices.Contains(BuiltinCommands, rc.Name),
		})
	}

	for _, name := range BuiltinCommands {
		if seen[name] {
			continue
		}
		commands = append(commands, Command{
			Name:      name,
			IsBuiltin: true,
		})
	}

	return commands
}

const maxRecentCommands = 1000

// Use records a command usage. Returns false if name is invalid.
func (s *Store) Use(name string) (bool, error) {
	if !IsValidName(name) {
		return false, nil
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	newRecent := append(slices.Clone(s.recent), RecentCommand{
		Name:   name,
		UsedAt: time.Now(),
	})

	if len(newRecent) > maxRecentCommands {
		newRecent = newRecent[len(newRecent)-maxRecentCommands:]
	}

	old := s.recent
	s.recent = newRecent
	if err := s.persist(); err != nil {
		s.recent = old
		return false, err
	}
	return true, nil
}
