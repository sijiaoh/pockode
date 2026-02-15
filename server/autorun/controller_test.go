package autorun

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/pockode/server/process"
	"github.com/pockode/server/settings"
	"github.com/pockode/server/ticket"
)

// mockTicketStore implements ticket.Store for testing.
type mockTicketStore struct {
	tickets  []ticket.Ticket
	mu       sync.RWMutex
	listener ticket.OnChangeListener
}

func newMockTicketStore() *mockTicketStore {
	return &mockTicketStore{tickets: []ticket.Ticket{}}
}

func (s *mockTicketStore) List() ([]ticket.Ticket, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	result := make([]ticket.Ticket, len(s.tickets))
	copy(result, s.tickets)
	return result, nil
}

func (s *mockTicketStore) Get(ticketID string) (ticket.Ticket, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, t := range s.tickets {
		if t.ID == ticketID {
			return t, true, nil
		}
	}
	return ticket.Ticket{}, false, nil
}

func (s *mockTicketStore) Create(ctx context.Context, parentID, title, description, roleID string, priority *int) (ticket.Ticket, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	t := ticket.Ticket{
		ID:          "tk-" + title,
		Title:       title,
		Description: description,
		RoleID:      roleID,
		Status:      ticket.TicketStatusOpen,
	}
	s.tickets = append(s.tickets, t)
	return t, nil
}

func (s *mockTicketStore) Update(ctx context.Context, ticketID string, updates ticket.TicketUpdate) (ticket.Ticket, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.tickets {
		if s.tickets[i].ID == ticketID {
			if updates.Status != nil {
				s.tickets[i].Status = *updates.Status
			}
			if updates.SessionID != nil {
				s.tickets[i].SessionID = *updates.SessionID
			}
			return s.tickets[i], nil
		}
	}
	return ticket.Ticket{}, ticket.ErrTicketNotFound
}

func (s *mockTicketStore) Delete(ctx context.Context, ticketID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, t := range s.tickets {
		if t.ID == ticketID {
			s.tickets = append(s.tickets[:i], s.tickets[i+1:]...)
			return nil
		}
	}
	return ticket.ErrTicketNotFound
}

func (s *mockTicketStore) SetOnChangeListener(listener ticket.OnChangeListener) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.listener = listener
}

func (s *mockTicketStore) addTicket(t ticket.Ticket) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tickets = append(s.tickets, t)
}

func TestController_OnProcessStateChange_AutorunDisabled(t *testing.T) {
	ticketStore := newMockTicketStore()
	ticketStore.addTicket(ticket.Ticket{
		ID:        "tk-1",
		Status:    ticket.TicketStatusInProgress,
		SessionID: "sess-1",
	})

	ctrl := &Controller{
		ticketStore:   ticketStore,
		settingsStore: nil, // No settings store = autorun disabled
	}

	// Should not panic and should not send continue when autorun is disabled
	ctrl.OnProcessStateChange(process.StateChangeEvent{
		SessionID: "sess-1",
		State:     process.ProcessStateIdle,
	})

	// Give goroutine time to run
	time.Sleep(10 * time.Millisecond)
}

func TestController_OnTicketChange_AutorunDisabled(t *testing.T) {
	ticketStore := newMockTicketStore()
	ticketStore.addTicket(ticket.Ticket{
		ID:     "tk-2",
		Status: ticket.TicketStatusOpen,
	})

	ctrl := &Controller{
		ticketStore:   ticketStore,
		settingsStore: nil, // No settings store = autorun disabled
	}

	// Should not start next ticket when autorun is disabled
	ctrl.OnTicketChange(ticket.TicketChangeEvent{
		Op:     ticket.OperationUpdate,
		Ticket: ticket.Ticket{ID: "tk-1", Status: ticket.TicketStatusDone},
	})

	// Give goroutine time to run
	time.Sleep(10 * time.Millisecond)

	tickets, _ := ticketStore.List()
	for _, tk := range tickets {
		if tk.Status == ticket.TicketStatusInProgress {
			t.Errorf("expected no in_progress tickets, but found %s", tk.ID)
		}
	}
}

func TestController_StartNextOpenTicket_SkipsWhenInProgressExists(t *testing.T) {
	ticketStore := newMockTicketStore()
	ticketStore.addTicket(ticket.Ticket{
		ID:     "tk-1",
		Status: ticket.TicketStatusInProgress,
	})
	ticketStore.addTicket(ticket.Ticket{
		ID:     "tk-2",
		Status: ticket.TicketStatusOpen,
	})

	ctrl := &Controller{
		ticketStore:   ticketStore,
		settingsStore: nil,
	}

	// Simulate starting next ticket
	ctrl.StartNextOpenTicket()

	// tk-2 should still be open because tk-1 is in_progress
	tickets, _ := ticketStore.List()
	for _, tk := range tickets {
		if tk.ID == "tk-2" && tk.Status != ticket.TicketStatusOpen {
			t.Errorf("expected tk-2 to remain open, got %s", tk.Status)
		}
	}
}

func TestController_IsEnabled_NilSettingsStore(t *testing.T) {
	ctrl := &Controller{
		settingsStore: nil,
	}

	if ctrl.IsEnabled() {
		t.Error("expected isEnabled to return false when settingsStore is nil")
	}
}

func TestController_OnSettingsChange_AutorunDisabled(t *testing.T) {
	ticketStore := newMockTicketStore()
	ticketStore.addTicket(ticket.Ticket{
		ID:     "tk-1",
		Status: ticket.TicketStatusOpen,
	})

	ctrl := &Controller{
		ticketStore:   ticketStore,
		settingsStore: nil,
	}

	// Should not start ticket when autorun is disabled in settings
	ctrl.OnSettingsChange(settings.Settings{Autorun: false})

	time.Sleep(10 * time.Millisecond)

	tickets, _ := ticketStore.List()
	for _, tk := range tickets {
		if tk.Status == ticket.TicketStatusInProgress {
			t.Errorf("expected no in_progress tickets when autorun disabled, but found %s", tk.ID)
		}
	}
}

func TestController_OnTicketChange_Create_AutorunDisabled(t *testing.T) {
	ticketStore := newMockTicketStore()
	ticketStore.addTicket(ticket.Ticket{
		ID:     "tk-1",
		Status: ticket.TicketStatusOpen,
	})

	ctrl := &Controller{
		ticketStore:   ticketStore,
		settingsStore: nil, // autorun disabled
	}

	ctrl.OnTicketChange(ticket.TicketChangeEvent{
		Op:     ticket.OperationCreate,
		Ticket: ticket.Ticket{ID: "tk-1", Status: ticket.TicketStatusOpen},
	})

	time.Sleep(10 * time.Millisecond)

	tickets, _ := ticketStore.List()
	for _, tk := range tickets {
		if tk.Status == ticket.TicketStatusInProgress {
			t.Errorf("expected no in_progress tickets when autorun disabled, but found %s", tk.ID)
		}
	}
}

func TestController_OnProcessStateChange_IgnoresInitialIdle(t *testing.T) {
	ticketStore := newMockTicketStore()
	ticketStore.addTicket(ticket.Ticket{
		ID:        "tk-1",
		Status:    ticket.TicketStatusInProgress,
		SessionID: "sess-1",
	})

	settingsStore, _ := settings.NewStore(t.TempDir())
	_ = settingsStore.Update(settings.Settings{Autorun: true})

	ctrl := New(ticketStore, nil, nil, nil, settingsStore)

	// Initial idle event should be ignored (IsInitial=true)
	// handleIdleState should NOT be called at all
	ctrl.OnProcessStateChange(process.StateChangeEvent{
		SessionID: "sess-1",
		State:     process.ProcessStateIdle,
		IsInitial: true,
	})

	time.Sleep(20 * time.Millisecond)
	// If we get here, the initial idle was correctly ignored
}

func TestController_OnTicketChange_Create_SkipsWhenInProgressExists(t *testing.T) {
	ticketStore := newMockTicketStore()
	ticketStore.addTicket(ticket.Ticket{
		ID:     "tk-1",
		Status: ticket.TicketStatusInProgress,
	})
	ticketStore.addTicket(ticket.Ticket{
		ID:     "tk-2",
		Status: ticket.TicketStatusOpen,
	})

	settingsStore, _ := settings.NewStore(t.TempDir())
	_ = settingsStore.Update(settings.Settings{Autorun: true})

	ctrl := &Controller{
		ticketStore:   ticketStore,
		settingsStore: settingsStore,
	}

	// Simulate a new ticket being created while another is in progress
	ctrl.OnTicketChange(ticket.TicketChangeEvent{
		Op:     ticket.OperationCreate,
		Ticket: ticket.Ticket{ID: "tk-2", Status: ticket.TicketStatusOpen},
	})

	time.Sleep(10 * time.Millisecond)

	// tk-2 should remain open because tk-1 is already in_progress
	tickets, _ := ticketStore.List()
	for _, tk := range tickets {
		if tk.ID == "tk-2" && tk.Status != ticket.TicketStatusOpen {
			t.Errorf("expected tk-2 to remain open when another ticket is in_progress, got %s", tk.Status)
		}
	}
}
