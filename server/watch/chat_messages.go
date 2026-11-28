package watch

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/chatstream"
	"github.com/pockode/server/projection"
	"github.com/pockode/server/rpc"
	"github.com/pockode/server/session"
)

// ChatProjections is what the watcher reads a session's transcript from: the
// pages a subscription starts from, and the updates that keep it current
// (projection.Live).
type ChatProjections interface {
	projection.Source
	TakeUpdate(ctx context.Context, sessionID string) (u projection.Update, continuous bool, err error)
	// Since is what a resumed subscription starts from (projection.Live.Since).
	Since(ctx context.Context, sessionID string, seq session.HistorySeq) (projection.Update, error)
}

// ChatUpdateMethod is the notification that carries what one history record
// changed in the transcript: the turns and items it changed, each as it stands
// now (projection.Update). Params: updateParams.
const ChatUpdateMethod = "chat.update"

// ChatDeltaMethod is the notification that extends a live stream: the next
// piece of the main agent's thinking, or what a call in flight said about
// itself (rpc.ChatStreams). Params: deltaParams.
const ChatDeltaMethod = "chat.delta"

// ChatMessagesWatcher manages subscriptions for chat messages. It is the
// chatstream.Sink every record of a session is handed to, in seq order, by the
// session's sequencer, and it tells subscribers what each record changed in
// the transcript rather than the record itself: the projection has folded the
// record by the time it is handed here (session.HistoryObserver runs inside
// the append), and the update is taken from it.
//
// It also keeps each session's live streams — what is being generated and is
// in no record yet — so a subscriber that arrives mid-stream starts from where
// the stream is (rpc.ChatStreams), and ends each with the update that settles
// it.
//
// The sequencer only enqueues: every subscriber has a bounded queue of its own,
// drained by a goroutine of its own (chatSubscriber), so a subscriber that
// falls behind holds up neither the agent producing the records nor the other
// subscribers. See docs/code/subscription-system.md#chat-delivery.
type ChatMessagesWatcher struct {
	*BaseWatcher
	// projections keeps the projection of every session with a subscriber
	// (projection.Live), which is what a subscription's first page is cut
	// from and what its updates are taken from.
	projections ChatProjections

	// sessionMu is held exclusively for the whole fan-out of one record or
	// live event, so every subscriber of a session queues them in the same
	// order, and a subscription's stream snapshot is taken between two of them.
	sessionMu    sync.RWMutex
	sessionToSub map[string][]*chatSubscriber // sessionID -> subscribers
	idToSub      map[string]*chatSubscriber   // subscription ID -> subscriber
	// releases holds the projection hold of each session in sessionToSub.
	releases map[string]func()
	// streams are the live streams of each session that has one open,
	// subscribed or not: a stream that began before anyone looked is the one
	// a subscriber arriving mid-run most needs.
	streams map[string]*chatStreams
}

var _ chatstream.Sink = (*ChatMessagesWatcher)(nil)
var _ Watcher = (*ChatMessagesWatcher)(nil)
var _ ViewingChecker = (*ChatMessagesWatcher)(nil)

func NewChatMessagesWatcher(projections ChatProjections) *ChatMessagesWatcher {
	return &ChatMessagesWatcher{
		BaseWatcher:  NewBaseWatcher(),
		projections:  projections,
		sessionToSub: make(map[string][]*chatSubscriber),
		idToSub:      make(map[string]*chatSubscriber),
		releases:     make(map[string]func()),
		streams:      make(map[string]*chatStreams),
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

// Enqueue tells every subscriber of the session what record changed — or,
// for a live event, extends the stream it belongs to — and returns without
// waiting for any of them. Each subscriber receives what it is given in the
// order Enqueue was called, and its one caller, the session's
// chatstream.Sequencer, calls it in seq order and never twice at once for one
// session, so updates reach the wire in seq order.
//
// seq is where the record landed in the session's history, or
// session.NoHistorySeq for a live event — and for the warning standing in for
// a record that could not be written, which is in no history and is sent as an
// item of its own that nothing will update.
func (w *ChatMessagesWatcher) Enqueue(sessionID string, record agent.Wire, seq session.HistorySeq) {
	if w.Context().Err() != nil {
		return
	}
	switch ev := record.(type) {
	case agent.ThinkingDeltaLiveEvent:
		w.sessionMu.Lock()
		defer w.sessionMu.Unlock()
		w.thinkingDelta(sessionID, ev)
	case agent.ToolActivityLiveEvent:
		w.sessionMu.Lock()
		defer w.sessionMu.Unlock()
		w.toolDelta(sessionID, ev)
	case agent.WarningRecord:
		if !seq.Valid() {
			w.sessionMu.Lock()
			defer w.sessionMu.Unlock()
			w.fanOut(sessionID, projection.Update{Items: []projection.ItemUpdate{{Item: projection.UnrecordedWarning(ev)}}}, nil)
			return
		}
		w.recordWritten(sessionID, seq)
	case agent.Record:
		w.recordWritten(sessionID, seq)
	}
}

// recordWritten tells the session's subscribers what the record at seq
// changed.
//
// The update is taken before sessionMu: the sequencer never hands one
// session two records at once, so taking it outside keeps a projection being
// loaded from holding up every other session's fan-out. An update taken here
// and fanned out after a subscription registered in between is in what that
// subscription started from as well — its page, or its resumed update; the
// subscriber skips it by through_seq (see Subscribe).
func (w *ChatMessagesWatcher) recordWritten(sessionID string, seq session.HistorySeq) {
	update, continuous, err := w.projections.TakeUpdate(w.Context(), sessionID)
	if errors.Is(err, session.ErrSessionNotFound) {
		// Nothing will settle what a deleted session was streaming.
		w.sessionMu.Lock()
		delete(w.streams, sessionID)
		w.sessionMu.Unlock()
		return
	}
	if err != nil {
		slog.Error("failed to read what a record changed; asking the session's subscribers to resync",
			"sessionId", sessionID, "seq", seq, "error", err)
		continuous = false
	}

	background := w.backgroundCalls(sessionID, update)

	w.sessionMu.Lock()
	defer w.sessionMu.Unlock()
	if !continuous {
		// Whatever the projection lost between updates is in no update: a
		// fresh page is the only way to it.
		for _, sub := range w.sessionToSub[sessionID] {
			sub.requestResync()
		}
	}
	var ended *streamsEnded
	if st := w.streams[sessionID]; st != nil {
		ended = st.settle(update, background)
		if ended != nil {
			w.forgetGaps(sessionID, ended)
		}
		if st.empty() {
			delete(w.streams, sessionID)
		}
	}
	if update.Empty() && ended == nil {
		return
	}
	w.fanOut(sessionID, update, ended)
}

// backgroundCalls are which of the session's streamed calls are in the
// background, read when update ends a turn and some call's stream is open:
// those streams outlive the turn (chatStreams.settle). Read off the
// projection rather than kept from updates, since a call can go into the
// background before anything streamed of the session. Nothing else of the
// session is enqueued meanwhile, so the streams it reads are the ones settled.
func (w *ChatMessagesWatcher) backgroundCalls(sessionID string, update projection.Update) map[string]bool {
	if !endsTurn(update) {
		return nil
	}
	w.sessionMu.RLock()
	var ids []string
	if st := w.streams[sessionID]; st != nil {
		for id := range st.tools {
			ids = append(ids, id)
		}
	}
	w.sessionMu.RUnlock()
	if len(ids) == 0 {
		return nil
	}
	state, err := w.projections.State(w.Context(), sessionID)
	if err != nil {
		slog.Warn("failed to read which calls are in the background; their streams end with the turn",
			"sessionId", sessionID, "error", err)
		return nil
	}
	background := make(map[string]bool, len(ids))
	for _, id := range ids {
		if item, ok := state.Item(id); ok && item.Status == projection.ItemBackground {
			background[id] = true
		}
	}
	return background
}

// fanOut queues an update for every subscriber of the session, the one whose
// connection sent the record among them: the record is the sender's one copy
// of its own message too, which its echo is matched to by the id it minted.
// Caller holds sessionMu.
func (w *ChatMessagesWatcher) fanOut(sessionID string, update projection.Update, ended *streamsEnded) {
	for _, sub := range w.sessionToSub[sessionID] {
		sub.offer(Notification{
			Method: ChatUpdateMethod,
			Params: updateParams{ID: sub.id, Update: update, StreamsEnded: ended},
		}, false)
	}
}

// updateParams is a chat.update: the subscription id for routing, the
// update, and the live streams it ended.
type updateParams struct {
	ID string `json:"id"`
	projection.Update
	// StreamsEnded are the live streams this update settled: the thinking item
	// or the turn change that ends the thinking stream, the call that is no
	// longer in flight. A client drops its copy of each.
	StreamsEnded *streamsEnded `json:"streams_ended,omitempty"`
}

// ChatStart is what a subscription starts from: the newest page of the
// transcript, or — for a subscriber that asked to resume and could — the
// update that brings the copy it holds up to date. Exactly one of Page and
// Resumed is set.
type ChatStart struct {
	Page    *projection.Page
	Resumed *projection.Update
	// Streams are the session's live streams as of the moment the
	// subscription registered, either way: they are never recorded, so a
	// resumed copy's are as stale as its items, and are replaced by these.
	Streams rpc.ChatStreams
}

// Subscribe registers a subscriber for a specific session under the
// client-chosen id and returns what it starts from (ChatStart), with its live
// streams as of the moment it registered.
//
// resumeAfter, when it is a seq, is the newest record the subscriber already
// holds — the through_seq of the last page or update it applied, from this
// same server process. It is then sent what the records after it changed
// (projection.Live.Since) rather than a page, and keeps whatever it had paged
// in. When that cannot be answered — the seq is past the history or too far
// behind it, or the history holds a line in no file
// (projection.ErrResumeUnavailable) — it is sent the newest page,
// as a subscriber that did not ask is: a fresh start is never wrong, only
// costlier for the client. NoHistorySeq asks for the page.
//
// The registration and the stream snapshot are taken together, between two
// fan-outs, so the chat.delta notifications the subscriber is sent continue
// the snapshot with nothing missed and nothing repeated. The page — or the
// resumed update — is cut after both, so a record written in between is
// notified rather than lost. Its update is in what the subscriber started
// from as well: an update whose through_seq is not past the start's
// through_seq says nothing the start does not, as of a moment no later, and
// its items are to be skipped — but not its streams_ended, which the
// snapshot taken before it does not know of.
//
// The hold taken for the subscriber precedes the page too, so the page is cut
// from the projection kept for the session, and every page after it while the
// subscription lasts (chat.messages.history) is cut from the same one without
// the history file being read again.
//
// limit follows projection.Projection.Page: zero asks for the default budget.
// Older pages are fetched out of band (chat.messages.history) rather than
// through the subscription, because they never arrive on their own: what an
// update carries is newer than this page.
func (w *ChatMessagesWatcher) Subscribe(
	ctx context.Context,
	id string,
	notifier Notifier,
	sessionID string,
	limit int,
	resumeAfter session.HistorySeq,
) (ChatStart, error) {
	// Checked before anything is registered, as the page's own is: a limit
	// the client cannot ask for is refused whether or not it resumes.
	if limit < 0 {
		return ChatStart{}, fmt.Errorf("%w: limit %d is negative", projection.ErrInvalidLimit, limit)
	}
	if err := w.AddSubscription(&Subscription{ID: id, Notifier: notifier}); err != nil {
		return ChatStart{}, err
	}

	sub := newChatSubscriber(id, sessionID, notifier)
	w.sessionMu.Lock()
	if len(w.sessionToSub[sessionID]) == 0 {
		w.releases[sessionID] = w.projections.Hold(sessionID)
	}
	w.sessionToSub[sessionID] = append(w.sessionToSub[sessionID], sub)
	w.idToSub[id] = sub
	streams := w.streams[sessionID].snapshot()
	w.sessionMu.Unlock()
	w.Go(func() { sub.run(w.Context()) })

	start := ChatStart{Streams: streams}
	if resumeAfter.Valid() {
		resumed, err := w.projections.Since(ctx, sessionID, resumeAfter)
		switch {
		case err == nil:
			start.Resumed = &resumed
			return start, nil
		case errors.Is(err, projection.ErrResumeUnavailable):
			slog.Info("cannot resume the chat subscription; sending a fresh page",
				"id", id, "sessionId", sessionID, "reason", err)
		default:
			w.Unsubscribe(id)
			return ChatStart{}, err
		}
	}
	page, err := w.projections.Page(ctx, sessionID, session.NoHistorySeq, limit)
	if err != nil {
		w.Unsubscribe(id)
		return ChatStart{}, err
	}
	start.Page = &page
	return start, nil
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
		w.releases[sub.sessionID]()
		delete(w.releases, sub.sessionID)
	}
}

// IsViewing returns true if any client is subscribed to the given session's chat messages.
func (w *ChatMessagesWatcher) IsViewing(sessionID string) bool {
	w.sessionMu.RLock()
	defer w.sessionMu.RUnlock()
	return len(w.sessionToSub[sessionID]) > 0
}
