package ticket

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/google/uuid"
)

var (
	ErrTicketNotFound = errors.New("ticket not found")
	ErrRoleNotFound   = errors.New("role not found")
)

// Store defines ticket operations (RPC/MCP agnostic).
type Store interface {
	List() ([]Ticket, error)
	Get(ticketID string) (Ticket, bool, error)
	Create(ctx context.Context, parentID, title, description, roleID string) (Ticket, error)
	Update(ctx context.Context, ticketID string, updates TicketUpdate) (Ticket, error)
	Delete(ctx context.Context, ticketID string) error
	SetOnChangeListener(listener OnChangeListener)
}

// TicketUpdate contains optional fields to update.
type TicketUpdate struct {
	Title       *string       `json:"title,omitempty"`
	Description *string       `json:"description,omitempty"`
	Status      *TicketStatus `json:"status,omitempty"`
	SessionID   *string       `json:"session_id,omitempty"`
}

type indexData struct {
	Tickets []Ticket `json:"tickets"`
}

// FileStore implements Store with file-based persistence.
type FileStore struct {
	dataDir  string
	mu       sync.RWMutex
	tickets  []Ticket
	listener OnChangeListener

	watcher   *fsnotify.Watcher
	stopCh    chan struct{}
	lastWrite time.Time // To ignore self-triggered events
	writingMu sync.Mutex
}

// NewFileStore creates a new file-based ticket store.
func NewFileStore(dataDir string) (*FileStore, error) {
	ticketsDir := filepath.Join(dataDir, "tickets")
	if err := os.MkdirAll(ticketsDir, 0755); err != nil {
		return nil, err
	}

	store := &FileStore{
		dataDir: dataDir,
		stopCh:  make(chan struct{}),
	}

	idx, err := store.readIndexFromDisk()
	if err != nil {
		return nil, err
	}
	store.tickets = idx.Tickets

	// Start file watcher for external changes (e.g., from MCP)
	if err := store.startWatcher(); err != nil {
		slog.Warn("failed to start ticket file watcher", "error", err)
	}

	return store, nil
}

func (s *FileStore) startWatcher() error {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return err
	}
	s.watcher = watcher

	// Watch the tickets directory
	ticketsDir := filepath.Join(s.dataDir, "tickets")
	if err := watcher.Add(ticketsDir); err != nil {
		watcher.Close()
		return err
	}

	go s.watchLoop()
	slog.Info("ticket file watcher started", "path", ticketsDir)
	return nil
}

func (s *FileStore) watchLoop() {
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
			// Only care about index.json writes
			if filepath.Base(event.Name) != "index.json" {
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
			slog.Warn("ticket file watcher error", "error", err)
		}
	}
}

func (s *FileStore) reloadFromDisk() {
	idx, err := s.readIndexFromDisk()
	if err != nil {
		slog.Error("failed to reload tickets from disk", "error", err)
		return
	}

	s.mu.Lock()
	oldTickets := s.tickets
	s.tickets = idx.Tickets
	s.mu.Unlock()

	// Compute and notify changes
	s.notifyExternalChanges(oldTickets, idx.Tickets)
	slog.Debug("tickets reloaded from disk", "count", len(idx.Tickets))
}

func (s *FileStore) notifyExternalChanges(oldTickets, newTickets []Ticket) {
	oldMap := make(map[string]Ticket)
	for _, t := range oldTickets {
		oldMap[t.ID] = t
	}

	newMap := make(map[string]Ticket)
	for _, t := range newTickets {
		newMap[t.ID] = t
	}

	// Find created and updated
	for _, t := range newTickets {
		old, exists := oldMap[t.ID]
		if !exists {
			s.notifyChange(TicketChangeEvent{Op: OperationCreate, Ticket: t})
		} else if t.UpdatedAt != old.UpdatedAt {
			s.notifyChange(TicketChangeEvent{Op: OperationUpdate, Ticket: t})
		}
	}

	// Find deleted
	for _, t := range oldTickets {
		if _, exists := newMap[t.ID]; !exists {
			s.notifyChange(TicketChangeEvent{Op: OperationDelete, Ticket: t})
		}
	}
}

// Stop is safe to call multiple times.
func (s *FileStore) Stop() {
	if s.watcher == nil {
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

func (s *FileStore) indexPath() string {
	return filepath.Join(s.dataDir, "tickets", "index.json")
}

func (s *FileStore) readIndexFromDisk() (indexData, error) {
	data, err := os.ReadFile(s.indexPath())
	if os.IsNotExist(err) {
		return indexData{Tickets: []Ticket{}}, nil
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
	idx := indexData{Tickets: s.tickets}
	data, err := json.MarshalIndent(idx, "", "  ")
	if err != nil {
		return err
	}

	// Mark as self-write to ignore the fsnotify event
	s.writingMu.Lock()
	s.lastWrite = time.Now()
	s.writingMu.Unlock()

	return os.WriteFile(s.indexPath(), data, 0644)
}

func (s *FileStore) SetOnChangeListener(listener OnChangeListener) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.listener = listener
}

func (s *FileStore) notifyChange(event TicketChangeEvent) {
	if s.listener != nil {
		s.listener.OnTicketChange(event)
	}
}

func (s *FileStore) List() ([]Ticket, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	result := make([]Ticket, len(s.tickets))
	copy(result, s.tickets)

	sort.Slice(result, func(i, j int) bool {
		return result[i].UpdatedAt.After(result[j].UpdatedAt)
	})

	return result, nil
}

func (s *FileStore) Get(ticketID string) (Ticket, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	for _, t := range s.tickets {
		if t.ID == ticketID {
			return t, true, nil
		}
	}
	return Ticket{}, false, nil
}

func (s *FileStore) Create(ctx context.Context, parentID, title, description, roleID string) (Ticket, error) {
	if err := ctx.Err(); err != nil {
		return Ticket{}, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now()
	ticket := Ticket{
		ID:          uuid.New().String(),
		ParentID:    parentID,
		Title:       title,
		Description: description,
		RoleID:      roleID,
		Status:      TicketStatusOpen,
		CreatedAt:   now,
		UpdatedAt:   now,
	}

	s.tickets = append([]Ticket{ticket}, s.tickets...)

	if err := s.persistIndex(); err != nil {
		s.tickets = s.tickets[1:]
		return Ticket{}, err
	}

	s.notifyChange(TicketChangeEvent{Op: OperationCreate, Ticket: ticket})
	return ticket, nil
}

func (s *FileStore) Update(ctx context.Context, ticketID string, updates TicketUpdate) (Ticket, error) {
	if err := ctx.Err(); err != nil {
		return Ticket{}, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	for i := range s.tickets {
		if s.tickets[i].ID == ticketID {
			old := s.tickets[i]

			if updates.Title != nil {
				s.tickets[i].Title = *updates.Title
			}
			if updates.Description != nil {
				s.tickets[i].Description = *updates.Description
			}
			if updates.Status != nil {
				s.tickets[i].Status = *updates.Status
			}
			if updates.SessionID != nil {
				s.tickets[i].SessionID = *updates.SessionID
			}
			s.tickets[i].UpdatedAt = time.Now()

			if err := s.persistIndex(); err != nil {
				s.tickets[i] = old
				return Ticket{}, err
			}

			s.notifyChange(TicketChangeEvent{Op: OperationUpdate, Ticket: s.tickets[i]})
			return s.tickets[i], nil
		}
	}

	return Ticket{}, ErrTicketNotFound
}

func (s *FileStore) Delete(ctx context.Context, ticketID string) error {
	if err := ctx.Err(); err != nil {
		return err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	var deleted Ticket
	newTickets := make([]Ticket, 0, len(s.tickets))
	for _, t := range s.tickets {
		if t.ID != ticketID {
			newTickets = append(newTickets, t)
		} else {
			deleted = t
		}
	}

	if len(newTickets) == len(s.tickets) {
		return ErrTicketNotFound
	}

	s.tickets = newTickets

	if err := s.persistIndex(); err != nil {
		return err
	}

	s.notifyChange(TicketChangeEvent{Op: OperationDelete, Ticket: deleted})
	return nil
}
