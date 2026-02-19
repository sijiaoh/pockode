package session

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

type Store interface {
	// Session metadata (memory only)
	List() ([]SessionMeta, error)
	Get(sessionID string) (SessionMeta, bool, error)

	// Session metadata (with I/O)
	Create(ctx context.Context, sessionID string) (SessionMeta, error)
	Delete(ctx context.Context, sessionID string) error
	Update(ctx context.Context, sessionID string, title string) error
	Activate(ctx context.Context, sessionID string) error
	SetMode(ctx context.Context, sessionID string, mode Mode) error
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
	data, err := os.ReadFile(s.indexPath())
	if os.IsNotExist(err) {
		return indexData{Sessions: []SessionMeta{}}, nil
	}
	if err != nil {
		return indexData{}, err
	}

	var idx indexData
	if err := json.Unmarshal(data, &idx); err != nil {
		return indexData{}, err
	}

	// Migrate: ensure all sessions have a valid mode
	for i := range idx.Sessions {
		if idx.Sessions[i].Mode == "" {
			idx.Sessions[i].Mode = ModeDefault
		}
	}

	return idx, nil
}

func (s *FileStore) persistIndex() error {
	idx := indexData{Sessions: s.sessions}
	data, err := json.MarshalIndent(idx, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.indexPath(), data, 0644)
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

func (s *FileStore) Create(ctx context.Context, sessionID string) (SessionMeta, error) {
	if err := ctx.Err(); err != nil {
		return SessionMeta{}, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now()
	session := SessionMeta{
		ID:        sessionID,
		Title:     "New Chat",
		CreatedAt: now,
		UpdatedAt: now,
		Mode:      ModeDefault,
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

func (s *FileStore) Update(ctx context.Context, sessionID string, title string) error {
	if err := ctx.Err(); err != nil {
		return err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now()
	for i := range s.sessions {
		if s.sessions[i].ID == sessionID {
			s.sessions[i].Title = title
			s.sessions[i].UpdatedAt = now
			if err := s.persistIndex(); err != nil {
				return err
			}
			s.notifyChange(SessionChangeEvent{Op: OperationUpdate, Session: s.sessions[i]})
			return nil
		}
	}

	return ErrSessionNotFound
}

func (s *FileStore) Activate(ctx context.Context, sessionID string) error {
	if err := ctx.Err(); err != nil {
		return err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	for i := range s.sessions {
		if s.sessions[i].ID == sessionID {
			s.sessions[i].Activated = true
			s.sessions[i].UpdatedAt = time.Now()
			if err := s.persistIndex(); err != nil {
				return err
			}
			s.notifyChange(SessionChangeEvent{Op: OperationUpdate, Session: s.sessions[i]})
			return nil
		}
	}

	return ErrSessionNotFound
}

func (s *FileStore) SetMode(ctx context.Context, sessionID string, mode Mode) error {
	if err := ctx.Err(); err != nil {
		return err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	for i := range s.sessions {
		if s.sessions[i].ID == sessionID {
			s.sessions[i].Mode = mode
			s.sessions[i].UpdatedAt = time.Now()
			if err := s.persistIndex(); err != nil {
				return err
			}
			s.notifyChange(SessionChangeEvent{Op: OperationUpdate, Session: s.sessions[i]})
			return nil
		}
	}

	return ErrSessionNotFound
}

func (s *FileStore) SetNeedsInput(ctx context.Context, sessionID string, needsInput bool) error {
	if err := ctx.Err(); err != nil {
		return err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	for i := range s.sessions {
		if s.sessions[i].ID == sessionID {
			if s.sessions[i].NeedsInput == needsInput {
				return nil
			}
			s.sessions[i].NeedsInput = needsInput
			if err := s.persistIndex(); err != nil {
				return err
			}
			s.notifyChange(SessionChangeEvent{Op: OperationUpdate, Session: s.sessions[i]})
			return nil
		}
	}

	return ErrSessionNotFound
}

func (s *FileStore) SetUnread(ctx context.Context, sessionID string, unread bool) error {
	if err := ctx.Err(); err != nil {
		return err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	for i := range s.sessions {
		if s.sessions[i].ID == sessionID {
			if s.sessions[i].Unread == unread {
				return nil
			}
			s.sessions[i].Unread = unread
			if err := s.persistIndex(); err != nil {
				return err
			}
			s.notifyChange(SessionChangeEvent{Op: OperationUpdate, Session: s.sessions[i]})
			return nil
		}
	}

	return ErrSessionNotFound
}

func (s *FileStore) historyPath(sessionID string) string {
	return filepath.Join(s.dataDir, "sessions", sessionID, "history.jsonl")
}

func (s *FileStore) GetHistory(ctx context.Context, sessionID string) ([]json.RawMessage, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	s.mu.RLock()
	defer s.mu.RUnlock()

	path := s.historyPath(sessionID)
	file, err := os.Open(path)
	if os.IsNotExist(err) {
		return []json.RawMessage{}, nil
	}
	if err != nil {
		return nil, err
	}
	defer file.Close()

	var records []json.RawMessage
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024) // Match CLI output buffer size
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		// Make a copy since scanner reuses the buffer
		record := make(json.RawMessage, len(line))
		copy(record, line)
		records = append(records, record)
	}

	if err := scanner.Err(); err != nil {
		if errors.Is(err, bufio.ErrTooLong) {
			// Buffer overflow: append warning and return partial results
			warning := map[string]string{
				"type":    "warning",
				"message": "Some history entries were too large to load",
				"code":    "history_buffer_overflow",
			}
			warningJSON, _ := json.Marshal(warning)
			records = append(records, warningJSON)
			return records, nil
		}
		return nil, err
	}

	return records, nil
}

func (s *FileStore) AppendToHistory(ctx context.Context, sessionID string, record any) error {
	if err := ctx.Err(); err != nil {
		return err
	}

	path := s.historyPath(sessionID)

	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}

	file, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return err
	}
	defer file.Close()

	data, err := json.Marshal(record)
	if err != nil {
		return err
	}

	data = append(data, '\n')
	_, err = file.Write(data)
	return err
}

func (s *FileStore) Touch(ctx context.Context, sessionID string) error {
	if err := ctx.Err(); err != nil {
		return err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	idx := -1
	for i, sess := range s.sessions {
		if sess.ID == sessionID {
			idx = i
			break
		}
	}
	if idx < 0 {
		return ErrSessionNotFound
	}

	s.sessions[idx].UpdatedAt = time.Now()
	if err := s.persistIndex(); err != nil {
		return err
	}
	s.notifyChange(SessionChangeEvent{Op: OperationUpdate, Session: s.sessions[idx]})
	return nil
}
