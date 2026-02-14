package watch

import (
	"log/slog"

	"github.com/pockode/server/ticket"
)

// TicketWatcher notifies subscribers when the ticket list changes.
type TicketWatcher struct {
	*BaseWatcher
	store   ticket.Store
	eventCh chan ticket.TicketChangeEvent
}

func NewTicketWatcher(store ticket.Store) *TicketWatcher {
	w := &TicketWatcher{
		BaseWatcher: NewBaseWatcher("tk"),
		store:       store,
		eventCh:     make(chan ticket.TicketChangeEvent, 64),
	}
	store.SetOnChangeListener(w)
	return w
}

func (w *TicketWatcher) Start() error {
	go w.eventLoop()
	slog.Info("TicketWatcher started")
	return nil
}

func (w *TicketWatcher) Stop() {
	w.Cancel()
	slog.Info("TicketWatcher stopped")
}

func (w *TicketWatcher) eventLoop() {
	for {
		select {
		case <-w.Context().Done():
			return
		case event := <-w.eventCh:
			w.notifyChange(event)
		}
	}
}

func (w *TicketWatcher) notifyChange(event ticket.TicketChangeEvent) {
	if !w.HasSubscriptions() {
		return
	}

	w.NotifyAll("ticket.list.changed", func(sub *Subscription) any {
		params := ticketListChangedParams{
			ID:        sub.ID,
			Operation: string(event.Op),
		}
		if event.Op == ticket.OperationDelete {
			params.TicketID = event.Ticket.ID
		} else {
			params.Ticket = &event.Ticket
		}
		return params
	})

	slog.Debug("notified ticket list change", "operation", event.Op)
}

// Subscribe registers a subscriber and returns the current ticket list.
func (w *TicketWatcher) Subscribe(notifier Notifier) (string, []ticket.Ticket, error) {
	id := w.GenerateID()
	sub := &Subscription{
		ID:       id,
		Notifier: notifier,
	}
	w.AddSubscription(sub)

	tickets, err := w.store.List()
	if err != nil {
		w.RemoveSubscription(id)
		return "", nil, err
	}

	return id, tickets, nil
}

type ticketListChangedParams struct {
	ID        string         `json:"id"`
	Operation string         `json:"operation"`
	Ticket    *ticket.Ticket `json:"ticket,omitempty"`
	TicketID  string         `json:"ticketId,omitempty"`
}

// OnTicketChange implements ticket.OnChangeListener.
func (w *TicketWatcher) OnTicketChange(event ticket.TicketChangeEvent) {
	if w.Context().Err() != nil {
		return
	}

	select {
	case w.eventCh <- event:
	default:
		slog.Warn("ticket change event dropped (buffer full)", "operation", event.Op)
	}
}
