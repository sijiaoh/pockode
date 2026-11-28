package watch

import (
	"context"
	"log/slog"
	"sync"
	"sync/atomic"
)

// ChatResyncMethod is the notification that tells a chat subscriber its stream
// has a hole in it: a record could not be queued for it. It is the last
// notification the subscription carries. The client is to drop the
// subscription and open a fresh one (chat.messages.subscribe), whose snapshot
// holds everything that was lost. Params: resyncParams.
//
// Not "chat.<event type>" by accident: TestChatResync_IsNoWireType holds that no
// event type takes the name.
const ChatResyncMethod = "chat.resync"

type resyncParams struct {
	ID string `json:"id"`
}

// chatQueueSize bounds what one chat subscriber may fall behind by. Delivery
// only hands a notification to the connection's own writer, which never waits
// on the network (docs/code/websocket-rpc.md#outbound-delivery), so this fills
// only when delivery itself is held up; it is the size of the single queue it
// replaced, which was shared by every subscriber.
const chatQueueSize = 256

// chatSubscriber is one chat subscription's bounded queue and the goroutine
// that drains it.
//
// The queue keeps the order things were offered in. When it is more than half
// full, live progress is turned away, so a burst of it cannot crowd out
// anything that happens once: tool_activity and thinking_delta are the
// high-frequency events, and the only ones whose loss costs nothing lasting —
// the whole output arrives again with the result, the whole thinking with its
// record, and a fresh subscription is handed the newest activity line. When a
// persisted record finds the queue full, the subscriber is stalled instead:
// everything still queued and everything offered afterwards is discarded, and
// it is sent ChatResyncMethod and nothing more. What it did receive is
// therefore always a gap-free prefix of the stream.
type chatSubscriber struct {
	id        string
	sessionID string
	notifier  Notifier

	queue chan Notification
	// stalled is set once, when a persisted record could not be queued.
	stalled atomic.Bool
	// resync is signalled once, by whoever sets stalled.
	resync chan struct{}

	closeOnce sync.Once
	done      chan struct{}
}

func newChatSubscriber(id, sessionID string, notifier Notifier) *chatSubscriber {
	return &chatSubscriber{
		id:        id,
		sessionID: sessionID,
		notifier:  notifier,
		queue:     make(chan Notification, chatQueueSize),
		resync:    make(chan struct{}, 1),
		done:      make(chan struct{}),
	}
}

// offer queues n without blocking. droppable marks live progress, which is
// turned away rather than queued once the queue is half full.
func (s *chatSubscriber) offer(n Notification, droppable bool) {
	if s.stalled.Load() {
		return
	}
	// Half the queue is a reserve, not a tuned figure: it only engages once the
	// subscriber has fallen far behind, which is exactly when the cheapest thing
	// to drop should be dropped.
	if droppable && len(s.queue) > cap(s.queue)/2 {
		slog.Debug("dropped a live progress update to keep room for records that cannot be lost",
			"id", s.id, "sessionId", s.sessionID, "queued", len(s.queue))
		return
	}
	select {
	case s.queue <- n:
		return
	default:
	}
	if droppable {
		return
	}
	if s.stalled.CompareAndSwap(false, true) {
		slog.Warn("chat subscriber fell too far behind; telling it to resync",
			"id", s.id, "sessionId", s.sessionID, "method", n.Method)
		s.resync <- struct{}{}
	}
}

func (s *chatSubscriber) run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-s.done:
			return
		case <-s.resync:
			s.notify(ctx, Notification{Method: ChatResyncMethod, Params: resyncParams{ID: s.id}})
		case n := <-s.queue:
			// Checked per notification, so nothing queued before the hole is
			// delivered after the resync that reports it. Draining on regardless
			// lets the discarded notifications go.
			if s.stalled.Load() {
				continue
			}
			s.notify(ctx, n)
		}
	}
}

func (s *chatSubscriber) notify(ctx context.Context, n Notification) {
	// select picks at random among ready cases, so done may be closed while a
	// notification was taken instead; an unsubscribed id gets nothing more.
	select {
	case <-s.done:
		return
	default:
	}
	if err := s.notifier.Notify(ctx, n); err != nil {
		slog.Debug("failed to notify subscriber",
			"id", s.id,
			"sessionId", s.sessionID,
			"error", err)
	}
}

// close stops delivery; anything still queued is discarded.
func (s *chatSubscriber) close() {
	s.closeOnce.Do(func() { close(s.done) })
}
