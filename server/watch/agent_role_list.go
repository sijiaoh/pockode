package watch

import (
	"log/slog"
	"maps"
	"sync"
	"sync/atomic"

	"github.com/pockode/server/agentrole"
	"github.com/pockode/server/work"
)

// AgentRoleListWatcher notifies subscribers when the agent role list changes,
// and when the number of work items naming a role changes.
//
// That second number lives in the work store, not this one, so the list a
// subscriber draws changes for two reasons and the second is a work item that
// nothing about the roles reflects. It is never written onto an AgentRole: the
// role record is what the role store holds, and a count glued to it would stay
// at whatever it was when the role was last edited. It travels as its own
// notification instead, carrying the whole map each time, so what a client
// holds is either the current answer or nothing at all.
type AgentRoleListWatcher struct {
	*BaseWatcher
	store     agentrole.Store
	workStore work.Store
	eventCh   chan agentRoleListEvent
	dirty     atomic.Bool

	// countsMu guards sentCounts, the reference counts last pushed to every
	// subscriber. Only eventLoop touches it today; the lock keeps that from
	// being a thing the next caller has to know.
	//
	// sentCounts exists because every work change reaches this watcher — a
	// turn ending, a status moving, a title edited — and almost none of them
	// move a count, so the map is compared before it is pushed. nil means
	// "nothing pushed to anyone", which is the state with no subscribers; it
	// forces the next push.
	countsMu   sync.Mutex
	sentCounts map[string]int
}

// agentRoleListEvent is a union of the two changes that alter what a subscriber
// sees: an agent role, and a work item whose role reference moves a count.
// A work event sets no field — the counts are recomputed from the store rather
// than derived from the event, because one work changing role moves two counts
// and a subscriber that missed an earlier event would be left adding deltas to
// a number it never had.
type agentRoleListEvent struct {
	role *agentrole.ChangeEvent
}

// NewAgentRoleListWatcher builds the watcher. workStore is where the reference
// counts are read from.
func NewAgentRoleListWatcher(store agentrole.Store, workStore work.Store) *AgentRoleListWatcher {
	w := &AgentRoleListWatcher{
		BaseWatcher: NewBaseWatcher(),
		store:       store,
		workStore:   workStore,
		eventCh:     make(chan agentRoleListEvent, 64),
	}
	store.AddOnChangeListener(w)
	workStore.AddOnChangeListener(w)
	return w
}

func (w *AgentRoleListWatcher) Start() error {
	w.Go(w.eventLoop)
	slog.Info("AgentRoleListWatcher started")
	return nil
}

func (w *AgentRoleListWatcher) Stop() {
	w.CancelAndWait()
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
			} else if event.role != nil {
				w.notifyChange(*event.role)
			}
			// After the role notification, not before: a client learning of a
			// role and its count in that order never holds a count for a role
			// it has not been told about.
			w.notifyRefCounts()
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

// notifyRefCounts pushes the reference counts, and only when they have moved.
func (w *AgentRoleListWatcher) notifyRefCounts() {
	if !w.HasSubscriptions() {
		w.forgetRefCounts()
		return
	}

	counts, changed := w.refCountsIfChanged()
	if !changed {
		return
	}

	// Built once and shared across subscribers, like the rows WorkListWatcher
	// pushes: each computation makes a new map and nothing writes to one again.
	w.NotifyAll("agent_role.list.changed", func(sub *Subscription) any {
		return agentRoleRefCountsParams{
			ID:            sub.ID,
			Operation:     "ref_counts",
			WorkRefCounts: counts,
		}
	})

	slog.Debug("notified agent role reference counts", "roles", len(counts))
}

func (w *AgentRoleListWatcher) refCountsIfChanged() (map[string]int, bool) {
	w.countsMu.Lock()
	defer w.countsMu.Unlock()

	counts, err := w.refCounts()
	if err != nil {
		slog.Error("failed to list works for agent role reference counts", "error", err)
		return nil, false
	}
	if w.sentCounts != nil && maps.Equal(w.sentCounts, counts) {
		return nil, false
	}
	w.sentCounts = counts
	return counts, true
}

func (w *AgentRoleListWatcher) forgetRefCounts() {
	w.countsMu.Lock()
	defer w.countsMu.Unlock()
	w.sentCounts = nil
}

func (w *AgentRoleListWatcher) refCounts() (map[string]int, error) {
	works, err := w.workStore.List()
	if err != nil {
		return nil, err
	}
	return work.CountRoleRefs(works), nil
}

// Subscribe registers a subscriber under the client-chosen id and returns the
// current role list together with the current reference counts.
//
// Registered before the list is read, so a change landing between the two is
// notified rather than lost; see BaseWatcher.AddSubscription.
func (w *AgentRoleListWatcher) Subscribe(id string, notifier Notifier) ([]agentrole.AgentRole, map[string]int, error) {
	sub := &Subscription{
		ID:       id,
		Notifier: notifier,
	}
	if err := w.AddSubscription(sub); err != nil {
		return nil, nil, err
	}

	roles, err := w.store.List()
	if err != nil {
		w.RemoveSubscription(id)
		return nil, nil, err
	}

	// Read, but deliberately not recorded as sent: what this subscriber is
	// about to be told says nothing about what the others hold. A change may
	// already be queued for the loop, and recording it here would let the loop
	// find its own result "already sent" and push it to nobody — leaving every
	// earlier subscriber on the count they had. A subscriber that receives the
	// push anyway is told the same thing twice, which costs a message; the
	// other way costs a wrong number until something else moves.
	counts, err := w.refCounts()
	if err != nil {
		w.RemoveSubscription(id)
		return nil, nil, err
	}

	return roles, counts, nil
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

type agentRoleRefCountsParams struct {
	ID            string         `json:"id"`
	Operation     string         `json:"operation"`
	WorkRefCounts map[string]int `json:"work_ref_counts"`
}

// OnAgentRoleChange implements agentrole.OnChangeListener.
func (w *AgentRoleListWatcher) OnAgentRoleChange(event agentrole.ChangeEvent) {
	select {
	case <-w.Context().Done():
		return
	case w.eventCh <- agentRoleListEvent{role: &event}:
	default:
		w.dirty.Store(true)
		slog.Warn("agent role list change event dropped, will sync on next event", "operation", event.Op)
	}
}

// OnWorkChange implements work.OnChangeListener: a work item may have taken a
// role, dropped one or swapped one.
//
// A dropped event needs no dirty flag, unlike a role event: counts are pushed
// whole and recomputed from the store, and the channel is only ever full when
// events are still queued behind it — each of which recomputes the same map.
func (w *AgentRoleListWatcher) OnWorkChange(work.ChangeEvent) {
	select {
	case <-w.Context().Done():
		return
	case w.eventCh <- agentRoleListEvent{}:
	default:
	}
}
