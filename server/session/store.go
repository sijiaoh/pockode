package session

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/pockode/server/filestore"
)

type Store interface {
	// Session metadata (memory only)
	List() ([]SessionMeta, error)
	Get(sessionID string) (SessionMeta, bool, error)

	// Session metadata (with I/O)
	Create(ctx context.Context, sessionID string, agentType AgentType, mode Mode) (SessionMeta, error)
	Delete(ctx context.Context, sessionID string) error
	Update(ctx context.Context, sessionID string, title string) error
	Activate(ctx context.Context, sessionID string) error
	SetAgentType(ctx context.Context, sessionID string, agentType AgentType) error
	SetMode(ctx context.Context, sessionID string, mode Mode) error
	SetModel(ctx context.Context, sessionID string, model string) error
	SetEffort(ctx context.Context, sessionID string, effort string) error
	SetNeedsInput(ctx context.Context, sessionID string, needsInput bool) error
	SetUnread(ctx context.Context, sessionID string, unread bool) error

	// History persistence
	GetHistory(ctx context.Context, sessionID string) ([]json.RawMessage, error)
	// AppendToHistory appends a JSON-serializable record to history (does not update timestamp).
	AppendToHistory(ctx context.Context, sessionID string, record any) error
	// Touch updates the session's UpdatedAt and notifies listeners.
	Touch(ctx context.Context, sessionID string) error

	// Change notification
	SetOnChangeListener(listener OnChangeListener)
}

type indexData struct {
	Sessions []SessionMeta `json:"sessions"`
}

// FileStore is NOT safe for multiple instances sharing the same dataDir.
// Use a single instance per data directory (e.g., via dependency injection).
type FileStore struct {
	dataDir  string
	mu       sync.RWMutex
	sessions []SessionMeta // in-memory cache
	listener OnChangeListener
}

func NewFileStore(dataDir string) (*FileStore, error) {
	sessionsDir := filepath.Join(dataDir, "sessions")
	if err := os.MkdirAll(sessionsDir, 0755); err != nil {
		return nil, err
	}

	store := &FileStore{dataDir: dataDir}

	idx, err := store.readIndexFromDisk()
	if err != nil {
		return nil, err
	}
	store.sessions = idx.Sessions

	return store, nil
}

func (s *FileStore) indexPath() string {
	return filepath.Join(s.dataDir, "sessions", "index.json")
}

func (s *FileStore) readIndexFromDisk() (indexData, error) {
	// A corrupt index must not make every session unreachable: it is quarantined
	// for hand recovery and the store starts from an empty list.
	var idx indexData
	found, err := filestore.ReadJSONOrQuarantine(s.indexPath(), "session index", &idx)
	if err != nil {
		return indexData{}, err
	}
	if !found {
		return indexData{Sessions: []SessionMeta{}}, nil
	}

	// Migrate: ensure all sessions have valid defaults
	for i := range idx.Sessions {
		if idx.Sessions[i].AgentType == "" {
			idx.Sessions[i].AgentType = AgentTypeClaude
		}
		if idx.Sessions[i].Mode == "" {
			idx.Sessions[i].Mode = ModeDefault
		}
	}

	return idx, nil
}

func (s *FileStore) persistIndex() error {
	data, err := filestore.MarshalIndex(indexData{Sessions: s.sessions})
	if err != nil {
		return err
	}
	return filestore.WriteFileAtomic(s.indexPath(), data, 0644)
}

func (s *FileStore) SetOnChangeListener(listener OnChangeListener) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.listener = listener
}

func (s *FileStore) notifyChange(event SessionChangeEvent) {
	if s.listener != nil {
		s.listener.OnSessionChange(event)
	}
}

func (s *FileStore) List() ([]SessionMeta, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	result := make([]SessionMeta, len(s.sessions))
	copy(result, s.sessions)

	sort.Slice(result, func(i, j int) bool {
		return result[i].UpdatedAt.After(result[j].UpdatedAt)
	})

	return result, nil
}

func (s *FileStore) Get(sessionID string) (SessionMeta, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	for _, sess := range s.sessions {
		if sess.ID == sessionID {
			return sess, true, nil
		}
	}
	return SessionMeta{}, false, nil
}

func (s *FileStore) Create(ctx context.Context, sessionID string, agentType AgentType, mode Mode) (SessionMeta, error) {
	if err := ctx.Err(); err != nil {
		return SessionMeta{}, err
	}

	if agentType == "" {
		agentType = AgentTypeClaude
	}
	if mode == "" {
		mode = ModeDefault
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now()
	session := SessionMeta{
		ID:        sessionID,
		Title:     "New Chat",
		CreatedAt: now,
		UpdatedAt: now,
		AgentType: agentType,
		Mode:      mode,
	}

	s.sessions = append([]SessionMeta{session}, s.sessions...)

	if err := s.persistIndex(); err != nil {
		s.sessions = s.sessions[1:]
		return SessionMeta{}, err
	}

	s.notifyChange(SessionChangeEvent{Op: OperationCreate, Session: session})
	return session, nil
}

func (s *FileStore) Delete(ctx context.Context, sessionID string) error {
	if err := ctx.Err(); err != nil {
		return err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	sessionDir := filepath.Join(s.dataDir, "sessions", sessionID)
	if err := os.RemoveAll(sessionDir); err != nil {
		return err
	}

	newSessions := make([]SessionMeta, 0, len(s.sessions))
	for _, sess := range s.sessions {
		if sess.ID != sessionID {
			newSessions = append(newSessions, sess)
		}
	}
	s.sessions = newSessions

	if err := s.persistIndex(); err != nil {
		return err
	}

	s.notifyChange(SessionChangeEvent{Op: OperationDelete, Session: SessionMeta{ID: sessionID}})
	return nil
}

// updateMeta applies a mutation to one session's metadata under the store lock.
// It persists and notifies only when apply reports an actual change, so callers
// that write the value a session already has cost nothing. An apply that
// rejects the write returns the error to the caller unchanged.
func (s *FileStore) updateMeta(ctx context.Context, sessionID string, apply func(*SessionMeta) (bool, error)) error {
	if err := ctx.Err(); err != nil {
		return err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	for i := range s.sessions {
		if s.sessions[i].ID != sessionID {
			continue
		}
		changed, err := apply(&s.sessions[i])
		if err != nil {
			return err
		}
		if !changed {
			return nil
		}
		if err := s.persistIndex(); err != nil {
			return err
		}
		s.notifyChange(SessionChangeEvent{Op: OperationUpdate, Session: s.sessions[i]})
		return nil
	}

	return ErrSessionNotFound
}

func (s *FileStore) Update(ctx context.Context, sessionID string, title string) error {
	return s.updateMeta(ctx, sessionID, func(meta *SessionMeta) (bool, error) {
		meta.Title = title
		meta.UpdatedAt = time.Now()
		return true, nil
	})
}

func (s *FileStore) Activate(ctx context.Context, sessionID string) error {
	return s.updateMeta(ctx, sessionID, func(meta *SessionMeta) (bool, error) {
		meta.Activated = true
		meta.UpdatedAt = time.Now()
		return true, nil
	})
}

func (s *FileStore) SetAgentType(ctx context.Context, sessionID string, agentType AgentType) error {
	return s.updateMeta(ctx, sessionID, func(meta *SessionMeta) (bool, error) {
		meta.AgentType = agentType
		// Models are agent-specific and no two agents share one, so a model
		// selected for the previous agent would only make the CLI fail to start.
		// Falling back to the empty model hands the choice back to the CLI.
		if !IsValidModel(agentType, meta.Model) {
			meta.Model = ""
		}
		// Same for effort: the levels are per agent and the new agent may not
		// offer the stored one — or may have no effort concept at all.
		if !IsValidEffort(agentType, meta.Effort) {
			meta.Effort = ""
		}
		meta.UpdatedAt = time.Now()
		return true, nil
	})
}

func (s *FileStore) SetMode(ctx context.Context, sessionID string, mode Mode) error {
	return s.updateMeta(ctx, sessionID, func(meta *SessionMeta) (bool, error) {
		meta.Mode = mode
		meta.UpdatedAt = time.Now()
		return true, nil
	})
}

// SetModel rejects a model the session's agent cannot run with
// (ErrModelNotAvailable). The check belongs here rather than in the caller: the
// agent type it has to be judged against is only stable under the store lock,
// so a caller that validated beforehand could still write a model the agent
// type it saw no longer has.
func (s *FileStore) SetModel(ctx context.Context, sessionID string, model string) error {
	return s.updateMeta(ctx, sessionID, func(meta *SessionMeta) (bool, error) {
		if !IsValidModel(meta.AgentType, model) {
			return false, fmt.Errorf("%w: model %q, agent %q", ErrModelNotAvailable, model, meta.AgentType)
		}
		meta.Model = model
		meta.UpdatedAt = time.Now()
		return true, nil
	})
}

// SetEffort rejects an effort level the session's agent does not offer
// (ErrEffortNotAvailable), for the same reason SetModel judges the model here:
// the agent type it has to be judged against is only stable under the store
// lock. The stored model is left alone — effort is validated per agent, not per
// model (see effort.go).
func (s *FileStore) SetEffort(ctx context.Context, sessionID string, effort string) error {
	return s.updateMeta(ctx, sessionID, func(meta *SessionMeta) (bool, error) {
		if !IsValidEffort(meta.AgentType, effort) {
			return false, fmt.Errorf("%w: effort %q, agent %q", ErrEffortNotAvailable, effort, meta.AgentType)
		}
		meta.Effort = effort
		meta.UpdatedAt = time.Now()
		return true, nil
	})
}

func (s *FileStore) SetNeedsInput(ctx context.Context, sessionID string, needsInput bool) error {
	return s.updateMeta(ctx, sessionID, func(meta *SessionMeta) (bool, error) {
		if meta.NeedsInput == needsInput {
			return false, nil
		}
		meta.NeedsInput = needsInput
		return true, nil
	})
}

func (s *FileStore) SetUnread(ctx context.Context, sessionID string, unread bool) error {
	return s.updateMeta(ctx, sessionID, func(meta *SessionMeta) (bool, error) {
		if meta.Unread == unread {
			return false, nil
		}
		meta.Unread = unread
		return true, nil
	})
}

func (s *FileStore) historyPath(sessionID string) string {
	return filepath.Join(s.dataDir, "sessions", sessionID, "history.jsonl")
}

func (s *FileStore) GetHistory(ctx context.Context, sessionID string) ([]json.RawMessage, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	// No lock: history lives in an independent per-session file reached via an
	// immutable path, and AppendToHistory writes it lock-free. Taking s.mu here
	// would only block metadata writers for the whole (potentially large) scan
	// without protecting anything.
	path := s.historyPath(sessionID)
	records, stats, err := filestore.ReadJSONL(path, filestore.DefaultMaxLineBytes)
	if err != nil {
		return nil, err
	}

	if stats.Damaged() {
		slog.Warn("session history has unreadable records",
			"sessionId", sessionID, "path", path,
			"corrupted", stats.Corrupted, "oversized", stats.Oversized)
		records = append(records, historyWarning(stats))
	}

	return records, nil
}

// historyWarning surfaces skipped records in the chat itself, so a user does
// not silently see a shorter history than what actually happened.
func historyWarning(stats filestore.JSONLStats) json.RawMessage {
	var parts []string
	if stats.Corrupted > 0 {
		parts = append(parts, fmt.Sprintf("%s damaged by an interrupted write", countEntries(stats.Corrupted)))
	}
	if stats.Oversized > 0 {
		parts = append(parts, fmt.Sprintf("%s too large to load", countEntries(stats.Oversized)))
	}

	code := "history_buffer_overflow"
	if stats.Corrupted > 0 {
		code = "history_corrupted"
	}

	// Marshaling a map of plain strings cannot fail.
	warning, _ := json.Marshal(map[string]string{
		"type":    "warning",
		"message": "Skipped " + strings.Join(parts, ", and "),
		"code":    code,
	})
	return warning
}

func countEntries(n int) string {
	if n == 1 {
		return "1 history entry"
	}
	return fmt.Sprintf("%d history entries", n)
}

func (s *FileStore) AppendToHistory(ctx context.Context, sessionID string, record any) error {
	if err := ctx.Err(); err != nil {
		return err
	}

	return filestore.AppendJSONL(s.historyPath(sessionID), record)
}

func (s *FileStore) Touch(ctx context.Context, sessionID string) error {
	return s.updateMeta(ctx, sessionID, func(meta *SessionMeta) (bool, error) {
		meta.UpdatedAt = time.Now()
		return true, nil
	})
}
