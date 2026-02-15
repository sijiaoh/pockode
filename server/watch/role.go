package watch

import (
	"log/slog"

	"github.com/pockode/server/ticket"
)

// RoleWatcher notifies subscribers when the role list changes.
type RoleWatcher struct {
	*BaseWatcher
	store   ticket.RoleStore
	eventCh chan ticket.RoleChangeEvent
}

func NewRoleWatcher(store ticket.RoleStore) *RoleWatcher {
	w := &RoleWatcher{
		BaseWatcher: NewBaseWatcher("role"),
		store:       store,
		eventCh:     make(chan ticket.RoleChangeEvent, 64),
	}
	store.SetOnChangeListener(w)
	return w
}

func (w *RoleWatcher) Start() error {
	go w.eventLoop()
	slog.Info("RoleWatcher started")
	return nil
}

func (w *RoleWatcher) Stop() {
	w.Cancel()
	slog.Info("RoleWatcher stopped")
}

func (w *RoleWatcher) eventLoop() {
	for {
		select {
		case <-w.Context().Done():
			return
		case event := <-w.eventCh:
			w.notifyChange(event)
		}
	}
}

func (w *RoleWatcher) notifyChange(event ticket.RoleChangeEvent) {
	if !w.HasSubscriptions() {
		return
	}

	w.NotifyAll("role.list.changed", func(sub *Subscription) any {
		params := roleListChangedParams{
			ID:        sub.ID,
			Operation: string(event.Op),
		}
		if event.Op == ticket.OperationDelete {
			params.RoleID = event.Role.ID
		} else {
			params.Role = &event.Role
		}
		return params
	})

	slog.Debug("notified role list change", "operation", event.Op)
}

// Subscribe registers a subscriber and returns the current role list.
func (w *RoleWatcher) Subscribe(notifier Notifier) (string, []ticket.AgentRole, error) {
	id := w.GenerateID()
	sub := &Subscription{
		ID:       id,
		Notifier: notifier,
	}
	w.AddSubscription(sub)

	roles, err := w.store.List()
	if err != nil {
		w.RemoveSubscription(id)
		return "", nil, err
	}

	return id, roles, nil
}

type roleListChangedParams struct {
	ID        string             `json:"id"`
	Operation string             `json:"operation"`
	Role      *ticket.AgentRole  `json:"role,omitempty"`
	RoleID    string             `json:"roleId,omitempty"`
}

// OnRoleChange implements ticket.OnRoleChangeListener.
func (w *RoleWatcher) OnRoleChange(event ticket.RoleChangeEvent) {
	if w.Context().Err() != nil {
		return
	}

	select {
	case w.eventCh <- event:
	default:
		slog.Warn("role change event dropped (buffer full)", "operation", event.Op)
	}
}
