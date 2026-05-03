package agentrole

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"path/filepath"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/pockode/server/filestore"
)

// Store provides CRUD operations and change notifications for AgentRole items.
type Store interface {
	List() ([]AgentRole, error)
	Get(id string) (AgentRole, bool, error)

	Create(ctx context.Context, r AgentRole) (AgentRole, error)
	Update(ctx context.Context, id string, fields UpdateFields) error
	Delete(ctx context.Context, id string) error
	// ResetDefaults replaces all roles with built-in defaults and returns the PM role ID.
	ResetDefaults(ctx context.Context) (string, error)

	AddOnChangeListener(listener OnChangeListener)

	// StartWatching begins monitoring the index file for external changes (e.g. from MCP).
	StartWatching() error
	StopWatching()
}

// UpdateFields specifies which fields to update. Nil fields are left unchanged.
type UpdateFields struct {
	Name       *string   `json:"name,omitempty"`
	RolePrompt *string   `json:"role_prompt,omitempty"`
	Steps      *[]string `json:"steps,omitempty"`
}

type indexData struct {
	Roles []AgentRole `json:"roles"`
}

// FileStore persists AgentRole items to a JSON file with flock-based inter-process safety.
type FileStore struct {
	file      *filestore.File
	rolesMu   sync.RWMutex
	roles     []AgentRole
	listeners []OnChangeListener

	// seededPMRoleID is set during initial seeding so the caller can configure the default agent role.
	seededPMRoleID string
}

func NewFileStore(dataDir string) (*FileStore, error) {
	store := &FileStore{}

	f, err := filestore.New(filestore.Config{
		Path:     filepath.Join(dataDir, "agent-roles", "index.json"),
		Label:    "agent-role",
		OnReload: store.reloadFromDisk,
	})
	if err != nil {
		return nil, err
	}
	store.file = f

	idx, err := store.readIndexFromDisk()
	if err != nil {
		return nil, err
	}
	store.roles = idx.Roles

	if len(store.roles) == 0 {
		pmID, err := store.seedDefaults()
		if err != nil {
			return nil, fmt.Errorf("seed default roles: %w", err)
		}
		store.seededPMRoleID = pmID
	}

	return store, nil
}

var defaultRoles = []struct {
	Name       string
	RolePrompt string
}{
	{
		Name: "PM",
		RolePrompt: "You are a world-class project manager who orchestrates coding agents to deliver features.\n\n" +
			"## Planning\n" +
			"- Break stories into focused, feature-oriented tasks with clear scope\n" +
			"- Use agent_role_list to discover available roles; assign the best fit for each task\n" +
			"- Always include a final review & refactoring task\n" +
			"## Completion\n" +
			"When all tasks are done, commit changes before calling work_done.",
	},
	{
		Name: "PM (Autopilot)",
		RolePrompt: "You are a world-class project manager who orchestrates coding agents to deliver features.\n\n" +
			"## Planning\n" +
			"- Break stories into focused, feature-oriented tasks with clear scope\n" +
			"- Use agent_role_list to discover available roles; assign the best fit for each task\n" +
			"- Always include a final review & refactoring task\n" +
			"## Execution\n" +
			"- Start tasks using work_start; run independent tasks in parallel\n" +
			"## Completion\n" +
			"When all tasks are done, commit changes before calling work_done.",
	},
	{
		Name: "Designer",
		RolePrompt: "You are a world-class UI designer specializing in mobile-first design.\n\n" +
			"## Approach\n" +
			"- Study existing UI code to understand the project's design language\n" +
			"- Do NOT modify code; write your design direction as a comment on the story using work_comment_add",
	},
	{
		Name: "Engineer",
		RolePrompt: "You are a world-class software engineer.\n\n" +
			"## Approach\n" +
			"- Read existing code before writing; understand context and follow established patterns\n" +
			"- Implement with a first-principles approach: correct, simple, and minimal\n" +
			"- After implementation, thoroughly review your changes and fix any issues before finishing",
	},
}

func (s *FileStore) seedDefaults() (string, error) {
	s.roles = buildDefaultRoles()
	if err := s.persistIndex(); err != nil {
		s.roles = nil
		return "", err
	}
	slog.Info("seeded default agent roles", "count", len(defaultRoles))
	return s.roles[0].ID, nil // defaultRoles[0] is always PM
}

// SeededPMRoleID returns the PM role ID if this store was freshly seeded.
// Returns empty string if roles already existed on disk.
func (s *FileStore) SeededPMRoleID() string {
	return s.seededPMRoleID
}

func buildDefaultRoles() []AgentRole {
	now := time.Now()
	roles := make([]AgentRole, 0, len(defaultRoles))
	for _, d := range defaultRoles {
		roles = append(roles, AgentRole{
			ID:         uuid.Must(uuid.NewV7()).String(),
			Name:       d.Name,
			RolePrompt: d.RolePrompt,
			CreatedAt:  now,
			UpdatedAt:  now,
		})
	}
	return roles
}

// --- Read operations ---

func (s *FileStore) List() ([]AgentRole, error) {
	s.rolesMu.RLock()
	defer s.rolesMu.RUnlock()

	result := make([]AgentRole, len(s.roles))
	copy(result, s.roles)
	return result, nil
}

func (s *FileStore) Get(id string) (AgentRole, bool, error) {
	s.rolesMu.RLock()
	defer s.rolesMu.RUnlock()

	for _, r := range s.roles {
		if r.ID == id {
			return r, true, nil
		}
	}
	return AgentRole{}, false, nil
}

// --- Write operations ---

func (s *FileStore) Create(_ context.Context, r AgentRole) (AgentRole, error) {
	if r.Name == "" {
		return AgentRole{}, fmt.Errorf("%w: name is required", ErrInvalidRole)
	}

	s.rolesMu.Lock()

	now := time.Now()
	role := AgentRole{
		ID:         uuid.Must(uuid.NewV7()).String(),
		Name:       r.Name,
		RolePrompt: r.RolePrompt,
		Steps:      r.Steps,
		CreatedAt:  now,
		UpdatedAt:  now,
	}

	s.roles = append(s.roles, role)

	if err := s.persistIndex(); err != nil {
		s.roles = s.roles[:len(s.roles)-1]
		s.rolesMu.Unlock()
		return AgentRole{}, err
	}

	listeners := s.copyListeners()
	s.rolesMu.Unlock()

	notify(listeners, ChangeEvent{Op: OperationCreate, Role: role})
	return role, nil
}

func (s *FileStore) Update(_ context.Context, id string, fields UpdateFields) error {
	s.rolesMu.Lock()

	idx := s.findIndex(id)
	if idx < 0 {
		s.rolesMu.Unlock()
		return ErrNotFound
	}

	r := &s.roles[idx]
	prev := *r

	now := time.Now()
	if fields.Name != nil {
		if *fields.Name == "" {
			s.rolesMu.Unlock()
			return fmt.Errorf("%w: name cannot be empty", ErrInvalidRole)
		}
		r.Name = *fields.Name
	}
	if fields.RolePrompt != nil {
		r.RolePrompt = *fields.RolePrompt
	}
	if fields.Steps != nil {
		r.Steps = *fields.Steps
	}
	r.UpdatedAt = now

	if err := s.persistIndex(); err != nil {
		*r = prev
		s.rolesMu.Unlock()
		return err
	}

	updated := *r
	listeners := s.copyListeners()
	s.rolesMu.Unlock()

	notify(listeners, ChangeEvent{Op: OperationUpdate, Role: updated})
	return nil
}

func (s *FileStore) Delete(_ context.Context, id string) error {
	s.rolesMu.Lock()

	idx := s.findIndex(id)
	if idx < 0 {
		s.rolesMu.Unlock()
		return ErrNotFound
	}

	deleted := s.roles[idx]

	newRoles := make([]AgentRole, 0, len(s.roles)-1)
	newRoles = append(newRoles, s.roles[:idx]...)
	newRoles = append(newRoles, s.roles[idx+1:]...)
	prev := s.roles
	s.roles = newRoles

	if err := s.persistIndex(); err != nil {
		s.roles = prev
		s.rolesMu.Unlock()
		return err
	}

	listeners := s.copyListeners()
	s.rolesMu.Unlock()

	notify(listeners, ChangeEvent{Op: OperationDelete, Role: deleted})
	return nil
}

func (s *FileStore) ResetDefaults(_ context.Context) (string, error) {
	s.rolesMu.Lock()

	prev := s.roles
	newRoles := buildDefaultRoles()
	s.roles = newRoles

	if err := s.persistIndex(); err != nil {
		s.roles = prev
		s.rolesMu.Unlock()
		return "", err
	}

	pmRoleID := newRoles[0].ID // defaultRoles[0] is always PM
	listeners := s.copyListeners()
	s.rolesMu.Unlock()

	events := diffRoles(prev, newRoles)
	for _, e := range events {
		notify(listeners, e)
	}

	slog.Info("agent roles reset to defaults", "count", len(defaultRoles))
	return pmRoleID, nil
}

// --- Listener management ---

func (s *FileStore) AddOnChangeListener(listener OnChangeListener) {
	s.rolesMu.Lock()
	defer s.rolesMu.Unlock()
	s.listeners = append(s.listeners, listener)
}

func (s *FileStore) copyListeners() []OnChangeListener {
	out := make([]OnChangeListener, len(s.listeners))
	copy(out, s.listeners)
	return out
}

func notify(listeners []OnChangeListener, event ChangeEvent) {
	for _, l := range listeners {
		l.OnAgentRoleChange(event)
	}
}

// --- File I/O ---

func (s *FileStore) readIndexFromDisk() (indexData, error) {
	data, err := s.file.Read()
	if err != nil {
		return indexData{}, err
	}
	if data == nil {
		return indexData{Roles: []AgentRole{}}, nil
	}

	var idx indexData
	if err := json.Unmarshal(data, &idx); err != nil {
		return indexData{}, err
	}
	if idx.Roles == nil {
		idx.Roles = []AgentRole{}
	}
	return idx, nil
}

func (s *FileStore) persistIndex() error {
	data, err := filestore.MarshalIndex(indexData{Roles: s.roles})
	if err != nil {
		return err
	}
	return s.file.Write(data)
}

// --- fsnotify ---

func (s *FileStore) StartWatching() error { return s.file.StartWatching() }
func (s *FileStore) StopWatching()        { s.file.StopWatching() }

func (s *FileStore) reloadFromDisk() {
	genBefore := s.file.SnapshotGen()

	idx, err := s.readIndexFromDisk()
	if err != nil {
		slog.Error("failed to reload agent role index", "error", err)
		return
	}

	s.rolesMu.Lock()

	if s.file.IsStale(genBefore) {
		s.rolesMu.Unlock()
		return
	}

	old := s.roles
	s.roles = idx.Roles
	listeners := s.copyListeners()
	s.rolesMu.Unlock()

	events := diffRoles(old, idx.Roles)
	for _, e := range events {
		notify(listeners, e)
	}
}

func diffRoles(old, updated []AgentRole) []ChangeEvent {
	return filestore.Diff(old, updated,
		func(r AgentRole) string { return r.ID },
		roleChanged,
		func(op filestore.Operation, r AgentRole) ChangeEvent {
			return ChangeEvent{Op: Operation(op), Role: r}
		},
	)
}

func roleChanged(a, b AgentRole) bool {
	return a.Name != b.Name ||
		a.RolePrompt != b.RolePrompt ||
		!stepsEqual(a.Steps, b.Steps) ||
		!a.UpdatedAt.Equal(b.UpdatedAt)
}

func stepsEqual(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// --- Helpers ---

func (s *FileStore) findIndex(id string) int {
	for i, r := range s.roles {
		if r.ID == id {
			return i
		}
	}
	return -1
}
