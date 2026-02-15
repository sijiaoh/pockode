package ticket

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
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
	SetOnChangeListener(listener OnRoleChangeListener)
	// GetPromptFilePath returns the file path where the role's system prompt is stored.
	// Agents can use this path with the Read tool to access the prompt.
	GetPromptFilePath(roleID string) string
}

// FileRoleStore implements RoleStore with file-based persistence.
type FileRoleStore struct {
	dataDir  string
	mu       sync.RWMutex
	roles    []AgentRole
	listener OnRoleChangeListener

	watcher   *fsnotify.Watcher
	stopCh    chan struct{}
	lastWrite time.Time
	writingMu sync.Mutex
}

// NewFileRoleStore creates a new file-based role store.
func NewFileRoleStore(dataDir string) (*FileRoleStore, error) {
	store := &FileRoleStore{
		dataDir: dataDir,
		stopCh:  make(chan struct{}),
	}

	roles, err := store.readFromDisk()
	if err != nil {
		return nil, err
	}

	// Create default role if none exist
	if len(roles) == 0 {
		roles = []AgentRole{DefaultRole}
	}
	store.roles = roles

	// Always persist to ensure prompt files are in sync
	if err := store.persist(); err != nil {
		return nil, err
	}

	// Start file watcher for external changes (e.g., from MCP)
	if err := store.startWatcher(); err != nil {
		slog.Warn("failed to start role file watcher", "error", err)
	}

	return store, nil
}

func (s *FileRoleStore) filePath() string {
	return filepath.Join(s.dataDir, "agent_roles.json")
}

func (s *FileRoleStore) rolesDir() string {
	return filepath.Join(s.dataDir, "roles")
}

// GetPromptFilePath returns the file path where the role's system prompt is stored.
func (s *FileRoleStore) GetPromptFilePath(roleID string) string {
	return filepath.Join(s.rolesDir(), roleID, "prompt.md")
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

	if err := os.WriteFile(s.filePath(), data, 0644); err != nil {
		return err
	}

	// Write prompt files for each role
	if err := s.writeAllPromptFiles(); err != nil {
		return err
	}

	// Mark as self-write to ignore the fsnotify event
	s.writingMu.Lock()
	s.lastWrite = time.Now()
	s.writingMu.Unlock()

	return nil
}

func (s *FileRoleStore) writeAllPromptFiles() error {
	for _, role := range s.roles {
		if err := s.writePromptFile(role); err != nil {
			return err
		}
	}
	return nil
}

func (s *FileRoleStore) writePromptFile(role AgentRole) error {
	promptPath := s.GetPromptFilePath(role.ID)
	promptDir := filepath.Dir(promptPath)

	if err := os.MkdirAll(promptDir, 0755); err != nil {
		return err
	}

	return os.WriteFile(promptPath, []byte(role.SystemPrompt), 0644)
}

func (s *FileRoleStore) deletePromptFile(roleID string) error {
	roleDir := filepath.Join(s.rolesDir(), roleID)
	// Remove the entire role directory (containing prompt.md)
	err := os.RemoveAll(roleDir)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

func (s *FileRoleStore) startWatcher() error {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return err
	}
	s.watcher = watcher

	// Watch the data directory for agent_roles.json changes
	if err := watcher.Add(s.dataDir); err != nil {
		watcher.Close()
		return err
	}

	go s.watchLoop()
	slog.Info("role file watcher started", "path", s.filePath())
	return nil
}

func (s *FileRoleStore) watchLoop() {
	const debounceInterval = 100 * time.Millisecond
	var debounceTimer *time.Timer

	for {
		select {
		case <-s.stopCh:
			if debounceTimer != nil {
				debounceTimer.Stop()
			}
			return
		case event, ok := <-s.watcher.Events:
			if !ok {
				return
			}
			// Only care about agent_roles.json writes
			if filepath.Base(event.Name) != "agent_roles.json" {
				continue
			}
			if event.Op&(fsnotify.Write|fsnotify.Create) == 0 {
				continue
			}

			// Check if this is a self-triggered write
			s.writingMu.Lock()
			if time.Since(s.lastWrite) < 200*time.Millisecond {
				s.writingMu.Unlock()
				continue
			}
			s.writingMu.Unlock()

			// Debounce rapid changes
			if debounceTimer != nil {
				debounceTimer.Stop()
			}
			debounceTimer = time.AfterFunc(debounceInterval, func() {
				s.reloadFromDisk()
			})
		case err, ok := <-s.watcher.Errors:
			if !ok {
				return
			}
			slog.Warn("role file watcher error", "error", err)
		}
	}
}

func (s *FileRoleStore) reloadFromDisk() {
	roles, err := s.readFromDisk()
	if err != nil {
		slog.Error("failed to reload roles from disk", "error", err)
		return
	}

	s.mu.Lock()
	oldRoles := s.roles
	s.roles = roles
	s.mu.Unlock()

	// Update prompt files to match reloaded data
	if err := s.writeAllPromptFiles(); err != nil {
		slog.Error("failed to write prompt files after reload", "error", err)
	}

	// Clean up prompt files for deleted roles
	s.cleanupDeletedRolePromptFiles(oldRoles, roles)

	// Compute and notify changes
	s.notifyExternalChanges(oldRoles, roles)
	slog.Debug("roles reloaded from disk", "count", len(roles))
}

func (s *FileRoleStore) cleanupDeletedRolePromptFiles(oldRoles, newRoles []AgentRole) {
	newMap := make(map[string]struct{}, len(newRoles))
	for _, r := range newRoles {
		newMap[r.ID] = struct{}{}
	}

	for _, r := range oldRoles {
		if _, exists := newMap[r.ID]; !exists {
			if err := s.deletePromptFile(r.ID); err != nil {
				slog.Warn("failed to delete prompt file for removed role", "role_id", r.ID, "error", err)
			}
		}
	}
}

func (s *FileRoleStore) notifyExternalChanges(oldRoles, newRoles []AgentRole) {
	oldMap := make(map[string]AgentRole)
	for _, r := range oldRoles {
		oldMap[r.ID] = r
	}

	newMap := make(map[string]AgentRole)
	for _, r := range newRoles {
		newMap[r.ID] = r
	}

	// Find created and updated
	for _, r := range newRoles {
		old, exists := oldMap[r.ID]
		if !exists {
			s.notifyChange(RoleChangeEvent{Op: OperationCreate, Role: r})
		} else if r.Name != old.Name || r.SystemPrompt != old.SystemPrompt {
			s.notifyChange(RoleChangeEvent{Op: OperationUpdate, Role: r})
		}
	}

	// Find deleted
	for _, r := range oldRoles {
		if _, exists := newMap[r.ID]; !exists {
			s.notifyChange(RoleChangeEvent{Op: OperationDelete, Role: r})
		}
	}
}

// Stop is safe to call multiple times or before watcher is started.
func (s *FileRoleStore) Stop() {
	if s.watcher == nil || s.stopCh == nil {
		return
	}
	select {
	case <-s.stopCh:
		// Already closed
	default:
		close(s.stopCh)
	}
	s.watcher.Close()
}

func (s *FileRoleStore) SetOnChangeListener(listener OnRoleChangeListener) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.listener = listener
}

func (s *FileRoleStore) notifyChange(event RoleChangeEvent) {
	if s.listener != nil {
		s.listener.OnRoleChange(event)
	}
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

	s.notifyChange(RoleChangeEvent{Op: OperationCreate, Role: role})
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

			s.notifyChange(RoleChangeEvent{Op: OperationUpdate, Role: s.roles[i]})
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
	var deleted AgentRole
	found := false
	for _, r := range s.roles {
		if r.ID != roleID {
			newRoles = append(newRoles, r)
		} else {
			deleted = r
			found = true
		}
	}

	if !found {
		return ErrRoleNotFound
	}

	oldRoles := s.roles
	s.roles = newRoles

	if err := s.persist(); err != nil {
		s.roles = oldRoles
		return err
	}

	// Delete prompt file (best effort, don't fail the delete operation)
	if err := s.deletePromptFile(roleID); err != nil {
		slog.Warn("failed to delete prompt file", "role_id", roleID, "error", err)
	}

	s.notifyChange(RoleChangeEvent{Op: OperationDelete, Role: deleted})
	return nil
}
