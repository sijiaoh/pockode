package ws

import (
	"sync"

	"github.com/pockode/server/watch"
)

// Subscriptions are the subscriptions one connection opened, given back when
// it closes: a watcher would otherwise go on notifying a connection that is
// gone. A server's connections and a cluster's keep theirs here alike.
type Subscriptions struct {
	heldMu sync.Mutex
	held   map[subscriptionKey]struct{}
	// closed is set by Close, so that a subscribe still in flight when the
	// connection went gives its subscription straight back.
	closed bool
}

// subscriptionKey identifies one of a connection's subscriptions. The id alone
// would not: a subscription id is the client's, and is unique only within the
// watcher it was registered on, so two watchers can hold the same id for two
// unrelated subscriptions. Keyed by id alone, the second would evict the first
// from this map and the first would never be given back.
type subscriptionKey struct {
	watcher watch.Watcher
	id      string
}

func NewSubscriptions() *Subscriptions {
	return &Subscriptions{held: make(map[subscriptionKey]struct{})}
}

func (s *Subscriptions) Track(id string, watcher watch.Watcher) {
	s.heldMu.Lock()
	defer s.heldMu.Unlock()
	if s.closed {
		watcher.Unsubscribe(id)
		return
	}
	s.held[subscriptionKey{watcher: watcher, id: id}] = struct{}{}
}

// Untrack forgets a subscription the client ended itself.
func (s *Subscriptions) Untrack(id string, watcher watch.Watcher) {
	s.heldMu.Lock()
	defer s.heldMu.Unlock()
	delete(s.held, subscriptionKey{watcher: watcher, id: id})
}

// UnsubscribeFrom gives back every subscription on watchers.
func (s *Subscriptions) UnsubscribeFrom(watchers []watch.Watcher) {
	s.heldMu.Lock()
	defer s.heldMu.Unlock()
	for key := range s.held {
		for _, w := range watchers {
			if key.watcher == w {
				key.watcher.Unsubscribe(key.id)
				delete(s.held, key)
				break
			}
		}
	}
}

// Close gives back every subscription, and any tracked from now on.
func (s *Subscriptions) Close() {
	s.heldMu.Lock()
	defer s.heldMu.Unlock()
	s.closed = true
	for key := range s.held {
		key.watcher.Unsubscribe(key.id)
	}
	s.held = nil
}
