package watch

import (
	"log/slog"
	"sync/atomic"

	"github.com/pockode/server/agentrole"
)

// AgentRoleListWatcher notifies subscribers when the agent role list changes.
type AgentRoleListWatcher struct {
	*BaseWatcher
	store   agentrole.Store
	eventCh chan agentrole.ChangeEvent
	dirty   atomic.Bool
}

func NewAgentRoleListWatcher(store agentrole.Store) *AgentRoleListWatcher {
	w := &AgentRoleListWatcher{
		BaseWatcher: NewBaseWatcher("arl"),
		store:       store,
		eventCh:     make(chan agentrole.ChangeEvent, 64),
	}
	store.AddOnChangeListener(w)
	return w
}

func (w *AgentRoleListWatcher) Start() error {
	go w.eventLoop()
	slog.Info("AgentRoleListWatcher started")
	return nil
}

func (w *AgentRoleListWatcher) Stop() {
	w.Cancel()
	slog.Info("AgentRoleListWatcher stopped")
}

func (w *AgentRoleListWatcher) eventLoop() {
	for {
		select {
		case <-w.Context().Done():
			return
		case event := <-w.eventCh:
			if w.dirty.Swap(false) {
				w.notifySync()
			} else {
				w.notifyChange(event)
			}
		}
	}
}

func (w *AgentRoleListWatcher) notifyChange(event agentrole.ChangeEvent) {
	if !w.HasSubscriptions() {
		return
	}

	w.NotifyAll("agent_role.list.changed", func(sub *Subscription) any {
		params := agentRoleListChangedParams{
			ID:        sub.ID,
			Operation: string(event.Op),
		}
		if event.Op == agentrole.OperationDelete {
			params.RoleID = event.Role.ID
		} else {
			role := event.Role
			params.Role = &role
		}
		return params
	})

	slog.Debug("notified agent role list change", "operation", event.Op)
}

func (w *AgentRoleListWatcher) notifySync() {
	if !w.HasSubscriptions() {
		return
	}

	roles, err := w.store.List()
	if err != nil {
		slog.Error("failed to list agent roles for sync", "error", err)
		return
	}

	w.NotifyAll("agent_role.list.changed", func(sub *Subscription) any {
		return agentRoleListSyncParams{
			ID:        sub.ID,
			Operation: "sync",
			Roles:     roles,
		}
	})

	slog.Info("sent full agent role sync to subscribers after event drop")
}

// Subscribe registers a subscriber and returns the current role list.
func (w *AgentRoleListWatcher) Subscribe(notifier Notifier) (string, []agentrole.AgentRole, error) {
	id := w.GenerateID()
	sub := &Subscription{
		ID:       id,
		Notifier: notifier,
	}
	// Add subscription BEFORE getting the list to avoid missing events.
	w.AddSubscription(sub)

	roles, err := w.store.List()
	if err != nil {
		w.RemoveSubscription(id)
		return "", nil, err
	}

	return id, roles, nil
}

type agentRoleListChangedParams struct {
	ID        string               `json:"id"`
	Operation string               `json:"operation"`
	Role      *agentrole.AgentRole `json:"role,omitempty"`
	RoleID    string               `json:"roleId,omitempty"`
}

type agentRoleListSyncParams struct {
	ID        string                `json:"id"`
	Operation string                `json:"operation"`
	Roles     []agentrole.AgentRole `json:"roles"`
}

// OnAgentRoleChange implements agentrole.OnChangeListener.
func (w *AgentRoleListWatcher) OnAgentRoleChange(event agentrole.ChangeEvent) {
	select {
	case <-w.Context().Done():
		return
	case w.eventCh <- event:
	default:
		w.dirty.Store(true)
		slog.Warn("agent role list change event dropped, will sync on next event", "operation", event.Op)
	}
}
