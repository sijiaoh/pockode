package session

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
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

	// History persistence
	GetHistory(ctx context.Context, sessionID string) ([]json.RawMessage, error)
	AppendToHistory(ctx context.Context, sessionID string, record any) error
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

func (s *FileStore) List() ([]SessionMeta, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	// Return a copy to prevent external mutation
	result := make([]SessionMeta, len(s.sessions))
	copy(result, s.sessions)
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
	}

	s.sessions = append([]SessionMeta{session}, s.sessions...)

	if err := s.persistIndex(); err != nil {
		s.sessions = s.sessions[1:]
		return SessionMeta{}, err
	}
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

	return s.persistIndex()
}

func (s *FileStore) Update(ctx context.Context, sessionID string, title string) error {
	if err := ctx.Err(); err != nil {
		return err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now()
	for i, sess := range s.sessions {
		if sess.ID == sessionID {
			s.sessions[i].Title = title
			s.sessions[i].UpdatedAt = now
			return s.persistIndex()
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

	for i, sess := range s.sessions {
		if sess.ID == sessionID {
			s.sessions[i].Activated = true
			s.sessions[i].UpdatedAt = time.Now()
			return s.persistIndex()
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
		return nil, err
	}

	return records, nil
}

func (s *FileStore) AppendToHistory(ctx context.Context, sessionID string, record any) error {
	if err := ctx.Err(); err != nil {
		return err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

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
