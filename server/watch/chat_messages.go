package watch

import (
	"context"
	"log/slog"
	"sync"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/process"
	"github.com/pockode/server/session"
)

// ChatMessagesWatcher manages subscriptions for chat messages.
// Implements process.ChatMessageListener to receive messages from ProcessManager.
type ChatMessagesWatcher struct {
	*BaseWatcher
	store session.Store
	msgCh chan process.ChatMessage

	sessionMu    sync.RWMutex
	sessionToIDs map[string][]string // sessionID -> subscription IDs
	idToSession  map[string]string   // subscription ID -> sessionID
}

var _ process.ChatMessageListener = (*ChatMessagesWatcher)(nil)
var _ Watcher = (*ChatMessagesWatcher)(nil)
var _ ViewingChecker = (*ChatMessagesWatcher)(nil)

func NewChatMessagesWatcher(store session.Store) *ChatMessagesWatcher {
	return &ChatMessagesWatcher{
		BaseWatcher:  NewBaseWatcher(),
		store:        store,
		msgCh:        make(chan process.ChatMessage, 256),
		sessionToIDs: make(map[string][]string),
		idToSession:  make(map[string]string),
	}
}

func (w *ChatMessagesWatcher) Start() error {
	w.Go(w.messageLoop)
	slog.Info("ChatMessagesWatcher started")
	return nil
}

func (w *ChatMessagesWatcher) Stop() {
	w.CancelAndWait()
	slog.Info("ChatMessagesWatcher stopped")
}

// OnChatMessage implements process.ChatMessageListener.
// Called from Process.streamEvents(), must not block.
func (w *ChatMessagesWatcher) OnChatMessage(msg process.ChatMessage) {
	if w.Context().Err() != nil {
		return
	}

	select {
	case w.msgCh <- msg:
	default:
		slog.Warn("chat message dropped (buffer full)",
			"sessionId", msg.SessionID,
			"type", msg.Event.EventType())
	}
}

func (w *ChatMessagesWatcher) messageLoop() {
	for {
		select {
		case <-w.Context().Done():
			return
		case msg := <-w.msgCh:
			w.notifyMessage(msg)
		}
	}
}

func (w *ChatMessagesWatcher) notifyMessage(msg process.ChatMessage) {
	w.notifyEvent(msg.SessionID, msg.Event.ToRecord(), msg.Seq, nil)
}

// notifyEvent broadcasts an event to session subscribers, optionally excluding one notifier.
func (w *ChatMessagesWatcher) notifyEvent(sessionID string, record agent.EventRecord, seq session.HistorySeq, exclude Notifier) {
	w.sessionMu.RLock()
	ids := make([]string, len(w.sessionToIDs[sessionID]))
	copy(ids, w.sessionToIDs[sessionID])
	w.sessionMu.RUnlock()

	if len(ids) == 0 {
		return
	}

	method := "chat." + string(record.Type)

	for _, id := range ids {
		sub := w.GetSubscription(id)
		if sub == nil || sub.Notifier == exclude {
			continue
		}

		params := notifyParams{
			ID:          sub.ID,
			Seq:         seq,
			EventRecord: record,
		}

		n := Notification{Method: method, Params: params}
		if err := sub.Notifier.Notify(context.Background(), n); err != nil {
			slog.Debug("failed to notify subscriber",
				"id", sub.ID,
				"sessionId", sessionID,
				"error", err)
		}
	}
}

// notifyParams embeds EventRecord with subscription ID for routing.
type notifyParams struct {
	ID string `json:"id"`
	// Seq is the record's address in the session's history, the same number
	// replayed history is stamped with, so a client cannot tell a live record
	// from a replayed one when it names it later. Omitted for an event that was
	// never persisted.
	Seq session.HistorySeq `json:"seq,omitempty"`
	agent.EventRecord
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
	sub := &Subscription{
		ID:       id,
		Notifier: notifier,
	}
	if err := w.AddSubscription(sub); err != nil {
		return session.HistoryPage{}, err
	}

	w.sessionMu.Lock()
	w.sessionToIDs[sessionID] = append(w.sessionToIDs[sessionID], id)
	w.idToSession[id] = sessionID
	w.sessionMu.Unlock()

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

// removeSessionMapping removes session mapping for a subscription. Caller must hold sessionMu.
func (w *ChatMessagesWatcher) removeSessionMapping(id string) {
	sessionID, ok := w.idToSession[id]
	if !ok {
		return
	}

	delete(w.idToSession, id)
	ids := w.sessionToIDs[sessionID]
	for i, v := range ids {
		if v == id {
			w.sessionToIDs[sessionID] = append(ids[:i], ids[i+1:]...)
			break
		}
	}
	if len(w.sessionToIDs[sessionID]) == 0 {
		delete(w.sessionToIDs, sessionID)
	}
}

// IsViewing returns true if any client is subscribed to the given session's chat messages.
func (w *ChatMessagesWatcher) IsViewing(sessionID string) bool {
	w.sessionMu.RLock()
	defer w.sessionMu.RUnlock()
	return len(w.sessionToIDs[sessionID]) > 0
}

// NotifyMessage broadcasts a user message to all session subscribers except the sender.
// This is used when a client sends a message to notify other clients (e.g., other tabs)
// watching the same session.
func (w *ChatMessagesWatcher) NotifyMessage(sessionID string, event agent.MessageEvent, seq session.HistorySeq, exclude Notifier) {
	w.notifyEvent(sessionID, event.ToRecord(), seq, exclude)
}
