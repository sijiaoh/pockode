package watch

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/process"
	"github.com/pockode/server/session"
	"github.com/sourcegraph/jsonrpc2"
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

func NewChatMessagesWatcher(store session.Store) *ChatMessagesWatcher {
	return &ChatMessagesWatcher{
		BaseWatcher:  NewBaseWatcher("cm"),
		store:        store,
		msgCh:        make(chan process.ChatMessage, 256),
		sessionToIDs: make(map[string][]string),
		idToSession:  make(map[string]string),
	}
}

func (w *ChatMessagesWatcher) Start() error {
	go w.messageLoop()
	slog.Info("ChatMessagesWatcher started")
	return nil
}

func (w *ChatMessagesWatcher) Stop() {
	w.Cancel()
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
	sessionID := msg.SessionID
	eventType := msg.Event.EventType()
	method := "chat." + string(eventType)

	// Get subscription IDs for this session
	w.sessionMu.RLock()
	ids := make([]string, len(w.sessionToIDs[sessionID]))
	copy(ids, w.sessionToIDs[sessionID])
	w.sessionMu.RUnlock()

	if len(ids) == 0 {
		return
	}

	// Use EventRecord as the notification payload (single source of truth)
	record := msg.Event.ToRecord()

	for _, id := range ids {
		sub := w.GetSubscription(id)
		if sub == nil {
			continue
		}

		// Add subscription ID to params for client-side routing
		params := notifyParams{
			ID:          sub.ID,
			EventRecord: record,
		}

		if err := sub.Conn.Notify(context.Background(), method, params); err != nil {
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
	agent.EventRecord
}

// Subscribe registers a subscriber for a specific session.
// Returns subscription ID and history.
func (w *ChatMessagesWatcher) Subscribe(
	conn *jsonrpc2.Conn,
	connID string,
	sessionID string,
) (string, []json.RawMessage, error) {
	id := w.GenerateID()
	sub := &Subscription{
		ID:     id,
		ConnID: connID,
		Conn:   conn,
	}

	// Lock order: sessionMu → subMu (consistent with Unsubscribe/CleanupConnection)
	w.sessionMu.Lock()
	w.sessionToIDs[sessionID] = append(w.sessionToIDs[sessionID], id)
	w.idToSession[id] = sessionID
	w.sessionMu.Unlock()

	// Register subscription BEFORE getting history to avoid message loss.
	// Rare duplicates are acceptable; message loss is not.
	w.AddSubscription(sub)

	history, err := w.store.GetHistory(context.Background(), sessionID)
	if err != nil {
		w.Unsubscribe(id)
		return "", nil, err
	}

	return id, history, nil
}

// Unsubscribe removes a subscription.
func (w *ChatMessagesWatcher) Unsubscribe(id string) {
	w.sessionMu.Lock()
	w.removeSessionMapping(id)
	w.sessionMu.Unlock()

	w.RemoveSubscription(id)
}

// CleanupConnection removes all subscriptions for a connection.
func (w *ChatMessagesWatcher) CleanupConnection(connID string) {
	// Get subscription IDs first (releases subMu before acquiring sessionMu)
	subs := w.GetSubscriptionsByConnID(connID)
	if len(subs) == 0 {
		return
	}

	// Collect IDs to avoid holding lock during iteration
	ids := make([]string, len(subs))
	for i, sub := range subs {
		ids[i] = sub.ID
	}

	// Lock order: sessionMu → subMu (consistent with Subscribe/Unsubscribe)
	w.sessionMu.Lock()
	for _, id := range ids {
		w.removeSessionMapping(id)
	}
	w.sessionMu.Unlock()

	w.BaseWatcher.CleanupConnection(connID)
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
