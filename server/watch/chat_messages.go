package watch

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/chatstream"
	"github.com/pockode/server/session"
)

// ChatMessagesWatcher manages subscriptions for chat messages. It is the
// chatstream.Sink every record of a session is handed to, in seq order, by the
// session's sequencer.
//
// The sequencer only enqueues: every subscriber has a bounded queue of its own,
// drained by a goroutine of its own (chatSubscriber), so a subscriber that
// falls behind holds up neither the agent producing the records nor the other
// subscribers. See docs/code/subscription-system.md#chat-delivery.
type ChatMessagesWatcher struct {
	*BaseWatcher
	store session.Store

	// sessionMu is held exclusively for the whole fan-out of one record, so
	// every subscriber of a session queues records in the same order.
	sessionMu    sync.RWMutex
	sessionToSub map[string][]*chatSubscriber // sessionID -> subscribers
	idToSub      map[string]*chatSubscriber   // subscription ID -> subscriber
}

var _ chatstream.Sink = (*ChatMessagesWatcher)(nil)
var _ Watcher = (*ChatMessagesWatcher)(nil)
var _ ViewingChecker = (*ChatMessagesWatcher)(nil)

func NewChatMessagesWatcher(store session.Store) *ChatMessagesWatcher {
	return &ChatMessagesWatcher{
		BaseWatcher:  NewBaseWatcher(),
		store:        store,
		sessionToSub: make(map[string][]*chatSubscriber),
		idToSub:      make(map[string]*chatSubscriber),
	}
}

// Start has nothing to start: each subscriber's delivery goroutine is started
// when it subscribes.
func (w *ChatMessagesWatcher) Start() error {
	slog.Info("ChatMessagesWatcher started")
	return nil
}

func (w *ChatMessagesWatcher) Stop() {
	w.CancelAndWait()
	slog.Info("ChatMessagesWatcher stopped")
}

// Enqueue queues a record for every subscriber of the session except the one
// whose Notifier is exclude, and returns without waiting for any of them. Each
// subscriber receives what it is given in the order Enqueue was called, and its
// one caller, the session's chatstream.Sequencer, calls it in seq order, so
// records reach the wire in seq order.
//
// exclude is typed any because the chat client that passes it through does not
// know the watch package; it is the sending connection's Notifier.
//
// seq is where the record landed in the session's history, or
// session.NoHistorySeq for a live event, which was never persisted. Whether a
// record may be dropped when a subscriber falls behind is read from its type,
// not from seq: only an agent.LiveEvent may be.
func (w *ChatMessagesWatcher) Enqueue(sessionID string, record agent.Wire, seq session.HistorySeq, exclude any) {
	if w.Context().Err() != nil {
		return
	}
	_, live := record.(agent.LiveEvent)
	method := "chat." + string(record.Type())

	w.sessionMu.Lock()
	defer w.sessionMu.Unlock()
	for _, sub := range w.sessionToSub[sessionID] {
		if exclude != nil && any(sub.notifier) == exclude {
			continue
		}
		sub.offer(Notification{
			Method: method,
			Params: notifyParams{ID: sub.id, Seq: seq, Event: record},
		}, live)
	}
}

// notifyParams is the event's own JSON with the subscription ID for routing,
// and its seq, in front of it: one flat object, as the frontend reads it.
type notifyParams struct {
	ID string `json:"id"`
	// Seq is the record's address in the session's history, the same number
	// replayed history is stamped with, so a client cannot tell a live record
	// from a replayed one when it names it later. Omitted for an event that was
	// never persisted.
	Seq   session.HistorySeq `json:"seq,omitempty"`
	Event agent.Wire         `json:"-"`
}

// MarshalJSON flattens Event into the params, which embedding cannot do for
// an interface. The event cannot carry an "id" or "seq" of its own: no wire
// type has either field.
func (p notifyParams) MarshalJSON() ([]byte, error) {
	type head notifyParams
	routing, err := json.Marshal(head(p))
	if err != nil {
		return nil, err
	}
	event, err := json.Marshal(p.Event)
	if err != nil {
		return nil, err
	}
	// Both are non-empty objects: routing always has "id", the event "type".
	out := make([]byte, 0, len(routing)+len(event))
	out = append(out, routing[:len(routing)-1]...)
	out = append(out, ',')
	return append(out, event[1:]...), nil
}

// Subscribe registers a subscriber for a specific session under the
// client-chosen id and returns the newest page of that session's history.
//
// Both the registration and the session mapping precede the history read, so a
// record written in between is notified rather than lost. Rare duplicates are
// acceptable; message loss is not. (A record landing in the shorter window
// between the two is not routed to this subscriber, but it is in the history
// read right after, so it is not lost either.)
//
// limit follows session.PageHistory: zero asks for the default page size. Older
// pages are fetched out of band (chat.messages.history) rather than through the
// subscription, because they can never change and never arrive on their own —
// every record a live notification carries is newer than this page.
func (w *ChatMessagesWatcher) Subscribe(
	id string,
	notifier Notifier,
	sessionID string,
	limit int,
) (session.HistoryPage, error) {
	if err := w.AddSubscription(&Subscription{ID: id, Notifier: notifier}); err != nil {
		return session.HistoryPage{}, err
	}

	sub := newChatSubscriber(id, sessionID, notifier)
	w.sessionMu.Lock()
	w.sessionToSub[sessionID] = append(w.sessionToSub[sessionID], sub)
	w.idToSub[id] = sub
	w.sessionMu.Unlock()
	w.Go(func() { sub.run(w.Context()) })

	history, err := w.store.GetHistory(context.Background(), sessionID)
	if err != nil {
		w.Unsubscribe(id)
		return session.HistoryPage{}, err
	}

	page, err := session.PageHistory(history, session.NoHistorySeq, limit)
	if err != nil {
		w.Unsubscribe(id)
		return session.HistoryPage{}, err
	}

	return page, nil
}

// Unsubscribe removes a subscription.
func (w *ChatMessagesWatcher) Unsubscribe(id string) {
	w.sessionMu.Lock()
	w.removeSessionMapping(id)
	w.sessionMu.Unlock()

	w.RemoveSubscription(id)
}

// removeSessionMapping removes session mapping for a subscription and stops
// its delivery. Caller must hold sessionMu.
func (w *ChatMessagesWatcher) removeSessionMapping(id string) {
	sub, ok := w.idToSub[id]
	if !ok {
		return
	}
	sub.close()

	delete(w.idToSub, id)
	subs := w.sessionToSub[sub.sessionID]
	for i, v := range subs {
		if v == sub {
			w.sessionToSub[sub.sessionID] = append(subs[:i], subs[i+1:]...)
			break
		}
	}
	if len(w.sessionToSub[sub.sessionID]) == 0 {
		delete(w.sessionToSub, sub.sessionID)
	}
}

// IsViewing returns true if any client is subscribed to the given session's chat messages.
func (w *ChatMessagesWatcher) IsViewing(sessionID string) bool {
	w.sessionMu.RLock()
	defer w.sessionMu.RUnlock()
	return len(w.sessionToSub[sessionID]) > 0
}
