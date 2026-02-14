package ticket

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"

	"github.com/google/uuid"
)

// DefaultRole is created when no roles exist.
var DefaultRole = AgentRole{
	ID:           "default",
	Name:         "Default",
	SystemPrompt: "You are a helpful assistant.",
}

// RoleStore defines role operations (RPC/MCP agnostic).
type RoleStore interface {
	List() ([]AgentRole, error)
	Get(roleID string) (AgentRole, bool, error)
	Create(ctx context.Context, name, systemPrompt string) (AgentRole, error)
	Update(ctx context.Context, roleID, name, systemPrompt string) (AgentRole, error)
	Delete(ctx context.Context, roleID string) error
}

// FileRoleStore implements RoleStore with file-based persistence.
type FileRoleStore struct {
	dataDir string
	mu      sync.RWMutex
	roles   []AgentRole
}

// NewFileRoleStore creates a new file-based role store.
func NewFileRoleStore(dataDir string) (*FileRoleStore, error) {
	store := &FileRoleStore{dataDir: dataDir}

	roles, err := store.readFromDisk()
	if err != nil {
		return nil, err
	}

	// Create default role if none exist
	if len(roles) == 0 {
		roles = []AgentRole{DefaultRole}
		store.roles = roles
		if err := store.persist(); err != nil {
			return nil, err
		}
	} else {
		store.roles = roles
	}

	return store, nil
}

func (s *FileRoleStore) filePath() string {
	return filepath.Join(s.dataDir, "agent_roles.json")
}

func (s *FileRoleStore) readFromDisk() ([]AgentRole, error) {
	data, err := os.ReadFile(s.filePath())
	if os.IsNotExist(err) {
		return []AgentRole{}, nil
	}
	if err != nil {
		return nil, err
	}

	var roles []AgentRole
	if err := json.Unmarshal(data, &roles); err != nil {
		return nil, err
	}

	return roles, nil
}

func (s *FileRoleStore) persist() error {
	data, err := json.MarshalIndent(s.roles, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.filePath(), data, 0644)
}

func (s *FileRoleStore) List() ([]AgentRole, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	result := make([]AgentRole, len(s.roles))
	copy(result, s.roles)
	return result, nil
}

func (s *FileRoleStore) Get(roleID string) (AgentRole, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	for _, r := range s.roles {
		if r.ID == roleID {
			return r, true, nil
		}
	}
	return AgentRole{}, false, nil
}

func (s *FileRoleStore) Create(ctx context.Context, name, systemPrompt string) (AgentRole, error) {
	if err := ctx.Err(); err != nil {
		return AgentRole{}, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	role := AgentRole{
		ID:           uuid.New().String(),
		Name:         name,
		SystemPrompt: systemPrompt,
	}

	s.roles = append(s.roles, role)

	if err := s.persist(); err != nil {
		s.roles = s.roles[:len(s.roles)-1]
		return AgentRole{}, err
	}

	return role, nil
}

func (s *FileRoleStore) Update(ctx context.Context, roleID, name, systemPrompt string) (AgentRole, error) {
	if err := ctx.Err(); err != nil {
		return AgentRole{}, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	for i := range s.roles {
		if s.roles[i].ID == roleID {
			old := s.roles[i]
			s.roles[i].Name = name
			s.roles[i].SystemPrompt = systemPrompt

			if err := s.persist(); err != nil {
				s.roles[i] = old
				return AgentRole{}, err
			}

			return s.roles[i], nil
		}
	}

	return AgentRole{}, ErrRoleNotFound
}

func (s *FileRoleStore) Delete(ctx context.Context, roleID string) error {
	if err := ctx.Err(); err != nil {
		return err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	newRoles := make([]AgentRole, 0, len(s.roles))
	found := false
	for _, r := range s.roles {
		if r.ID != roleID {
			newRoles = append(newRoles, r)
		} else {
			found = true
		}
	}

	if !found {
		return ErrRoleNotFound
	}

	s.roles = newRoles

	return s.persist()
}
