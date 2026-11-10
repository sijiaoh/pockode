package watch

import (
	"log/slog"
)

// latestWatcher pushes one value the whole process shares — not one per key —
// to every subscriber whenever its owner says it changed.
//
// Every notification carries the value as it is when sent, never the one that
// triggered it, so changes that pile up while one is being sent collapse into
// one and the last one sent is always the current value.
type latestWatcher[T any] struct {
	*BaseWatcher
	// name is what the value is, for logs.
	name   string
	method string
	read   func() (T, error)
	// params builds a notification's params for the subscription id.
	params func(id string, value T) any
	wake   chan struct{}
}

func newLatestWatcher[T any](name, method string, read func() (T, error), params func(string, T) any) *latestWatcher[T] {
	return &latestWatcher[T]{
		BaseWatcher: NewBaseWatcher(),
		name:        name,
		method:      method,
		read:        read,
		params:      params,
		wake:        make(chan struct{}, 1),
	}
}

func (w *latestWatcher[T]) Start() error {
	w.Go(w.eventLoop)
	slog.Info("watcher started", "watcher", w.name)
	return nil
}

func (w *latestWatcher[T]) Stop() {
	w.CancelAndWait()
	slog.Info("watcher stopped", "watcher", w.name)
}

// changed never blocks — owners call it from loops that must not wait on a
// slow client, or holding a lock — and never drops a change: the loop reads
// the value when it sends.
func (w *latestWatcher[T]) changed() {
	select {
	case w.wake <- struct{}{}:
	default:
	}
}

func (w *latestWatcher[T]) eventLoop() {
	for {
		select {
		case <-w.Context().Done():
			return
		case <-w.wake:
		}
		if !w.HasSubscriptions() {
			continue
		}
		value, err := w.read()
		if err != nil {
			slog.Error("failed to read for notification", "watcher", w.name, "error", err)
			continue
		}
		w.NotifyAll(w.method, func(sub *Subscription) any {
			return w.params(sub.ID, value)
		})
	}
}

// Subscribe registers a subscriber under the client-chosen id and returns the
// current value. It is read after registering, so a change in between is
// either in this answer or in a notification, never lost between the two — but
// that notification can reach the client before the answer, which then
// overwrites it with the older value: call Resend once the answer is out. A
// value that cannot be read leaves no subscription behind.
func (w *latestWatcher[T]) Subscribe(id string, notifier Notifier) (T, error) {
	var zero T
	if err := w.AddSubscription(&Subscription{ID: id, Notifier: notifier}); err != nil {
		return zero, err
	}
	value, err := w.read()
	if err != nil {
		w.RemoveSubscription(id)
		return zero, err
	}
	return value, nil
}

// Resend sends every subscriber the value as it is now. A subscribe handler
// calls it after its reply, so whatever the client holds last is current even
// when a notification overtook the reply (see Subscribe).
func (w *latestWatcher[T]) Resend() { w.changed() }
