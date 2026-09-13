package watch

import (
	"context"
	"errors"
	"log/slog"
	"sync"
)

// Errors from AddSubscription. The id under which a subscription is registered
// is chosen by the client, so both of these are the client's mistake.
var (
	ErrSubscriptionIDRequired = errors.New("subscription id is required")
	ErrSubscriptionIDInUse    = errors.New("subscription id already in use")
)

type Subscription struct {
	ID string
	// Key names the single resource a subscription follows, for watchers whose
	// subscribers each watch one item instead of a whole list: a work_id for
	// WorkDetailWatcher, a session_id for SessionDetailWatcher. Empty on list
	// watchers, which notify every subscriber.
	Key      string
	Notifier Notifier
}

// BaseWatcher provides common subscription management for all watcher types.
type BaseWatcher struct {
	subMu         sync.RWMutex
	subscriptions map[string]*Subscription

	ctx    context.Context
	cancel context.CancelFunc

	// spawnMu orders goroutine registration against cancellation, so that Go can
	// never add to wg after CancelAndWait has started waiting on it.
	spawnMu sync.Mutex
	wg      sync.WaitGroup
}

func NewBaseWatcher() *BaseWatcher {
	ctx, cancel := context.WithCancel(context.Background())
	return &BaseWatcher{
		subscriptions: make(map[string]*Subscription),
		ctx:           ctx,
		cancel:        cancel,
	}
}

// AddSubscription registers a subscription under the id the client chose.
//
// The id comes from the client precisely so that it is known before the request
// is sent: a change landing between this registration and the reply arriving is
// then delivered to a receiver that already exists, instead of arriving under an
// id the client has not learned yet and being dropped. The id space is shared by
// every connection a watcher serves, so one already in use is refused rather
// than silently taking the other subscription's place.
//
// The full contract: docs/code/subscription-system.md.
func (b *BaseWatcher) AddSubscription(sub *Subscription) error {
	if sub.ID == "" {
		return ErrSubscriptionIDRequired
	}

	b.subMu.Lock()
	defer b.subMu.Unlock()

	if _, exists := b.subscriptions[sub.ID]; exists {
		return ErrSubscriptionIDInUse
	}

	b.subscriptions[sub.ID] = sub
	return nil
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

// HasSubscriptionForKey reports whether any subscription targets key.
// Used to skip expensive per-event work (store reads) when no subscriber cares.
func (b *BaseWatcher) HasSubscriptionForKey(key string) bool {
	b.subMu.RLock()
	defer b.subMu.RUnlock()
	for _, sub := range b.subscriptions {
		if sub.Key == key {
			return true
		}
	}
	return false
}

// NotifyForKey sends a notification only to subscribers whose Key matches.
func (b *BaseWatcher) NotifyForKey(key, method string, makeParams func(sub *Subscription) any) {
	for _, sub := range b.GetAllSubscriptions() {
		if sub.Key != key {
			continue
		}
		n := Notification{Method: method, Params: makeParams(sub)}
		if err := sub.Notifier.Notify(b.ctx, n); err != nil {
			slog.Debug("failed to notify subscriber",
				"id", sub.ID,
				"error", err)
		}
	}
}

func (b *BaseWatcher) NotifyAll(method string, makeParams func(sub *Subscription) any) int {
	subs := b.GetAllSubscriptions()
	for _, sub := range subs {
		params := makeParams(sub)
		n := Notification{Method: method, Params: params}
		if err := sub.Notifier.Notify(b.ctx, n); err != nil {
			slog.Debug("failed to notify subscriber",
				"id", sub.ID,
				"error", err)
		}
	}
	return len(subs)
}

func (b *BaseWatcher) Context() context.Context { return b.ctx }

// Go runs fn as a background goroutine tracked by the watcher, so that
// CancelAndWait can wait for it. Every long-running loop a watcher starts must
// go through here.
func (b *BaseWatcher) Go(fn func()) {
	b.spawnMu.Lock()
	defer b.spawnMu.Unlock()
	if b.ctx.Err() != nil {
		return
	}

	b.wg.Add(1)
	go func() {
		defer b.wg.Done()
		fn()
	}()
}

// CancelAndWait cancels the watcher context and blocks until every goroutine
// started with Go has returned. Stop must be synchronous: a caller that has
// stopped a watcher (a shutting-down worktree, a finishing test) is entitled to
// assume nothing is still reading the store or the work tree behind its back.
func (b *BaseWatcher) CancelAndWait() {
	b.spawnMu.Lock()
	b.cancel()
	b.spawnMu.Unlock()

	b.wg.Wait()
}

func (b *BaseWatcher) HasSubscriptions() bool {
	b.subMu.RLock()
	defer b.subMu.RUnlock()
	return len(b.subscriptions) > 0
}

func (b *BaseWatcher) Unsubscribe(id string) {
	b.RemoveSubscription(id)
}
