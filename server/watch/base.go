package watch

import (
	"context"
	"log/slog"
	"sync"
)

type Subscription struct {
	ID       string
	Notifier Notifier
}

// BaseWatcher provides common subscription management for all watcher types.
type BaseWatcher struct {
	idPrefix string

	subMu         sync.RWMutex
	subscriptions map[string]*Subscription

	ctx    context.Context
	cancel context.CancelFunc
}

func NewBaseWatcher(idPrefix string) *BaseWatcher {
	ctx, cancel := context.WithCancel(context.Background())
	return &BaseWatcher{
		idPrefix:      idPrefix,
		subscriptions: make(map[string]*Subscription),
		ctx:           ctx,
		cancel:        cancel,
	}
}

func (b *BaseWatcher) GenerateID() string {
	return generateIDWithPrefix(b.idPrefix)
}

func (b *BaseWatcher) AddSubscription(sub *Subscription) {
	b.subMu.Lock()
	defer b.subMu.Unlock()

	b.subscriptions[sub.ID] = sub
}

func (b *BaseWatcher) RemoveSubscription(id string) *Subscription {
	b.subMu.Lock()
	defer b.subMu.Unlock()

	sub, ok := b.subscriptions[id]
	if !ok {
		return nil
	}

	delete(b.subscriptions, id)
	return sub
}

func (b *BaseWatcher) GetAllSubscriptions() []*Subscription {
	b.subMu.RLock()
	defer b.subMu.RUnlock()

	subs := make([]*Subscription, 0, len(b.subscriptions))
	for _, sub := range b.subscriptions {
		subs = append(subs, sub)
	}
	return subs
}

func (b *BaseWatcher) GetSubscription(id string) *Subscription {
	b.subMu.RLock()
	defer b.subMu.RUnlock()
	return b.subscriptions[id]
}

func (b *BaseWatcher) NotifyAll(method string, makeParams func(sub *Subscription) any) int {
	subs := b.GetAllSubscriptions()
	for _, sub := range subs {
		params := makeParams(sub)
		n := Notification{Method: method, Params: params}
		if err := sub.Notifier.Notify(context.Background(), n); err != nil {
			slog.Debug("failed to notify subscriber",
				"id", sub.ID,
				"error", err)
		}
	}
	return len(subs)
}

func (b *BaseWatcher) Context() context.Context { return b.ctx }
func (b *BaseWatcher) Cancel()                  { b.cancel() }

func (b *BaseWatcher) HasSubscriptions() bool {
	b.subMu.RLock()
	defer b.subMu.RUnlock()
	return len(b.subscriptions) > 0
}

func (b *BaseWatcher) Unsubscribe(id string) {
	b.RemoveSubscription(id)
}
