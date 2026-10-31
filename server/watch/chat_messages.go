package watch

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/canvas"
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

	// A losable event gives way rather than crowding out one that is not.
	//
	// tool_activity and thinking_delta are the high-frequency events Pockode
	// forwards — a chatty command produces one per chunk of stdout, a reasoning
	// summary one per few words — and the only ones whose loss costs nothing
	// lasting: the whole output arrives again with the result, the whole
	// thinking with its record, and a client that subscribes is handed the
	// newest activity line (agent.EventType.Persisted). Everything else in this
	// buffer happens once, and a dropped `done` leaves a finished turn drawn as
	// running until the client resubscribes. Without a reserve, a burst of
	// progress could evict one.
	//
	// Half the buffer is a reserve, not a tuned figure: it only engages once the
	// consumer has fallen far behind, which is exactly when the cheapest thing
	// to drop should be dropped.
	if !msg.Event.EventType().Persisted() && len(w.msgCh) > cap(w.msgCh)/2 {
		slog.Debug("dropped a live progress update to keep room for events that cannot be lost",
			"sessionId", msg.SessionID, "queued", len(w.msgCh))
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
	subs := w.sessionSubscriptions(sessionID)
	if len(subs) == 0 {
		return
	}

	method := "chat." + string(record.Type)

	for _, sub := range subs {
		if sub.Notifier == exclude {
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

// sessionSubscriptions are the subscriptions currently open on a session.
func (w *ChatMessagesWatcher) sessionSubscriptions(sessionID string) []*Subscription {
	w.sessionMu.RLock()
	ids := make([]string, len(w.sessionToIDs[sessionID]))
	copy(ids, w.sessionToIDs[sessionID])
	w.sessionMu.RUnlock()

	subs := make([]*Subscription, 0, len(ids))
	for _, id := range ids {
		if sub := w.GetSubscription(id); sub != nil {
			subs = append(subs, sub)
		}
	}
	return subs
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

// ChatSubscribed is what a new chat subscription starts from.
type ChatSubscribed struct {
	// Page is the newest page of the session's history.
	Page session.HistoryPage
	// Turn is the session's turn at the moment of subscribing, from the same
	// read as PermissionRequests, so that the two agree on what is pending.
	Turn session.TurnState
	// PermissionRequests are the stamped permission_request records of the
	// requests Turn has pending, oldest first, whatever page they are on
	// (docs/canvas-ui.md §10.4).
	PermissionRequests []json.RawMessage
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
// The turn, and with it the pending requests, is read after the registration
// too, and that is what makes the requests complete. A request's record that
// the history read missed was written after the registration, so it reaches
// this subscriber live. One the history holds had its blocker settled before
// it was written — a process settles the turn first (process.Process.
// handleEvent) — so the turn read here names it unless it has already been
// answered.
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
) (ChatSubscribed, error) {
	sub := &Subscription{
		ID:       id,
		Notifier: notifier,
	}
	if err := w.AddSubscription(sub); err != nil {
		return ChatSubscribed{}, err
	}

	w.sessionMu.Lock()
	w.sessionToIDs[sessionID] = append(w.sessionToIDs[sessionID], id)
	w.idToSession[id] = sessionID
	w.sessionMu.Unlock()

	fail := func(err error) (ChatSubscribed, error) {
		w.Unsubscribe(id)
		return ChatSubscribed{}, err
	}

	history, err := w.store.GetHistory(context.Background(), sessionID)
	if err != nil {
		return fail(err)
	}

	page, err := session.PageHistory(history, session.NoHistorySeq, limit)
	if err != nil {
		return fail(err)
	}

	meta, _, err := w.store.Get(sessionID)
	if err != nil {
		return fail(err)
	}
	var pending []string
	for _, b := range meta.Turn.Blockers {
		if b.Kind == session.BlockerPermission {
			pending = append(pending, b.RequestID)
		}
	}
	var requests []json.RawMessage
	for _, i := range agent.PermissionRequestIndexes(history, pending) {
		requests = append(requests, session.RecordAt(history, i))
	}

	return ChatSubscribed{Page: page, Turn: meta.Turn, PermissionRequests: requests}, nil
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

// NotifyRecord broadcasts a record the server wrote itself to all session
// subscribers except the given one. It is how a record that never passes
// through a process's event stream — a message a client sent, a question
// Pockode posted on an agent's behalf, its withdrawal — reaches the other
// clients watching the same session without waiting for a reload.
func (w *ChatMessagesWatcher) NotifyRecord(sessionID string, record agent.EventRecord, seq session.HistorySeq, exclude Notifier) {
	w.notifyEvent(sessionID, record, seq, exclude)
}

// NotifyCanvasState pushes a canvas session's new canvas to every chat
// subscriber of the session, as chat.canvas_state.
//
// It is not a record — no seq, never in history — and goes out beside the
// record stream rather than through it: each notification carries the whole
// state, so one arriving before a record it came after, or after a newer one,
// costs nothing; the client keeps the highest revision (docs/canvas-ui.md
// §13.2).
func (w *ChatMessagesWatcher) NotifyCanvasState(sessionID string, state canvas.State) {
	for _, sub := range w.sessionSubscriptions(sessionID) {
		n := Notification{Method: "chat.canvas_state", Params: canvasStateParams{ID: sub.ID, Canvas: state}}
		if err := sub.Notifier.Notify(context.Background(), n); err != nil {
			slog.Debug("failed to notify subscriber",
				"id", sub.ID,
				"sessionId", sessionID,
				"error", err)
		}
	}
}

type canvasStateParams struct {
	ID     string       `json:"id"`
	Canvas canvas.State `json:"canvas"`
}
