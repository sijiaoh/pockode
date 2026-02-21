package agentrole

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/google/uuid"
)

// Store provides CRUD operations and change notifications for AgentRole items.
type Store interface {
	List() ([]AgentRole, error)
	Get(id string) (AgentRole, bool, error)

	Create(ctx context.Context, r AgentRole) (AgentRole, error)
	Update(ctx context.Context, id string, fields UpdateFields) error
	Delete(ctx context.Context, id string) error

	AddOnChangeListener(listener OnChangeListener)

	// StartWatching begins monitoring the index file for external changes (e.g. from MCP).
	StartWatching() error
	StopWatching()
}

// UpdateFields specifies which fields to update. Nil fields are left unchanged.
type UpdateFields struct {
	Name       *string `json:"name,omitempty"`
	RolePrompt *string `json:"role_prompt,omitempty"`
}

type indexData struct {
	Roles []AgentRole `json:"roles"`
}

// FileStore persists AgentRole items to a JSON file with flock-based inter-process safety.
type FileStore struct {
	dataDir   string
	rolesMu   sync.RWMutex
	roles     []AgentRole
	listeners []OnChangeListener

	// writeGen is incremented on every in-process write (Create/Update/Delete).
	// reloadFromDisk uses it to skip stale fsnotify-triggered reloads.
	writeGen atomic.Int64

	// fsnotify for detecting external changes (MCP writes)
	watcher    *fsnotify.Watcher
	debounce   *time.Timer
	debounceMu sync.Mutex
}

func NewFileStore(dataDir string) (*FileStore, error) {
	rolesDir := filepath.Join(dataDir, "agent-roles")
	if err := os.MkdirAll(rolesDir, 0755); err != nil {
		return nil, err
	}

	store := &FileStore{dataDir: dataDir}

	idx, err := store.readIndexFromDisk()
	if err != nil {
		return nil, err
	}
	store.roles = idx.Roles

	return store, nil
}

func (s *FileStore) indexPath() string {
	return filepath.Join(s.dataDir, "agent-roles", "index.json")
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

// --- Listener management ---

func (s *FileStore) AddOnChangeListener(listener OnChangeListener) {
	s.rolesMu.Lock()
	defer s.rolesMu.Unlock()
	s.listeners = append(s.listeners, listener)
}

// Caller must hold s.rolesMu (read or write).
func (s *FileStore) copyListeners() []OnChangeListener {
	out := make([]OnChangeListener, len(s.listeners))
	copy(out, s.listeners)
	return out
}

// Must be called WITHOUT s.rolesMu held.
func notify(listeners []OnChangeListener, event ChangeEvent) {
	for _, l := range listeners {
		l.OnAgentRoleChange(event)
	}
}

// --- File I/O with flock ---
//
// A dedicated lock file (index.json.lock) is used for flock because the data
// file may be replaced via rename, which changes its inode. A stable lock file
// ensures flock works correctly across processes.

func (s *FileStore) lockPath() string {
	return s.indexPath() + ".lock"
}

func (s *FileStore) readIndexFromDisk() (indexData, error) {
	lockF, err := os.OpenFile(s.lockPath(), os.O_CREATE|os.O_RDWR, 0644)
	if err != nil {
		return indexData{}, fmt.Errorf("open lock file: %w", err)
	}
	defer lockF.Close()

	if err := syscall.Flock(int(lockF.Fd()), syscall.LOCK_SH); err != nil {
		return indexData{}, fmt.Errorf("flock shared: %w", err)
	}
	defer syscall.Flock(int(lockF.Fd()), syscall.LOCK_UN)

	path := s.indexPath()
	f, err := os.Open(path)
	if os.IsNotExist(err) {
		return indexData{Roles: []AgentRole{}}, nil
	}
	if err != nil {
		return indexData{}, err
	}
	defer f.Close()

	var idx indexData
	if err := json.NewDecoder(f).Decode(&idx); err != nil {
		return indexData{}, err
	}
	if idx.Roles == nil {
		idx.Roles = []AgentRole{}
	}
	return idx, nil
}

// persistIndex writes the index atomically using write-temp-fsync-rename.
func (s *FileStore) persistIndex() error {
	data, err := json.MarshalIndent(indexData{Roles: s.roles}, "", "  ")
	if err != nil {
		return err
	}

	lockF, err := os.OpenFile(s.lockPath(), os.O_CREATE|os.O_RDWR, 0644)
	if err != nil {
		return fmt.Errorf("open lock file: %w", err)
	}
	defer lockF.Close()

	if err := syscall.Flock(int(lockF.Fd()), syscall.LOCK_EX); err != nil {
		return fmt.Errorf("flock exclusive: %w", err)
	}
	defer syscall.Flock(int(lockF.Fd()), syscall.LOCK_UN)

	path := s.indexPath()
	tmpPath := path + ".tmp"

	tmpF, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644)
	if err != nil {
		return fmt.Errorf("create temp file: %w", err)
	}

	if _, err := tmpF.Write(data); err != nil {
		tmpF.Close()
		os.Remove(tmpPath)
		return fmt.Errorf("write temp file: %w", err)
	}
	if err := tmpF.Sync(); err != nil {
		tmpF.Close()
		os.Remove(tmpPath)
		return fmt.Errorf("fsync temp file: %w", err)
	}
	if err := tmpF.Close(); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("close temp file: %w", err)
	}

	if err := os.Rename(tmpPath, path); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("rename temp to index: %w", err)
	}

	s.writeGen.Add(1)
	return nil
}

// --- fsnotify: detect external changes (MCP writes) ---

func (s *FileStore) StartWatching() error {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return err
	}
	s.watcher = watcher

	dir := filepath.Dir(s.indexPath())
	if err := watcher.Add(dir); err != nil {
		watcher.Close()
		return err
	}

	go s.watchLoop()
	slog.Info("AgentRoleStore watching for external changes", "path", s.indexPath())
	return nil
}

func (s *FileStore) StopWatching() {
	s.debounceMu.Lock()
	if s.debounce != nil {
		s.debounce.Stop()
	}
	s.debounceMu.Unlock()

	if s.watcher != nil {
		s.watcher.Close()
	}
}

func (s *FileStore) watchLoop() {
	for {
		select {
		case event, ok := <-s.watcher.Events:
			if !ok {
				return
			}
			if filepath.Base(event.Name) != "index.json" {
				continue
			}
			if event.Op&(fsnotify.Write|fsnotify.Create) == 0 {
				continue
			}
			s.scheduleReload()
		case err, ok := <-s.watcher.Errors:
			if !ok {
				return
			}
			slog.Error("agent role store fsnotify error", "error", err)
		}
	}
}

const reloadDebounce = 100 * time.Millisecond

func (s *FileStore) scheduleReload() {
	s.debounceMu.Lock()
	defer s.debounceMu.Unlock()

	if s.debounce != nil {
		s.debounce.Stop()
	}
	s.debounce = time.AfterFunc(reloadDebounce, s.reloadFromDisk)
}

func (s *FileStore) reloadFromDisk() {
	genBefore := s.writeGen.Load()

	idx, err := s.readIndexFromDisk()
	if err != nil {
		slog.Error("failed to reload agent role index", "error", err)
		return
	}

	s.rolesMu.Lock()

	if s.writeGen.Load() != genBefore {
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
	var events []ChangeEvent

	oldMap := make(map[string]AgentRole, len(old))
	for _, r := range old {
		oldMap[r.ID] = r
	}

	newMap := make(map[string]AgentRole, len(updated))
	for _, r := range updated {
		newMap[r.ID] = r
	}

	for id, r := range oldMap {
		if _, exists := newMap[id]; !exists {
			events = append(events, ChangeEvent{Op: OperationDelete, Role: r})
		}
	}

	for id, r := range newMap {
		oldR, exists := oldMap[id]
		if !exists {
			events = append(events, ChangeEvent{Op: OperationCreate, Role: r})
		} else if roleChanged(oldR, r) {
			events = append(events, ChangeEvent{Op: OperationUpdate, Role: r})
		}
	}

	return events
}

func roleChanged(a, b AgentRole) bool {
	return a.Name != b.Name ||
		a.RolePrompt != b.RolePrompt ||
		!a.UpdatedAt.Equal(b.UpdatedAt)
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
