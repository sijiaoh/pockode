package globalconfig

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/google/uuid"
)

const workspacesFileName = "workspaces.json"

// Workspace represents a registered workspace (project directory).
type Workspace struct {
	// ID is the unique identifier for the workspace.
	ID string `json:"id"`

	// Path is the absolute path to the workspace directory.
	Path string `json:"path"`

	// Name is the display name (defaults to directory name).
	Name string `json:"name,omitempty"`

	// LastAccessed is the timestamp of the last access.
	LastAccessed time.Time `json:"last_accessed,omitempty"`

	// CreatedAt is the timestamp when the workspace was registered.
	CreatedAt time.Time `json:"created_at,omitempty"`
}

// workspacesFile represents the JSON file structure.
type workspacesFile struct {
	Workspaces []Workspace `json:"workspaces"`
}

// WorkspaceStore manages the workspace registry (workspaces.json).
type WorkspaceStore struct {
	path string
	mu   sync.RWMutex
}

// NewWorkspaceStore creates a WorkspaceStore.
func NewWorkspaceStore() (*WorkspaceStore, error) {
	dir, err := Dir()
	if err != nil {
		return nil, fmt.Errorf("get global config dir: %w", err)
	}

	return &WorkspaceStore{
		path: filepath.Join(dir, workspacesFileName),
	}, nil
}

// List returns all registered workspaces.
func (s *WorkspaceStore) List() ([]Workspace, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	return s.loadUnsafe()
}

// Get returns a workspace by ID, or nil if not found.
func (s *WorkspaceStore) Get(id string) (*Workspace, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	workspaces, err := s.loadUnsafe()
	if err != nil {
		return nil, err
	}

	for _, ws := range workspaces {
		if ws.ID == id {
			return &ws, nil
		}
	}

	return nil, nil
}

// GetByPath returns a workspace by path, or nil if not found.
func (s *WorkspaceStore) GetByPath(path string) (*Workspace, error) {
	absPath, err := filepath.Abs(path)
	if err != nil {
		return nil, fmt.Errorf("resolve path: %w", err)
	}

	s.mu.RLock()
	defer s.mu.RUnlock()

	workspaces, err := s.loadUnsafe()
	if err != nil {
		return nil, err
	}

	for _, ws := range workspaces {
		if ws.Path == absPath {
			return &ws, nil
		}
	}

	return nil, nil
}

// Register adds a new workspace or updates an existing one by path.
// Returns the workspace (existing or newly created).
func (s *WorkspaceStore) Register(path string, name string) (*Workspace, error) {
	absPath, err := filepath.Abs(path)
	if err != nil {
		return nil, fmt.Errorf("resolve path: %w", err)
	}

	if name == "" {
		name = filepath.Base(absPath)
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	workspaces, err := s.loadUnsafe()
	if err != nil {
		return nil, err
	}

	now := time.Now()

	for i, ws := range workspaces {
		if ws.Path == absPath {
			workspaces[i].Name = name
			workspaces[i].LastAccessed = now
			if err := s.saveUnsafe(workspaces); err != nil {
				return nil, err
			}
			return &workspaces[i], nil
		}
	}

	newWS := Workspace{
		ID:           uuid.NewString(),
		Path:         absPath,
		Name:         name,
		LastAccessed: now,
		CreatedAt:    now,
	}

	workspaces = append(workspaces, newWS)
	if err := s.saveUnsafe(workspaces); err != nil {
		return nil, err
	}

	return &newWS, nil
}

// UpdateLastAccessed updates the last accessed timestamp for a workspace.
func (s *WorkspaceStore) UpdateLastAccessed(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	workspaces, err := s.loadUnsafe()
	if err != nil {
		return err
	}

	for i, ws := range workspaces {
		if ws.ID == id {
			workspaces[i].LastAccessed = time.Now()
			return s.saveUnsafe(workspaces)
		}
	}

	return nil
}

// Delete removes a workspace by ID.
func (s *WorkspaceStore) Delete(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	workspaces, err := s.loadUnsafe()
	if err != nil {
		return err
	}

	for i, ws := range workspaces {
		if ws.ID == id {
			workspaces = append(workspaces[:i], workspaces[i+1:]...)
			return s.saveUnsafe(workspaces)
		}
	}

	return nil
}

// loadUnsafe reads workspaces from disk. Must be called with lock held.
func (s *WorkspaceStore) loadUnsafe() ([]Workspace, error) {
	data, err := os.ReadFile(s.path)
	if os.IsNotExist(err) {
		return []Workspace{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read workspaces: %w", err)
	}

	var file workspacesFile
	if err := json.Unmarshal(data, &file); err != nil {
		slog.Warn("globalconfig: corrupted workspaces.json, treating as empty", "error", err)
		return []Workspace{}, nil
	}

	if file.Workspaces == nil {
		return []Workspace{}, nil
	}

	return file.Workspaces, nil
}

// saveUnsafe writes workspaces to disk atomically. Must be called with lock held.
func (s *WorkspaceStore) saveUnsafe(workspaces []Workspace) error {
	file := workspacesFile{Workspaces: workspaces}

	data, err := json.MarshalIndent(file, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal workspaces: %w", err)
	}

	// Atomic write to prevent corruption
	if err := writeFileAtomic(s.path, data, 0644); err != nil {
		return fmt.Errorf("write workspaces: %w", err)
	}

	return nil
}
