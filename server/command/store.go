// Package command manages slash command history, the builtin command
// definitions, and Pockode's own commands (see docs/pockode-commands.md).
package command

import (
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/pockode/server/filestore"
)

// namePattern validates slash command names per Claude Code naming conventions.
// Keep in sync with web/src/components/Chat/InputBar.tsx COMMAND_PATTERN.
var namePattern = regexp.MustCompile(`^[a-z][a-z0-9_-]*(:[a-z][a-z0-9_-]*)?$`)

// IsValidName reports whether name is a valid slash command name.
func IsValidName(name string) bool {
	return namePattern.MatchString(name)
}

// BuiltinCommands lists Claude Code slash commands available in Pockode.
var BuiltinCommands = []string{
	"compact",
	"context",
	"cost",
	"init",
	"review",
}

// RecentCommand represents a recently used slash command.
type RecentCommand struct {
	Name   string    `json:"name"`
	UsedAt time.Time `json:"usedAt"`
}

// Command is the API response type. A command is one of three kinds: a builtin
// of the agent CLI (IsBuiltin), one of Pockode's own (IsPockode), or neither —
// a user's custom command.
type Command struct {
	Name      string `json:"name"`
	IsBuiltin bool   `json:"isBuiltin"`
	IsPockode bool   `json:"isPockode"`
	// Description is set for Pockode commands only.
	Description string `json:"description,omitempty"`
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
	// NewStore's error aborts server startup, so a commands.json damaged by a
	// crash would make the whole server unbootable over nothing but slash
	// command history: quarantine it and start from empty instead.
	var recent []RecentCommand
	found, err := filestore.ReadJSONOrQuarantine(s.filePath(), "command history", &recent)
	if err != nil {
		return nil, err
	}
	if !found {
		return []RecentCommand{}, nil
	}

	// Deduplicate for legacy data; new entries are deduplicated in Use().
	return deduplicateCommands(recent), nil
}

func deduplicateCommands(commands []RecentCommand) []RecentCommand {
	latest := make(map[string]RecentCommand)
	for _, cmd := range commands {
		if existing, ok := latest[cmd.Name]; !ok || cmd.UsedAt.After(existing.UsedAt) {
			latest[cmd.Name] = cmd
		}
	}

	result := make([]RecentCommand, 0, len(latest))
	for _, cmd := range latest {
		result = append(result, cmd)
	}
	return result
}

func (s *Store) persist() error {
	data, err := filestore.MarshalIndex(s.recent)
	if err != nil {
		return err
	}
	return filestore.WriteFileAtomic(s.filePath(), data, 0644)
}

// List returns commands sorted by most recently used, with unused Pockode
// commands and then unused builtins appended at the end. Outside a git
// repository the Pockode commands that need one are left out.
func (s *Store) List(isGitRepo bool) []Command {
	s.mu.RLock()
	defer s.mu.RUnlock()

	sorted := make([]RecentCommand, len(s.recent))
	copy(sorted, s.recent)
	sort.Slice(sorted, func(i, j int) bool {
		return sorted[i].UsedAt.After(sorted[j].UsedAt)
	})

	seen := make(map[string]bool)
	commands := make([]Command, 0, len(sorted)+len(PockodeCommands)+len(BuiltinCommands))
	for _, rc := range sorted {
		if strings.HasPrefix(rc.Name, PockodePrefix) && !isOfferedPockode(rc.Name, isGitRepo) {
			// Sent before the prefix was Pockode's, a command since removed, or
			// one this project cannot run: offering it now would only offer an
			// error.
			continue
		}
		seen[rc.Name] = true
		commands = append(commands, newCommand(rc.Name))
	}

	for _, cmd := range PockodeCommands {
		if !seen[cmd.Name] && isOfferedPockode(cmd.Name, isGitRepo) {
			commands = append(commands, newCommand(cmd.Name))
		}
	}

	for _, name := range BuiltinCommands {
		if seen[name] {
			continue
		}
		commands = append(commands, newCommand(name))
	}

	return commands
}

func isOfferedPockode(name string, isGitRepo bool) bool {
	cmd, ok := findPockode(name)
	return ok && (isGitRepo || !cmd.needsGit)
}

func newCommand(name string) Command {
	if cmd, ok := findPockode(name); ok {
		return Command{Name: name, IsPockode: true, Description: cmd.Description}
	}
	return Command{Name: name, IsBuiltin: slices.Contains(BuiltinCommands, name)}
}

const maxRecentCommands = 1000

// Use records a command usage. Returns false if name is invalid.
func (s *Store) Use(name string) (bool, error) {
	if !IsValidName(name) {
		return false, nil
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now()
	newRecent := slices.Clone(s.recent)

	idx := slices.IndexFunc(newRecent, func(rc RecentCommand) bool {
		return rc.Name == name
	})

	if idx >= 0 {
		newRecent[idx].UsedAt = now
	} else {
		newRecent = append(newRecent, RecentCommand{
			Name:   name,
			UsedAt: now,
		})
	}

	if len(newRecent) > maxRecentCommands {
		sort.Slice(newRecent, func(i, j int) bool {
			return newRecent[i].UsedAt.After(newRecent[j].UsedAt)
		})
		newRecent = newRecent[:maxRecentCommands]
	}

	old := s.recent
	s.recent = newRecent
	if err := s.persist(); err != nil {
		s.recent = old
		return false, err
	}
	return true, nil
}
