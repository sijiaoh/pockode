package ticket

import (
	"context"
	"testing"
)

func TestFileStore_CRUD(t *testing.T) {
	store, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}

	ctx := context.Background()

	t.Run("Create", func(t *testing.T) {
		ticket, err := store.Create(ctx, "", "Test Title", "Test Description", "role-1")
		if err != nil {
			t.Fatalf("Create: %v", err)
		}
		if ticket.ID == "" {
			t.Error("expected non-empty ID")
		}
		if ticket.Title != "Test Title" {
			t.Errorf("got title %q, want %q", ticket.Title, "Test Title")
		}
		if ticket.Status != TicketStatusOpen {
			t.Errorf("got status %q, want %q", ticket.Status, TicketStatusOpen)
		}
	})

	t.Run("List", func(t *testing.T) {
		tickets, err := store.List()
		if err != nil {
			t.Fatalf("List: %v", err)
		}
		if len(tickets) != 1 {
			t.Errorf("got %d tickets, want 1", len(tickets))
		}
	})

	t.Run("Get", func(t *testing.T) {
		tickets, _ := store.List()
		ticket, found, err := store.Get(tickets[0].ID)
		if err != nil {
			t.Fatalf("Get: %v", err)
		}
		if !found {
			t.Error("expected ticket to be found")
		}
		if ticket.Title != "Test Title" {
			t.Errorf("got title %q, want %q", ticket.Title, "Test Title")
		}
	})

	t.Run("Get not found", func(t *testing.T) {
		_, found, err := store.Get("nonexistent")
		if err != nil {
			t.Fatalf("Get: %v", err)
		}
		if found {
			t.Error("expected ticket not to be found")
		}
	})

	t.Run("Update", func(t *testing.T) {
		tickets, _ := store.List()
		newTitle := "Updated Title"
		newStatus := TicketStatusInProgress
		updated, err := store.Update(ctx, tickets[0].ID, TicketUpdate{
			Title:  &newTitle,
			Status: &newStatus,
		})
		if err != nil {
			t.Fatalf("Update: %v", err)
		}
		if updated.Title != newTitle {
			t.Errorf("got title %q, want %q", updated.Title, newTitle)
		}
		if updated.Status != newStatus {
			t.Errorf("got status %q, want %q", updated.Status, newStatus)
		}
	})

	t.Run("Update not found", func(t *testing.T) {
		newTitle := "New Title"
		_, err := store.Update(ctx, "nonexistent", TicketUpdate{Title: &newTitle})
		if err != ErrTicketNotFound {
			t.Errorf("got error %v, want %v", err, ErrTicketNotFound)
		}
	})

	t.Run("Delete", func(t *testing.T) {
		tickets, _ := store.List()
		err := store.Delete(ctx, tickets[0].ID)
		if err != nil {
			t.Fatalf("Delete: %v", err)
		}

		tickets, _ = store.List()
		if len(tickets) != 0 {
			t.Errorf("got %d tickets, want 0", len(tickets))
		}
	})

	t.Run("Delete not found", func(t *testing.T) {
		err := store.Delete(ctx, "nonexistent")
		if err != ErrTicketNotFound {
			t.Errorf("got error %v, want %v", err, ErrTicketNotFound)
		}
	})
}

func TestFileStore_Persistence(t *testing.T) {
	dataDir := t.TempDir()
	ctx := context.Background()

	store1, err := NewFileStore(dataDir)
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}

	_, err = store1.Create(ctx, "", "Persistent Ticket", "Description", "role-1")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	store2, err := NewFileStore(dataDir)
	if err != nil {
		t.Fatalf("NewFileStore (reload): %v", err)
	}

	tickets, err := store2.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(tickets) != 1 {
		t.Errorf("got %d tickets, want 1", len(tickets))
	}
	if tickets[0].Title != "Persistent Ticket" {
		t.Errorf("got title %q, want %q", tickets[0].Title, "Persistent Ticket")
	}
}

func TestFileStore_ChangeListener(t *testing.T) {
	store, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}

	ctx := context.Background()
	var events []TicketChangeEvent
	store.SetOnChangeListener(listenerFunc(func(e TicketChangeEvent) {
		events = append(events, e)
	}))

	ticket, _ := store.Create(ctx, "", "Test", "Desc", "role-1")
	newTitle := "Updated"
	store.Update(ctx, ticket.ID, TicketUpdate{Title: &newTitle})
	store.Delete(ctx, ticket.ID)

	if len(events) != 3 {
		t.Fatalf("got %d events, want 3", len(events))
	}
	if events[0].Op != OperationCreate {
		t.Errorf("event[0].Op = %v, want %v", events[0].Op, OperationCreate)
	}
	if events[1].Op != OperationUpdate {
		t.Errorf("event[1].Op = %v, want %v", events[1].Op, OperationUpdate)
	}
	if events[2].Op != OperationDelete {
		t.Errorf("event[2].Op = %v, want %v", events[2].Op, OperationDelete)
	}
}

type listenerFunc func(TicketChangeEvent)

func (f listenerFunc) OnTicketChange(e TicketChangeEvent) { f(e) }
