package node

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/pockode/server/filestore"
)

// Store provides CRUD operations for Node items.
type Store interface {
	List() ([]Node, error)
	Get(id string) (Node, bool, error)
	Create(path, name string, createMissingDir bool) (Node, error)
	Update(id string, fields UpdateFields, createMissingDir bool) (Node, error)
	Delete(id string) error
}

// UpdateFields specifies which fields to update. Nil fields are left unchanged.
type UpdateFields struct {
	Path *string `json:"path,omitempty"`
	Name *string `json:"name,omitempty"`
}

type indexData struct {
	Nodes []Node `json:"nodes"`
}

// FileStore persists Node items to a JSON file with file-lock-based inter-process safety.
type FileStore struct {
	file    *filestore.File
	nodesMu sync.RWMutex
	nodes   []Node
}

func NewFileStore(dataDir string) (*FileStore, error) {
	store := &FileStore{}

	f, err := filestore.New(filestore.Config{
		Path:  filepath.Join(dataDir, "nodes", "index.json"),
		Label: "node",
	})
	if err != nil {
		return nil, err
	}
	store.file = f

	idx, err := store.readIndexFromDisk()
	if err != nil {
		return nil, err
	}
	store.nodes = idx.Nodes

	return store, nil
}

func (s *FileStore) List() ([]Node, error) {
	s.nodesMu.RLock()
	defer s.nodesMu.RUnlock()

	result := make([]Node, len(s.nodes))
	copy(result, s.nodes)
	return result, nil
}

func (s *FileStore) Get(id string) (Node, bool, error) {
	s.nodesMu.RLock()
	defer s.nodesMu.RUnlock()

	for _, n := range s.nodes {
		if n.ID == id {
			return n, true, nil
		}
	}
	return Node{}, false, nil
}

// Create creates a new node. If name is empty, it's inferred from path.
// When createMissingDir is true, a non-existent directory is created (with
// parents) instead of being rejected.
func (s *FileStore) Create(path, name string, createMissingDir bool) (Node, error) {
	if path == "" {
		return Node{}, fmt.Errorf("%w: path is required", ErrInvalidNode)
	}

	absPath, err := resolveDir(path, createMissingDir)
	if err != nil {
		return Node{}, err
	}

	if name == "" {
		name = filepath.Base(absPath)
	}

	s.nodesMu.Lock()
	defer s.nodesMu.Unlock()

	for _, n := range s.nodes {
		if n.Path == absPath {
			return Node{}, fmt.Errorf("%w: path %q already exists", ErrDuplicatePath, absPath)
		}
	}

	now := time.Now()
	newNode := Node{
		ID:        uuid.Must(uuid.NewV7()).String(),
		Path:      absPath,
		Name:      name,
		CreatedAt: now,
		UpdatedAt: now,
	}

	s.nodes = append(s.nodes, newNode)

	if err := s.persistIndex(); err != nil {
		s.nodes = s.nodes[:len(s.nodes)-1]
		return Node{}, err
	}

	return newNode, nil
}

// Update modifies an existing node's fields. When createMissingDir is true and
// a new path is given, a non-existent directory is created instead of rejected.
func (s *FileStore) Update(id string, fields UpdateFields, createMissingDir bool) (Node, error) {
	s.nodesMu.Lock()
	defer s.nodesMu.Unlock()

	idx := s.findIndex(id)
	if idx < 0 {
		return Node{}, ErrNodeNotFound
	}

	n := &s.nodes[idx]
	prev := s.snapshotNodes()
	changed := false

	if fields.Path != nil {
		absPath, err := resolveDir(*fields.Path, createMissingDir)
		if err != nil {
			return Node{}, err
		}

		for _, other := range s.nodes {
			if other.ID != id && other.Path == absPath {
				return Node{}, fmt.Errorf("%w: path %q already exists", ErrDuplicatePath, absPath)
			}
		}

		if n.Path != absPath {
			n.Path = absPath
			changed = true
		}
	}

	if fields.Name != nil && n.Name != *fields.Name {
		n.Name = *fields.Name
		changed = true
	}

	if !changed {
		return *n, nil
	}

	n.UpdatedAt = time.Now()

	if err := s.persistIndex(); err != nil {
		s.nodes = prev
		return Node{}, err
	}

	return *n, nil
}

func (s *FileStore) Delete(id string) error {
	s.nodesMu.Lock()
	defer s.nodesMu.Unlock()

	idx := s.findIndex(id)
	if idx < 0 {
		return ErrNodeNotFound
	}

	prev := s.snapshotNodes()

	// Build new slice to avoid mutating prev (needed for rollback)
	newNodes := make([]Node, 0, len(s.nodes)-1)
	newNodes = append(newNodes, s.nodes[:idx]...)
	newNodes = append(newNodes, s.nodes[idx+1:]...)
	s.nodes = newNodes

	if err := s.persistIndex(); err != nil {
		s.nodes = prev
		return err
	}

	return nil
}

// --- File I/O ---

func (s *FileStore) readIndexFromDisk() (indexData, error) {
	data, err := s.file.Read()
	if err != nil {
		return indexData{}, err
	}
	if data == nil {
		return indexData{Nodes: []Node{}}, nil
	}

	var idx indexData
	if err := json.Unmarshal(data, &idx); err != nil {
		return indexData{}, err
	}
	if idx.Nodes == nil {
		idx.Nodes = []Node{}
	}
	return idx, nil
}

func (s *FileStore) persistIndex() error {
	data, err := filestore.MarshalIndex(indexData{Nodes: s.nodes})
	if err != nil {
		return err
	}
	return s.file.Write(data)
}

func (s *FileStore) snapshotNodes() []Node {
	out := make([]Node, len(s.nodes))
	copy(out, s.nodes)
	return out
}

func (s *FileStore) findIndex(id string) int {
	for i, n := range s.nodes {
		if n.ID == id {
			return i
		}
	}
	return -1
}

// resolveDir expands the path and validates that it refers to a directory,
// returning its absolute form. A missing directory is created (with parents)
// when createMissingDir is true; otherwise it yields a "path does not exist"
// error the frontend can detect to offer creation. Non-directory paths and
// other stat errors (e.g. permission denied) are always rejected.
func resolveDir(path string, createMissingDir bool) (string, error) {
	expanded := expandTilde(path)

	info, err := os.Stat(expanded)
	if err != nil {
		if !os.IsNotExist(err) {
			return "", fmt.Errorf("%w: %v", ErrInvalidNode, err)
		}
		if !createMissingDir {
			return "", fmt.Errorf("%w: path does not exist", ErrInvalidNode)
		}
		if err := os.MkdirAll(expanded, 0o755); err != nil {
			return "", fmt.Errorf("%w: could not create directory: %v", ErrInvalidNode, err)
		}
	} else if !info.IsDir() {
		return "", fmt.Errorf("%w: path is not a directory", ErrInvalidNode)
	}

	absPath, err := filepath.Abs(expanded)
	if err != nil {
		return "", fmt.Errorf("%w: invalid path", ErrInvalidNode)
	}
	return absPath, nil
}

// expandTilde expands special path prefixes to the user's home directory:
//   - "~" or "~/" prefix: standard tilde expansion
//   - "." (exactly): treated as home directory in cluster mode (global context)
//
// Returns the original path unchanged if no expansion applies or if the home
// directory cannot be determined.
func expandTilde(path string) string {
	// Handle "." as home directory in cluster mode
	if path == "." {
		home, err := os.UserHomeDir()
		if err != nil {
			return path
		}
		return home
	}

	if path != "~" && !strings.HasPrefix(path, "~/") {
		return path
	}

	home, err := os.UserHomeDir()
	if err != nil {
		return path
	}

	if path == "~" {
		return home
	}
	return filepath.Join(home, path[2:])
}
