package session

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Store defines operations for session management.
type Store interface {
	// Session metadata
	List() ([]SessionMeta, error)
	Get(sessionID string) (SessionMeta, bool, error)
	Create(sessionID string) (SessionMeta, error)
	Delete(sessionID string) error
	Update(sessionID string, title string) error
	Activate(sessionID string) error

	// History persistence
	GetHistory(sessionID string) ([]json.RawMessage, error)
	AppendToHistory(sessionID string, record any) error
}

// indexData is the structure of index.json.
type indexData struct {
	Sessions []SessionMeta `json:"sessions"`
}

// FileStore implements Store using file system storage.
type FileStore struct {
	dataDir string
	mu      sync.RWMutex
}

// NewFileStore creates a new FileStore with the given data directory.
func NewFileStore(dataDir string) (*FileStore, error) {
	sessionsDir := filepath.Join(dataDir, "sessions")
	if err := os.MkdirAll(sessionsDir, 0755); err != nil {
		return nil, err
	}
	return &FileStore{dataDir: dataDir}, nil
}

func (s *FileStore) indexPath() string {
	return filepath.Join(s.dataDir, "sessions", "index.json")
}

func (s *FileStore) readIndex() (indexData, error) {
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

func (s *FileStore) writeIndex(idx indexData) error {
	data, err := json.MarshalIndent(idx, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.indexPath(), data, 0644)
}

// List returns all sessions sorted by updated_at (newest first).
func (s *FileStore) List() ([]SessionMeta, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	idx, err := s.readIndex()
	if err != nil {
		return nil, err
	}
	return idx.Sessions, nil
}

// Get returns a session by ID. Returns (session, found, error).
func (s *FileStore) Get(sessionID string) (SessionMeta, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	idx, err := s.readIndex()
	if err != nil {
		return SessionMeta{}, false, err
	}

	for _, sess := range idx.Sessions {
		if sess.ID == sessionID {
			return sess, true, nil
		}
	}
	return SessionMeta{}, false, nil
}

// Create creates a new session with the given ID and default title.
func (s *FileStore) Create(sessionID string) (SessionMeta, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	idx, err := s.readIndex()
	if err != nil {
		return SessionMeta{}, err
	}

	now := time.Now()
	session := SessionMeta{
		ID:        sessionID,
		Title:     "New Chat",
		CreatedAt: now,
		UpdatedAt: now,
	}

	// Prepend new session (newest first)
	idx.Sessions = append([]SessionMeta{session}, idx.Sessions...)

	if err := s.writeIndex(idx); err != nil {
		return SessionMeta{}, err
	}
	return session, nil
}

// Delete removes a session by ID, including its history.
func (s *FileStore) Delete(sessionID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Delete session directory (includes history)
	sessionDir := filepath.Join(s.dataDir, "sessions", sessionID)
	if err := os.RemoveAll(sessionDir); err != nil {
		return err
	}

	// Update index
	idx, err := s.readIndex()
	if err != nil {
		return err
	}

	newSessions := make([]SessionMeta, 0, len(idx.Sessions))
	for _, sess := range idx.Sessions {
		if sess.ID != sessionID {
			newSessions = append(newSessions, sess)
		}
	}
	idx.Sessions = newSessions

	return s.writeIndex(idx)
}

// Update updates a session's title by ID.
// Returns ErrSessionNotFound if the session does not exist.
func (s *FileStore) Update(sessionID string, title string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	idx, err := s.readIndex()
	if err != nil {
		return err
	}

	now := time.Now()
	for i, sess := range idx.Sessions {
		if sess.ID == sessionID {
			idx.Sessions[i].Title = title
			idx.Sessions[i].UpdatedAt = now
			return s.writeIndex(idx)
		}
	}

	return ErrSessionNotFound
}

// Activate marks a session as activated (first message sent).
// Returns ErrSessionNotFound if the session does not exist.
func (s *FileStore) Activate(sessionID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	idx, err := s.readIndex()
	if err != nil {
		return err
	}

	for i, sess := range idx.Sessions {
		if sess.ID == sessionID {
			idx.Sessions[i].Activated = true
			idx.Sessions[i].UpdatedAt = time.Now()
			return s.writeIndex(idx)
		}
	}

	return ErrSessionNotFound
}

func (s *FileStore) historyPath(sessionID string) string {
	return filepath.Join(s.dataDir, "sessions", sessionID, "history.jsonl")
}

// GetHistory reads all history records from the session's JSONL file.
func (s *FileStore) GetHistory(sessionID string) ([]json.RawMessage, error) {
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

// AppendToHistory appends a record to the session's history JSONL file.
func (s *FileStore) AppendToHistory(sessionID string, record any) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	path := s.historyPath(sessionID)

	// Ensure directory exists
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}

	// Open file for appending
	file, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return err
	}
	defer file.Close()

	// Marshal and write record
	data, err := json.Marshal(record)
	if err != nil {
		return err
	}

	data = append(data, '\n')
	_, err = file.Write(data)
	return err
}
