package session

import (
	"bytes"
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
	// CreateFork creates a session that begins life as a copy of another one.
	CreateFork(ctx context.Context, sessionID string, fork ForkSpec) (SessionMeta, error)
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
	// AppendToHistory appends a JSON-serializable record to history (does not
	// update timestamp) and returns the record's sequence number: its 1-based
	// position in the history GetHistory returns. Sending that number to clients
	// is the only way they can name a record — see HistorySeq.
	AppendToHistory(ctx context.Context, sessionID string, record any) (HistorySeq, error)
	// WriteHistory replaces a session's whole history with records.
	//
	// For a session nothing is streaming to yet — a fork's copied history, written
	// once rather than appended record by record. It does not coordinate with
	// AppendToHistory, so it must not be called on a session that has a live
	// process.
	WriteHistory(ctx context.Context, sessionID string, records []json.RawMessage) error
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

	// historyMu guards historyLen and is held across the append itself, so two
	// concurrent appends cannot take sequence numbers in one order and reach the
	// file in the other — which would make a sequence number name the wrong
	// record.
	//
	// Lock order is mu then historyMu (Delete takes both). Never take mu while
	// holding this one.
	historyMu  sync.Mutex
	historyLen map[string]int // sessionID -> records written so far
}

func NewFileStore(dataDir string) (*FileStore, error) {
	sessionsDir := filepath.Join(dataDir, "sessions")
	if err := os.MkdirAll(sessionsDir, 0755); err != nil {
		return nil, err
	}

	store := &FileStore{dataDir: dataDir, historyLen: make(map[string]int)}

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

	if err := s.insertLocked(session); err != nil {
		return SessionMeta{}, err
	}
	return session, nil
}

// insertLocked puts a new session at the front of the list, persists the index and
// announces it, restoring the in-memory list if the write fails. Caller must hold mu.
func (s *FileStore) insertLocked(session SessionMeta) error {
	s.sessions = append([]SessionMeta{session}, s.sessions...)

	if err := s.persistIndex(); err != nil {
		s.sessions = s.sessions[1:]
		return err
	}

	s.notifyChange(SessionChangeEvent{Op: OperationCreate, Session: session})
	return nil
}

func (s *FileStore) CreateFork(ctx context.Context, sessionID string, fork ForkSpec) (SessionMeta, error) {
	if err := ctx.Err(); err != nil {
		return SessionMeta{}, err
	}

	title := fork.Title
	if title == "" {
		title = fork.Source.Title
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now()
	session := SessionMeta{
		ID:        sessionID,
		Title:     title,
		CreatedAt: now,
		UpdatedAt: now,
		Activated: fork.Activated,
		// The engine choice — agent, mode, model, effort — is inherited rather
		// than taken from the defaults: a conversation that continued under a
		// different agent would not be a fork of this one.
		AgentType:  fork.Source.AgentType,
		Mode:       fork.Source.Mode,
		Model:      fork.Source.Model,
		Effort:     fork.Source.Effort,
		ForkedFrom: &ForkOrigin{SessionID: fork.Source.ID},
	}

	if err := s.insertLocked(session); err != nil {
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

	s.historyMu.Lock()
	delete(s.historyLen, sessionID)
	s.historyMu.Unlock()

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
//
// It carries seq 0 because it is not in the file: nothing can be resolved back to
// it, and leaving it to be numbered by position would hand out an address that the
// next real append also gets — the client would then name a record it never saw.
// StampHistorySeq leaves an existing seq alone, and this record is only ever
// appended last, so the records before it keep their positions.
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

	// Marshaling plain strings and an int cannot fail.
	warning, _ := json.Marshal(map[string]any{
		"type":    "warning",
		"message": "Skipped " + strings.Join(parts, ", and "),
		"code":    code,
		"seq":     NoHistorySeq,
	})
	return warning
}

func countEntries(n int) string {
	if n == 1 {
		return "1 history entry"
	}
	return fmt.Sprintf("%d history entries", n)
}

func (s *FileStore) AppendToHistory(ctx context.Context, sessionID string, record any) (HistorySeq, error) {
	if err := ctx.Err(); err != nil {
		return NoHistorySeq, err
	}

	s.historyMu.Lock()
	defer s.historyMu.Unlock()

	written, err := s.historyLenLocked(sessionID)
	if err != nil {
		return NoHistorySeq, err
	}

	if err := filestore.AppendJSONL(s.historyPath(sessionID), record); err != nil {
		return NoHistorySeq, err
	}

	s.historyLen[sessionID] = written + 1
	return HistorySeq(written + 1), nil
}

// historyLenLocked returns how many records the session's history holds,
// counting them off disk the first time it is asked. Caller must hold historyMu.
//
// It counts what GetHistory returns rather than lines in the file, so a record a
// crash damaged — which GetHistory skips — does not shift every later sequence
// number by one against the history the client was given. The count is seeded
// once because only this process appends to it afterwards.
func (s *FileStore) historyLenLocked(sessionID string) (int, error) {
	if written, ok := s.historyLen[sessionID]; ok {
		return written, nil
	}

	records, _, err := filestore.ReadJSONL(s.historyPath(sessionID), filestore.DefaultMaxLineBytes)
	if err != nil {
		return 0, err
	}
	s.historyLen[sessionID] = len(records)
	return len(records), nil
}

func (s *FileStore) WriteHistory(ctx context.Context, sessionID string, records []json.RawMessage) error {
	if err := ctx.Err(); err != nil {
		return err
	}

	var buf bytes.Buffer
	for i, record := range records {
		// Compacted rather than copied through: one record per line is the file
		// format, and a record carrying a newline would silently become two lines
		// neither of which parses.
		if err := json.Compact(&buf, record); err != nil {
			return fmt.Errorf("history record %d is not valid JSON: %w", i, err)
		}
		buf.WriteByte('\n')
	}

	s.historyMu.Lock()
	defer s.historyMu.Unlock()

	if err := filestore.WriteFileAtomic(s.historyPath(sessionID), buf.Bytes(), 0644); err != nil {
		return err
	}

	s.historyLen[sessionID] = len(records)
	return nil
}

func (s *FileStore) Touch(ctx context.Context, sessionID string) error {
	return s.updateMeta(ctx, sessionID, func(meta *SessionMeta) (bool, error) {
		meta.UpdatedAt = time.Now()
		return true, nil
	})
}
