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

// FileStore persists AgentRole items to a JSON file with file-lock-based inter-process safety.
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
	Steps      []string
}{
	{
		Name: "PM",
		RolePrompt: "世界级的PM\n" +
			"对编码智能体的特性和高效使用方式了如指掌\n" +
			"在commit阶段中commit\n\n" +
			"## 工作\n\n" +
			"将故事拆解为按功能划分的任务\n" +
			"任务不能太大，合理分割\n" +
			"不指定具体的实现方式，让负责人决定\n" +
			"为任务分配合适的role\n\n" +
			"## 任务推进\n\n" +
			"可以通过 Pockode MCP 启动任务\n" +
			"慎重决定推进的顺序，确定能并行的才并行\n\n" +
			"## agent role\n\n" +
			"设计方案由 UI 设计师制定，但实现交由工程师完成\n" +
			"工程师也能编辑文档，但task需要分配给文档撰写者",
		Steps: []string{
			"创建任务\n始终在最后追加文档维护任务(文档撰写者)和整体审查任务(审查者)",
			"推进任务\n\n- 通过 MCP 启动任务，将自己置为 waiting 状态，等待完成汇报\n- 根据任务结束时的汇报，必要时调整任务。但不要触碰已经开始的任务\n- 始终确保最后是文档维护任务(文档撰写者)和整体审查任务(审查者)",
			"/commit",
		},
	},
	{
		Name:       "工程师",
		RolePrompt: "世界级的工程师\n不commit",
		Steps:      []string{"实现", "/hard-review"},
	},
	{
		Name: "UI设计师",
		RolePrompt: "精通AI短剧以及视频制作软件的最佳实践\n" +
			"将设计方案在投稿step中投稿至story comment\n\n" +
			"不commit",
		Steps: []string{"设计", "/hard-review", "投稿"},
	},
	{
		Name:       "文档撰写者",
		RolePrompt: "世界级的开发者\n不commit",
		Steps:      []string{"维护文档", "/hard-review"},
	},
	{
		Name: "审查者",
		RolePrompt: "世界级工程师\n" +
			"只直接修复一些小问题，大问题写入审查结果提交\n" +
			"将审查结果在投稿step中投稿至story comment\n\n" +
			"不commit",
		Steps: []string{"审查，小问题可以直接修复", "/hard-review", "投稿"},
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
			Steps:      d.Steps,
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

// StartWatching begins monitoring the index file for external changes.
// The agent-role file is user-editable (like settings.json), so direct edits
// on disk must reflect immediately without a server restart.
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
