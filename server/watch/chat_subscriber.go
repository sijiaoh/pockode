package watch

import (
	"context"
	"log/slog"
	"sync"
	"sync/atomic"
)

// ChatResyncMethod is the notification that tells a chat subscriber its stream
// has a hole in it: an update could not be queued for it, or the projection it
// is taken from lost track of the history (projection.Live.TakeUpdate). It is the last
// notification the subscription carries. The client is to drop the
// subscription and open a fresh one (chat.messages.subscribe), whose snapshot
// holds everything that was lost. Params: resyncParams.
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
// full, live stream deltas are turned away, so a burst of them cannot crowd
// out anything that happens once: they are the high-frequency notifications,
// and the only ones whose loss is repaired in place — the subscriber is sent
// the whole stream with its next delta (offerDelta), and the item that settles
// a stream holds all of it. When an update finds the queue full, the
// subscriber is stalled instead: everything still queued and everything
// offered afterwards is discarded, and it is sent ChatResyncMethod and nothing
// more. What it did receive is therefore always a gap-free prefix of the
// stream.
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

	// gaps are the live streams a delta of was turned away, by stream key
	// (offerDelta); guarded by the watcher's sessionMu.
	gaps map[string]bool
}

func newChatSubscriber(id, sessionID string, notifier Notifier) *chatSubscriber {
	return &chatSubscriber{
		id:        id,
		sessionID: sessionID,
		notifier:  notifier,
		queue:     make(chan Notification, chatQueueSize),
		resync:    make(chan struct{}, 1),
		done:      make(chan struct{}),
		gaps:      make(map[string]bool),
	}
}

// offer queues n without blocking, and says whether it did. droppable marks
// a live stream's delta, which is turned away rather than queued once the
// queue is half full.
func (s *chatSubscriber) offer(n Notification, droppable bool) bool {
	if s.stalled.Load() {
		return false
	}
	if droppable && s.refusesDroppable() {
		slog.Debug("dropped a live stream delta to keep room for updates that cannot be lost",
			"id", s.id, "sessionId", s.sessionID, "queued", len(s.queue))
		return false
	}
	select {
	case s.queue <- n:
		return true
	default:
	}
	if droppable {
		return false
	}
	slog.Warn("chat subscriber fell too far behind; telling it to resync",
		"id", s.id, "sessionId", s.sessionID, "method", n.Method)
	s.requestResync()
	return false
}

// refusesDroppable is whether offer would turn a droppable notification away
// before trying the queue. Half the queue is a reserve, not a tuned figure: it
// only engages once the subscriber has fallen far behind, which is exactly
// when the cheapest thing to drop should be dropped.
func (s *chatSubscriber) refusesDroppable() bool {
	return s.stalled.Load() || len(s.queue) > cap(s.queue)/2
}

// requestResync stalls the subscriber: it is sent ChatResyncMethod and
// nothing more, whatever is still queued included.
func (s *chatSubscriber) requestResync() {
	if s.stalled.CompareAndSwap(false, true) {
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
