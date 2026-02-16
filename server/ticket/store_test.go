package ticket

import (
	"context"
	"testing"
	"time"
)

func TestFileStore_CRUD(t *testing.T) {
	store, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}

	ctx := context.Background()

	t.Run("Create", func(t *testing.T) {
		ticket, err := store.Create(ctx, "", "Test Title", "Test Description", "role-1", nil)
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
		if ticket.Priority != 0 {
			t.Errorf("got priority %d, want 0 for first ticket", ticket.Priority)
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

	t.Run("DeleteByStatus", func(t *testing.T) {
		store2, _ := NewFileStore(t.TempDir())
		store2.Create(ctx, "", "Open 1", "", "role-1", nil)
		store2.Create(ctx, "", "Open 2", "", "role-1", nil)
		t3, _ := store2.Create(ctx, "", "Done", "", "role-1", nil)
		done := TicketStatusDone
		store2.Update(ctx, t3.ID, TicketUpdate{Status: &done})

		count, err := store2.DeleteByStatus(ctx, TicketStatusOpen)
		if err != nil {
			t.Fatalf("DeleteByStatus: %v", err)
		}
		if count != 2 {
			t.Errorf("deleted count = %d, want 2", count)
		}

		tickets, _ := store2.List()
		if len(tickets) != 1 {
			t.Errorf("remaining tickets = %d, want 1", len(tickets))
		}
		if tickets[0].Status != TicketStatusDone {
			t.Errorf("remaining ticket status = %v, want %v", tickets[0].Status, TicketStatusDone)
		}
	})

	t.Run("DeleteByStatus no match", func(t *testing.T) {
		store3, _ := NewFileStore(t.TempDir())
		store3.Create(ctx, "", "Open", "", "role-1", nil)

		count, err := store3.DeleteByStatus(ctx, TicketStatusDone)
		if err != nil {
			t.Fatalf("DeleteByStatus: %v", err)
		}
		if count != 0 {
			t.Errorf("deleted count = %d, want 0", count)
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

	_, err = store1.Create(ctx, "", "Persistent Ticket", "Description", "role-1", nil)
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

	ticket, _ := store.Create(ctx, "", "Test", "Desc", "role-1", nil)
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

func TestFileStore_notifyExternalChanges(t *testing.T) {
	store, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}

	var events []TicketChangeEvent
	store.SetOnChangeListener(listenerFunc(func(e TicketChangeEvent) {
		events = append(events, e)
	}))

	t.Run("Detect created tickets", func(t *testing.T) {
		events = nil
		oldTickets := []Ticket{}
		newTickets := []Ticket{{ID: "t1", Title: "New"}}

		store.notifyExternalChanges(oldTickets, newTickets)

		if len(events) != 1 {
			t.Fatalf("got %d events, want 1", len(events))
		}
		if events[0].Op != OperationCreate {
			t.Errorf("Op = %v, want %v", events[0].Op, OperationCreate)
		}
		if events[0].Ticket.ID != "t1" {
			t.Errorf("Ticket.ID = %q, want %q", events[0].Ticket.ID, "t1")
		}
	})

	t.Run("Detect deleted tickets", func(t *testing.T) {
		events = nil
		oldTickets := []Ticket{{ID: "t1", Title: "Old"}}
		newTickets := []Ticket{}

		store.notifyExternalChanges(oldTickets, newTickets)

		if len(events) != 1 {
			t.Fatalf("got %d events, want 1", len(events))
		}
		if events[0].Op != OperationDelete {
			t.Errorf("Op = %v, want %v", events[0].Op, OperationDelete)
		}
		if events[0].Ticket.ID != "t1" {
			t.Errorf("Ticket.ID = %q, want %q", events[0].Ticket.ID, "t1")
		}
	})

	t.Run("Detect updated tickets", func(t *testing.T) {
		events = nil
		now := time.Now()
		oldTickets := []Ticket{{ID: "t1", Title: "Old", UpdatedAt: now}}
		newTickets := []Ticket{{ID: "t1", Title: "Updated", UpdatedAt: now.Add(time.Second)}}

		store.notifyExternalChanges(oldTickets, newTickets)

		if len(events) != 1 {
			t.Fatalf("got %d events, want 1", len(events))
		}
		if events[0].Op != OperationUpdate {
			t.Errorf("Op = %v, want %v", events[0].Op, OperationUpdate)
		}
		if events[0].Ticket.Title != "Updated" {
			t.Errorf("Ticket.Title = %q, want %q", events[0].Ticket.Title, "Updated")
		}
	})

	t.Run("No event when unchanged", func(t *testing.T) {
		events = nil
		now := time.Now()
		tickets := []Ticket{{ID: "t1", Title: "Same", UpdatedAt: now}}

		store.notifyExternalChanges(tickets, tickets)

		if len(events) != 0 {
			t.Errorf("got %d events, want 0", len(events))
		}
	})

	t.Run("Mixed create, update, delete", func(t *testing.T) {
		events = nil
		now := time.Now()
		oldTickets := []Ticket{
			{ID: "stay", Title: "Unchanged", UpdatedAt: now},
			{ID: "update", Title: "Before", UpdatedAt: now},
			{ID: "delete", Title: "ToDelete", UpdatedAt: now},
		}
		newTickets := []Ticket{
			{ID: "stay", Title: "Unchanged", UpdatedAt: now},
			{ID: "update", Title: "After", UpdatedAt: now.Add(time.Second)},
			{ID: "create", Title: "Created", UpdatedAt: now},
		}

		store.notifyExternalChanges(oldTickets, newTickets)

		if len(events) != 3 {
			t.Fatalf("got %d events, want 3", len(events))
		}

		opCount := map[Operation]int{}
		for _, e := range events {
			opCount[e.Op]++
		}
		if opCount[OperationCreate] != 1 {
			t.Errorf("create count = %d, want 1", opCount[OperationCreate])
		}
		if opCount[OperationUpdate] != 1 {
			t.Errorf("update count = %d, want 1", opCount[OperationUpdate])
		}
		if opCount[OperationDelete] != 1 {
			t.Errorf("delete count = %d, want 1", opCount[OperationDelete])
		}
	})
}

func TestFileStore_Priority(t *testing.T) {
	store, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}

	ctx := context.Background()

	t.Run("Auto-increment priority", func(t *testing.T) {
		t1, _ := store.Create(ctx, "", "First", "", "role-1", nil)
		t2, _ := store.Create(ctx, "", "Second", "", "role-1", nil)
		t3, _ := store.Create(ctx, "", "Third", "", "role-1", nil)

		if t1.Priority != 0 {
			t.Errorf("first ticket priority = %d, want 0", t1.Priority)
		}
		if t2.Priority != 1 {
			t.Errorf("second ticket priority = %d, want 1", t2.Priority)
		}
		if t3.Priority != 2 {
			t.Errorf("third ticket priority = %d, want 2", t3.Priority)
		}
	})

	t.Run("Explicit priority", func(t *testing.T) {
		priority := 10
		ticket, _ := store.Create(ctx, "", "Explicit Priority", "", "role-1", &priority)

		if ticket.Priority != 10 {
			t.Errorf("ticket priority = %d, want 10", ticket.Priority)
		}
	})

	t.Run("Update priority", func(t *testing.T) {
		ticket, _ := store.Create(ctx, "", "Update Priority Test", "", "role-1", nil)

		newPriority := 5
		updated, err := store.Update(ctx, ticket.ID, TicketUpdate{Priority: &newPriority})
		if err != nil {
			t.Fatalf("Update: %v", err)
		}
		if updated.Priority != 5 {
			t.Errorf("updated priority = %d, want 5", updated.Priority)
		}
	})

	t.Run("Priority sorting for open tickets", func(t *testing.T) {
		store2, _ := NewFileStore(t.TempDir())

		p2 := 2
		p0 := 0
		p1 := 1
		store2.Create(ctx, "", "Priority 2", "", "role-1", &p2)
		store2.Create(ctx, "", "Priority 0", "", "role-1", &p0)
		store2.Create(ctx, "", "Priority 1", "", "role-1", &p1)

		tickets, _ := store2.List()
		if len(tickets) != 3 {
			t.Fatalf("got %d tickets, want 3", len(tickets))
		}

		// Should be sorted by priority ascending
		if tickets[0].Priority != 0 {
			t.Errorf("tickets[0].Priority = %d, want 0", tickets[0].Priority)
		}
		if tickets[1].Priority != 1 {
			t.Errorf("tickets[1].Priority = %d, want 1", tickets[1].Priority)
		}
		if tickets[2].Priority != 2 {
			t.Errorf("tickets[2].Priority = %d, want 2", tickets[2].Priority)
		}
	})

	t.Run("Non-open tickets sorted by updated_at", func(t *testing.T) {
		store3, _ := NewFileStore(t.TempDir())

		t1, _ := store3.Create(ctx, "", "Done 1", "", "role-1", nil)
		t2, _ := store3.Create(ctx, "", "Done 2", "", "role-1", nil)

		// Mark both as done
		done := TicketStatusDone
		store3.Update(ctx, t1.ID, TicketUpdate{Status: &done})
		store3.Update(ctx, t2.ID, TicketUpdate{Status: &done})

		tickets, _ := store3.List()

		// t2 was updated last, so should come first
		if tickets[0].Title != "Done 2" {
			t.Errorf("expected most recently updated ticket first, got %q", tickets[0].Title)
		}
	})

	t.Run("Open tickets come before non-open tickets", func(t *testing.T) {
		store4, _ := NewFileStore(t.TempDir())

		// Create done ticket first
		done, _ := store4.Create(ctx, "", "Done", "", "role-1", nil)
		doneStatus := TicketStatusDone
		store4.Update(ctx, done.ID, TicketUpdate{Status: &doneStatus})

		// Then create open ticket
		p1 := 1
		store4.Create(ctx, "", "Open", "", "role-1", &p1)

		tickets, _ := store4.List()
		if len(tickets) != 2 {
			t.Fatalf("got %d tickets, want 2", len(tickets))
		}

		// Open ticket should come first regardless of creation/update order
		if tickets[0].Title != "Open" {
			t.Errorf("expected open ticket first, got %q", tickets[0].Title)
		}
		if tickets[1].Title != "Done" {
			t.Errorf("expected done ticket second, got %q", tickets[1].Title)
		}
	})
}
