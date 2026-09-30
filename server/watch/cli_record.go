package watch

import (
	"log/slog"
	"sync"

	"github.com/pockode/server/session"
)

// cliRecordWatcher pushes each change to a CLI's latest record of something
// the server runs on its behalf — a sign-in, an update — to the clients
// following that CLI. Such a thing ends on its own, so a client cannot learn
// how it went by asking after something it did.
//
// Every notification carries the whole record as it is when sent, never a
// delta, so changes that pile up while one is being sent collapse into one.
type cliRecordWatcher[T any] struct {
	*BaseWatcher
	// name is what the records are, for logs.
	name   string
	method string
	// read is the CLI's latest record, or nil when it has had none.
	read func(session.AgentType) (*T, error)
	// params builds a notification's params for the subscription id.
	params func(id string, record *T) any

	pendingMu sync.Mutex
	pending   map[session.AgentType]struct{}
	wake      chan struct{}
}

func newCLIRecordWatcher[T any](name, method string, read func(session.AgentType) (*T, error), params func(string, *T) any) *cliRecordWatcher[T] {
	return &cliRecordWatcher[T]{
		BaseWatcher: NewBaseWatcher(),
		name:        name,
		method:      method,
		read:        read,
		params:      params,
		pending:     make(map[session.AgentType]struct{}),
		wake:        make(chan struct{}, 1),
	}
}

func (w *cliRecordWatcher[T]) Start() error {
	w.Go(w.eventLoop)
	slog.Info("CLI record watcher started", "records", w.name)
	return nil
}

func (w *cliRecordWatcher[T]) Stop() {
	w.CancelAndWait()
	slog.Info("CLI record watcher stopped", "records", w.name)
}

// changed never blocks and never drops a change: the CLI is marked, and the
// loop sends what its record is by then.
func (w *cliRecordWatcher[T]) changed(agentType session.AgentType) {
	w.pendingMu.Lock()
	w.pending[agentType] = struct{}{}
	w.pendingMu.Unlock()
	select {
	case w.wake <- struct{}{}:
	default:
	}
}

func (w *cliRecordWatcher[T]) eventLoop() {
	for {
		select {
		case <-w.Context().Done():
			return
		case <-w.wake:
		}
		w.pendingMu.Lock()
		pending := w.pending
		w.pending = make(map[session.AgentType]struct{})
		w.pendingMu.Unlock()

		for agentType := range pending {
			if !w.HasSubscriptionForKey(string(agentType)) {
				continue
			}
			record, err := w.read(agentType)
			if err != nil {
				slog.Error("failed to read CLI record for notification", "records", w.name, "cli", agentType, "error", err)
				continue
			}
			w.NotifyForKey(string(agentType), w.method, func(sub *Subscription) any {
				return w.params(sub.ID, record)
			})
		}
	}
}

// Subscribe follows agentType's record and returns its latest — running, or
// the last to end, so that a client back from a reload or a dropped
// connection learns how it went — or nil when it has had none.
func (w *cliRecordWatcher[T]) Subscribe(id string, agentType session.AgentType, notifier Notifier) (*T, error) {
	// Read first: an unknown CLI must not leave a subscription behind.
	if _, err := w.read(agentType); err != nil {
		return nil, err
	}
	if err := w.AddSubscription(&Subscription{ID: id, Key: string(agentType), Notifier: notifier}); err != nil {
		return nil, err
	}
	// Read again after subscribing: a change in between is then either in this
	// answer or in a notification, never lost between the two.
	return w.read(agentType)
}
