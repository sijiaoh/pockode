package ticket

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

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
}

// NewFileStore creates a new file-based ticket store.
func NewFileStore(dataDir string) (*FileStore, error) {
	ticketsDir := filepath.Join(dataDir, "tickets")
	if err := os.MkdirAll(ticketsDir, 0755); err != nil {
		return nil, err
	}

	store := &FileStore{dataDir: dataDir}

	idx, err := store.readIndexFromDisk()
	if err != nil {
		return nil, err
	}
	store.tickets = idx.Tickets

	return store, nil
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
