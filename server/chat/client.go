package chat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/pockode/server/agent"
	"github.com/pockode/server/chatstream"
	"github.com/pockode/server/htmlpage"
	"github.com/pockode/server/process"
	"github.com/pockode/server/projection"
	"github.com/pockode/server/session"
)

// ErrSessionNotFound is the session store's own sentinel, not a second one
// beside it: whoever sends through a Client only knows it as a
// work.MessageSender, and has to be able to tell a deleted session from a
// fault without importing this package (work.Engine.notifyWatcher).
var ErrSessionNotFound = session.ErrSessionNotFound

// ErrSessionNotRunning is returned when a request only makes sense to a live
// agent process and the session has none.
//
// Answers belong to the process that asked the question, so a prompt whose
// process is gone — reaped after an idle timeout, or replayed from history after
// a server restart — cannot be answered at all. Starting a process to receive the
// answer sends it nowhere and leaves that process marked running with nothing to
// run, which is worse than saying so.
var ErrSessionNotRunning = errors.New("session is no longer running, send a message to continue")

// ErrTurnAwaitingAnswer is returned when a message arrives while the turn is
// blocked on a permission request, which is the one state a message cannot be
// delivered in — including a message answering a posted question.
//
// Messages sent while a turn is merely *running* are fine and go straight
// through: both CLIs Pockode ships fold one into the running turn, which ends
// once for both messages (agent.Session.SendMessage). A CLI holding a request
// open is different — it is inside a tool call waiting for that answer and
// reads nothing else until it arrives. Measured on claude-code 2.1.263 and
// codex-cli 0.153.0: neither produced a single further event in the four
// minutes after a message was sent instead of an answer.
//
// So the message is refused rather than accepted. Accepting it would take the
// request off the user's screen — a prompt handed to the agent abandons whatever
// it was holding open (session.ReduceTurn's SignalPrompt) — leaving a turn open
// that only the answer to a now-unanswerable request could ever end, and no
// lease to collect it unless the operator set --turn-timeout. The user still has
// both ways forward: answer the request, or stop the turn and then send.
var ErrTurnAwaitingAnswer = errors.New("this turn is waiting for an answer to the request on screen: answer it, or stop the turn, then send")

// ErrAttachmentsUnsupported is returned when a message carries files and the
// session's agent has no way to hand them over (agent.AttachmentReceiver).
//
// Refused rather than sent without them: the agent would answer a message whose
// screenshot it never saw, and nothing on the screen would say so.
var ErrAttachmentsUnsupported = errors.New("this session's agent cannot receive attached files; send the message without them")

// ErrForkAnchorOutOfRange is returned when the anchor names no record of the
// source session's history.
var ErrForkAnchorOutOfRange = errors.New("fork anchor is outside the session's history")

// ErrForkAnchorNoHistory is returned when the anchor is a message the user sent
// and nothing precedes it: the fork would cut to an empty conversation.
//
// Refused rather than made empty. A session with no history is not a branch of
// anything, and creating one silently would answer "forked" to a request that
// carried nothing across (AGENTS.md: no silent failures).
var ErrForkAnchorNoHistory = errors.New("there is no conversation before this message to keep")

// ErrForkUnsupported is returned when the source session's agent answers
// agent.ForkUnsupported: it cannot reopen an earlier conversation at all.
//
// The fork is refused rather than made without the agent. A session whose agent
// has never seen the transcript filling its screen is not a branch of the
// conversation, and session.fork must not claim to do something it does not do
// just because the Pockode side of it would have worked.
var ErrForkUnsupported = errors.New("this session's agent does not support forking")

// ErrRecordedNotDelivered is what a retry is told when the attempt it retries
// wrote the message's record but then failed to hand the message over: the
// transcript has the message, the agent does not. Not answered as a success —
// the record existing is not the message being delivered — and not sent again
// under the same id either, which would leave one record standing for a
// message the agent read later than it says. Sending it as a new message is
// the user's call.
var ErrRecordedNotDelivered = errors.New("this message was saved but never reached the agent; send it again as a new message")

// Client coordinates chat operations across session and process management.
// It is the single entry point for programmatic chat interactions.
type Client struct {
	store session.Store
	// projections is what store's histories say (projection.Live), which is
	// where what became of a question is read.
	projections projection.Source
	pm          *process.Manager
	// stream is the process manager's, so what this client writes and what
	// the session's process writes take their places in one order.
	stream  *chatstream.Sequencer
	settled QuestionsSettledFunc
	// postMu keeps each PostQuestions call's questions contiguous; see there.
	postMu sync.Mutex
	// sending holds, by session and message id, the send under way for each
	// (sendOnce); its channel closes when it is done. undelivered holds the
	// sends whose record was written and whose handover then failed, with why;
	// unrecorded the sends handed over whose record could not be written.
	sendingMu   sync.Mutex
	sending     map[string]chan struct{}
	undelivered map[string]error
	unrecorded  map[string]struct{}
}

func NewClient(store session.Store, projections projection.Source, pm *process.Manager) *Client {
	return &Client{store: store, projections: projections, pm: pm, stream: pm.Stream(), sending: map[string]chan struct{}{}, undelivered: map[string]error{}, unrecorded: map[string]struct{}{}}
}

// QuestionsSettledFunc is told when posted questions stop waiting in a session,
// however that happened: answered, declined, or withdrawn. Questions settled
// together arrive in one call — one message answering several, one work closing
// over several — so that whoever passes the news on can pass it on as one.
//
// It is called after the session's state already says so, on the caller's
// goroutine, and must not block.
type QuestionsSettledFunc func(sessionID string, settled []agent.SettledQuestion)

// SetOnQuestionsSettled sets what is told when posted questions stop waiting.
// It is the one place a question leaves the unanswered list on purpose, so it
// is the one place to learn it from — every way of settling one goes through
// this client.
func (c *Client) SetOnQuestionsSettled(fn QuestionsSettledFunc) {
	c.settled = fn
}

func (c *Client) notifySettled(sessionID string, settled []agent.SettledQuestion) {
	if c.settled != nil && len(settled) > 0 {
		c.settled(sessionID, settled)
	}
}

// SendMessage sends a user message to the agent process, persists it to
// history, and broadcasts it to every session subscriber — the client that
// sent it among them, which learns its own message from that broadcast like
// every other.
//
// messageID is the id the sender minted for the message, and goes into its
// record (agent.MessageRecord.MessageID): it is what ties the sender's own
// copy of the message to the record, and it makes a retry safe — a send under
// an id history already carries delivers nothing and writes nothing, and is
// answered with the record the first attempt wrote (Sent.Retried). Empty has
// the id minted here, for a sender that names none.
//
// The zero Sent when the record was not persisted — see sendEvent.
//
// attachments are files already in the session's attachment store; the message
// is refused whole with ErrAttachmentsUnsupported when the agent cannot take
// them.
func (c *Client) SendMessage(ctx context.Context, sessionID, content string, attachments []agent.Attachment, messageID string) (Sent, error) {
	return c.sendOnce(ctx, sessionID, messageID, func() (Sent, error) {
		return c.sendEvent(ctx, sessionID, agent.MessageEvent{Content: content, MessageID: messageID}, attachments)
	})
}

// SendCommand is SendMessage for a Pockode command: content is the prompt the
// command expanded to, which is what the agent reads and what the record holds,
// and cmd is what the user typed. It is still the user's message — the origin
// is theirs, so it forks and drives a work like any other.
func (c *Client) SendCommand(ctx context.Context, sessionID, content string, cmd agent.CommandInvocation, attachments []agent.Attachment, messageID string) (Sent, error) {
	return c.sendOnce(ctx, sessionID, messageID, func() (Sent, error) {
		return c.sendEvent(ctx, sessionID, agent.MessageEvent{Content: content, Command: &cmd, MessageID: messageID}, attachments)
	})
}

// SendHTMLAction is SendMessage for something a page in the chat sent on the
// reader's press. It is the user's message like any other — refused while a
// permission request is open, folded into a running turn — but its content is
// machine text (htmlpage.ActionText), which is what the record's html_action
// says.
//
// The caller has checked that the page exists in the session.
func (c *Client) SendHTMLAction(ctx context.Context, sessionID string, action htmlpage.Action, messageID string) (Sent, error) {
	return c.sendOnce(ctx, sessionID, messageID, func() (Sent, error) {
		return c.sendEvent(ctx, sessionID, agent.MessageEvent{
			Content: htmlpage.ActionText(action), HTMLAction: &action, MessageID: messageID,
		}, nil)
	})
}

// SendSystemMessage sends a system-driven automatic message (kickoff, restart,
// auto-continue, etc.). It is tagged with origin "system" plus a subtype and
// optional meta so the frontend can fold it into the receiving work's progress
// card rather than render it as a user bubble.
func (c *Client) SendSystemMessage(ctx context.Context, sessionID, content string, subtype agent.MessageSubtype, meta *agent.MessageMeta) error {
	event := agent.MessageEvent{
		Content: content,
		Origin:  agent.MessageOriginSystem,
		Subtype: subtype,
		Meta:    meta,
	}
	_, err := c.sendEvent(ctx, sessionID, event, nil)
	return err
}

// Sent names the record a message was written to: its address in history and
// its id. Both are zero when the record could not be written — there is then
// nothing to name.
type Sent struct {
	Seq       session.HistorySeq
	MessageID string
	// Retried says the record was already in history, written by an earlier
	// attempt at the same send: this one delivered nothing and wrote nothing,
	// so whatever a send sets off has been set off already.
	Retried bool
}

// sendOnce runs send unless history already holds a message under messageID,
// in which case it answers with that record (Sent.Retried). Sends under one
// id are taken one at a time, so a retry that arrives while the first
// attempt is still being handed over waits for it and then finds its record,
// rather than writing a second.
//
// A first attempt that was refused leaves nothing to find, and the retry is
// sent afresh. Two outcomes leave history disagreeing with what the agent got,
// and are remembered instead: one handed over whose record could not be
// written is answered as sent, and one that wrote the record and then failed
// to hand the message over has its retry refused with
// ErrRecordedNotDelivered. Remembered only for the life of this process,
// which is also as long as the agent the message did or did not reach lives;
// both are rare, so the entries are never let go.
//
// History that cannot be read leaves the retry unanswerable, and the message
// is sent anyway — a possible duplicate rather than a session a disk hiccup
// has made impossible to talk to, the trade sendEvent makes too.
func (c *Client) sendOnce(ctx context.Context, sessionID, messageID string, send func() (Sent, error)) (Sent, error) {
	if messageID == "" {
		return send()
	}
	key := sessionID + "\x00" + messageID
	release, err := c.claimSend(ctx, key)
	if err != nil {
		return Sent{}, err
	}
	defer release()
	c.sendingMu.Lock()
	cause, failed := c.undelivered[key]
	_, delivered := c.unrecorded[key]
	c.sendingMu.Unlock()
	switch {
	case failed:
		return Sent{}, fmt.Errorf("%w (%v)", ErrRecordedNotDelivered, cause)
	case delivered:
		return Sent{Retried: true}, nil
	}
	recorded, found, err := c.recorded(ctx, sessionID, messageID)
	switch {
	case errors.Is(err, ErrSessionNotFound):
		return Sent{}, err
	case err != nil:
		slog.Warn("failed to tell whether a send is a retry; sending it anyway",
			"sessionId", sessionID, "messageId", messageID, "error", err)
	case found:
		return Sent{Seq: recorded.Seq, MessageID: messageID, Retried: true}, nil
	}
	sent, err := send()
	if err == nil && !sent.Seq.Valid() {
		c.sendingMu.Lock()
		c.unrecorded[key] = struct{}{}
		c.sendingMu.Unlock()
	}
	if err != nil {
		// Failed after its record was written: the handover. Not cancelled
		// with the request: a sender that hung up is the one that will retry.
		_, written, lookupErr := c.recorded(context.WithoutCancel(ctx), sessionID, messageID)
		switch {
		case errors.Is(lookupErr, ErrSessionNotFound):
			// Nothing will be retried into a session that is gone.
		case lookupErr != nil:
			slog.Error("failed to tell whether a failed send was recorded; a retry of it will be answered as sent",
				"sessionId", sessionID, "messageId", messageID, "error", lookupErr)
		case written:
			c.sendingMu.Lock()
			c.undelivered[key] = err
			c.sendingMu.Unlock()
		}
	}
	return sent, err
}

// recorded is the record history holds under messageID, if any.
func (c *Client) recorded(ctx context.Context, sessionID, messageID string) (projection.RecordedMessage, bool, error) {
	msg, found, err := c.projections.Message(ctx, sessionID, messageID)
	if errors.Is(err, session.ErrSessionNotFound) {
		return msg, false, ErrSessionNotFound
	}
	if err != nil {
		return msg, false, fmt.Errorf("look up message %s: %w", messageID, err)
	}
	return msg, found, nil
}

// claimSend waits until no other send holds key, then holds it until release.
func (c *Client) claimSend(ctx context.Context, key string) (release func(), err error) {
	for {
		c.sendingMu.Lock()
		busy, held := c.sending[key]
		if !held {
			done := make(chan struct{})
			c.sending[key] = done
			c.sendingMu.Unlock()
			return func() {
				c.sendingMu.Lock()
				delete(c.sending, key)
				c.sendingMu.Unlock()
				close(done)
			}, nil
		}
		c.sendingMu.Unlock()
		select {
		case <-busy:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
}

// sendEvent delivers one message to the agent, records it, and tells subscribers.
// It returns what names the record, or the zero Sent if there is none. The
// event's MessageID is the sender's, or minted here when it named none.
func (c *Client) sendEvent(ctx context.Context, sessionID string, event agent.MessageEvent, attachments []agent.Attachment) (Sent, error) {
	proc, err := c.processToDeliverTo(ctx, sessionID, len(attachments) > 0)
	if err != nil {
		return Sent{}, err
	}
	for _, a := range attachments {
		event.Attachments = append(event.Attachments, a.File)
	}

	// Once, for every sender: it goes into the record, to the agent that can
	// carry it, and into the read point that names this message later.
	if event.MessageID == "" {
		event.MessageID = uuid.NewString()
	}
	// Minted once too, and for the same reason: the record and the turn this
	// message may open (session.TurnState.OpenedAt) must carry one instant, or
	// the reply's span a client reads from the record and the clock it counted
	// from the turn would disagree. A retry on a successor process reuses it —
	// the message reached Pockode only once.
	receivedAt := time.Now()
	event.ObservedAt = receivedAt

	// Recorded and shown to the subscribers before it is handed over, so
	// that it precedes everything the agent says in reply, on the wire as in
	// history. A handover that fails below leaves the record standing, as the
	// next reload would show it anyway.
	seq, err := c.stream.Append(ctx, sessionID, event.ToRecord())
	if err != nil {
		// The prompt still goes to the agent — it is worth answering whether or not
		// the transcript kept it, and refusing it here would turn a disk hiccup into
		// a session that cannot be talked to. The sequencer has told every
		// subscriber, the sender among them, that it was not saved. But the failed
		// append handed back no address, so nothing below may pass one on: a seq
		// nobody can resolve would send a later fork to whatever record eventually
		// takes that number.
		seq = session.NoHistorySeq
		// The id goes with it. There is no record carrying this id, so a read
		// point naming it would name nothing.
		event.MessageID = ""
	}

	prompt := agent.Prompt{Text: event.Content, ID: event.MessageID, Attachments: attachments}
	openedTurn, err := proc.SendMessage(prompt, receivedAt)
	for errors.Is(err, process.ErrProcessReplaced) {
		// Stopped between the fetch and here for a successor — to run as the
		// account chosen since, by another message's fetch. Nothing reached it,
		// and the record above is this message's either way, so the message
		// goes to the process the session has now. If that one cannot be had —
		// the new account cannot start — the record stays without an answer,
		// as it does for any send that fails after it was written.
		if proc, err = c.processToDeliverTo(ctx, sessionID, len(attachments) > 0); err != nil {
			return Sent{}, err
		}
		openedTurn, err = proc.SendMessage(prompt, receivedAt)
	}
	if err != nil {
		return Sent{}, err
	}

	// A message that joined a turn already under way is the one that needs a
	// boundary drawn: what the agent produces from here answers it rather than
	// the message above. One that opened its turn has nothing above it to cut
	// away. See agent.MessageIngestedEvent.
	//
	// seq.Valid() is the third condition and not a formality: a message whose
	// own record could not be written is not in the transcript, so a boundary
	// drawn for it would cut a conversation nothing in it asked a question of.
	if seq.Valid() && !openedTurn && !proc.ReportsMessageIngest() {
		c.noteIngested(ctx, sessionID, event.MessageID)
	}

	return Sent{Seq: seq, MessageID: event.MessageID}, nil
}

// processToDeliverTo returns the process a message is about to be handed to,
// with the session marked started, or the reason the message is refused.
//
// Before the append, not after: a refused message must leave no trace. A
// record written here would be in the transcript on the next reload of a
// conversation the agent never heard it in, which is a worse answer than the
// error — the send failed, and only the client that tried knows that.
//
// Asked of the process rather than of the agent, and asked for every sender:
// a kickoff or an auto-continuation lands in the same silence a typed message
// does, and a work nudged into a session that is holding a request open is
// nudged into nothing.
//
// The session is marked started only once nothing above can refuse the
// message, so a first message refused here leaves the session's guidance still
// open to a switch. A failure past this point (the handover itself) leaves it
// started: the message is in the transcript by then.
//
// Marking it fixes HTMLFirst, and the value it is fixed at is the one that
// counts: a switch that landed after the process was fetched but before the
// mark is honoured by fetching again, which replaces a process started with
// the old value. The second pass always matches — nothing can change the
// value of a started session.
func (c *Client) processToDeliverTo(ctx context.Context, sessionID string, hasAttachments bool) (*process.Process, error) {
	for {
		proc, err := c.getOrCreateProcess(ctx, sessionID)
		if err != nil {
			return nil, err
		}
		if proc.TurnState().AwaitingUserAnswer() {
			return nil, ErrTurnAwaitingAnswer
		}
		if hasAttachments && !proc.ReceivesAttachments() {
			return nil, ErrAttachmentsUnsupported
		}

		started, err := c.store.MarkStarted(ctx, sessionID)
		if err != nil {
			if errors.Is(err, session.ErrSessionNotFound) {
				return nil, ErrSessionNotFound
			}
			return nil, fmt.Errorf("mark session started: %w", err)
		}
		if proc.HTMLFirst() == started.HTMLFirst {
			return proc, nil
		}
	}
}

// noteIngested writes the read point for an agent that cannot report its own:
// the message has been handed over, and that moment is the earliest the agent
// could have taken it in. See agent.MessageIngestedEvent for why that
// approximation is the right direction to be wrong in.
//
// Written here rather than injected into the process's event stream so that it
// lands after the message it is about has been announced. History would hold
// them in the right order either way — the message was appended first — but a
// subscriber would be told the agent had read a message it had not yet been
// told about.
//
// A failed append is reported by the sequencer and fails nothing here. The
// message was delivered and the turn is under way; losing the boundary costs
// the reader a bubble break on the next reload, which is not worth failing a
// send that succeeded.
func (c *Client) noteIngested(ctx context.Context, sessionID, messageID string) {
	record := agent.ObserveAt(agent.MessageIngestedEvent{MessageID: messageID}, time.Now()).ToRecord()
	_, _ = c.stream.Append(ctx, sessionID, record)
}

func (c *Client) SendPermissionResponse(ctx context.Context, sessionID string, data agent.PermissionRequestData, choice agent.PermissionChoice) error {
	proc, err := c.liveProcess(sessionID)
	if err != nil {
		return err
	}

	if err := proc.SendPermissionResponse(data, choice); err != nil {
		return err
	}

	// Broadcast as well as stored: the client that answered has drawn its own
	// press, but every other client watching the session has not, and kept a
	// live card for an answered request until it reloaded. A failed write is
	// the sequencer's to report; the answer itself reached the agent, so the
	// request did not fail.
	record := agent.ObserveAt(agent.PermissionResponseEvent{
		RequestID: data.RequestID,
		Choice:    choice.Name(),
	}, time.Now()).ToRecord()
	_, _ = c.stream.Append(ctx, sessionID, record)
	return nil
}

// SendPermissionVerdict answers a permission request on a permission
// reviewer's behalf: allow approves that one request and nothing more, and deny
// leaves the turn running and tells the agent review's reason, so it can
// rewrite the call and carry on. The response is recorded as the reviewer's,
// with review on it, and broadcast like a person's answer.
//
// proc is the process that raised the request, not whichever one the session
// has now: a request id is only unique within the process that minted it
// (Codex's fallback ids restart with every process), so an answer meant for a
// request of a process since replaced must not land on a namesake in its
// successor.
//
// A request that is no longer waiting — a person answered first, it expired,
// its process went away — fails with process.ErrRequestNotPending, and nothing
// reaches the agent or the history: the first answer stands. The caller
// decides whether that is worth reporting.
func (c *Client) SendPermissionVerdict(ctx context.Context, proc *process.Process, data agent.PermissionRequestData, allow bool, review agent.PermissionReview) error {
	if !allow && !review.Category.Valid() {
		return fmt.Errorf("a permission reviewer's deny needs a category, got %q", review.Category)
	}
	return c.answerForReview(ctx, proc, data, allow, agent.RespondedByPermissionReviewer, review)
}

// DenyPermissionAutomatically is Pockode refusing a request that a permission
// reviewer was meant to answer and did not — or that a reviewer raised
// itself. Like a reviewer's deny it leaves the turn running and tells the
// agent why; it is recorded as Pockode's own (agent.RespondedByPockode) with
// review.Automatic saying which way the review fell through, so that no client
// mistakes it for a verdict. Refused requests and their errors are as for
// SendPermissionVerdict.
func (c *Client) DenyPermissionAutomatically(ctx context.Context, proc *process.Process, data agent.PermissionRequestData, review agent.PermissionReview) error {
	if review.Automatic == "" || review.Category != "" {
		return fmt.Errorf("an automatic deny needs a reason kind and no category, got %q / %q", review.Automatic, review.Category)
	}
	return c.answerForReview(ctx, proc, data, false, agent.RespondedByPockode, review)
}

func (c *Client) answerForReview(ctx context.Context, proc *process.Process, data agent.PermissionRequestData, allow bool, by agent.PermissionResponder, review agent.PermissionReview) error {
	sessionID := proc.SessionID()
	// A replaced or closed process is not the one its session runs now. Its
	// own turn copy stops changing once it is closed, so it cannot be trusted
	// to say the request is over.
	if c.pm.GetProcess(sessionID) != proc {
		return process.ErrRequestNotPending
	}
	// Answering counts as activity, as in liveProcess.
	c.pm.Touch(sessionID)

	choice := agent.PermissionAllow
	var err error
	if allow {
		err = proc.SendPermissionResponse(data, choice)
	} else {
		choice = agent.PermissionDeny
		err = proc.DenyPermissionWithMessage(data, review.DenialMessage())
	}
	if err != nil {
		return err
	}

	record := agent.ObserveAt(agent.PermissionResponseEvent{
		RequestID: data.RequestID,
		Choice:    choice.Name(),
		By:        by,
		Review:    &review,
	}, time.Now()).ToRecord()
	// As for a person's answer: a failed write is reported, and the answer
	// stands.
	_, _ = c.stream.Append(ctx, sessionID, record)
	return nil
}

// RecordWarning writes a warning Pockode raises about a session — not one its
// agent sent — into the session's history and shows it to every subscriber,
// for what went wrong outside the agent's own stream that the person reading
// the session has to know.
func (c *Client) RecordWarning(ctx context.Context, sessionID string, warning agent.WarningEvent) error {
	if _, err := c.stream.Append(ctx, sessionID, warning.ToRecord()); err != nil {
		return fmt.Errorf("record warning: %w", err)
	}
	return nil
}

// Interrupt stops the turn a session is running. A session with no process has
// nothing to stop, which counts as success — starting one would spawn the CLI the
// user just asked to stop.
func (c *Client) Interrupt(_ context.Context, sessionID string) error {
	proc, err := c.liveProcess(sessionID)
	if errors.Is(err, ErrSessionNotRunning) {
		return nil
	}
	if err != nil {
		return err
	}
	return proc.SendInterrupt()
}

// Fork creates a new session carrying the source session's conversation up to the
// moment before the history record named by anchor happened, then asks the agent
// to carry its own context across. An empty title copies the source's.
//
// The anchor is the message the user picked, and what "before it happened" means
// depends on who said it. An agent message: the agent had finished saying it, so
// the fork keeps it. A message the user sent: they had not said it yet, so the
// fork stops one record short and the new session never shows it. Which of the
// two applies is decided here and nowhere else — a client sends the seq of the
// message it was pointed at, not arithmetic on it.
//
// The anchor is a sequence number the server itself handed out, with the history
// or with a live event — never an index the client counted, which would drift
// (see session.HistorySeq).
//
// The cut is not snapped to a turn boundary: cutting in the middle of a turn is
// allowed, and keeps that turn only up to the cut, which is what the source
// really did contain up to that point. No ending of the agent's is invented to
// tidy it up — a transcript claiming a turn finished where it was cut would be
// a lie, and the next agent reads that transcript too. What is appended is
// Pockode's own process_ended, the record of a turn whose process stopped
// carrying it: true of the fork, where no process is, and what keeps its
// history agreeing with its idle turn state.
//
// The source may be mid-turn. Forking neither waits for it nor disturbs it.
//
// A session whose agent answers agent.ForkUnsupported cannot be forked at all
// (ErrForkUnsupported); see agent.ForkSupport for why that is a refusal rather
// than a fork with a warning on it.
func (c *Client) Fork(ctx context.Context, sourceID string, anchor session.HistorySeq, title string) (session.SessionMeta, error) {
	source, found, err := c.store.Get(sourceID)
	if err != nil {
		return session.SessionMeta{}, fmt.Errorf("get session: %w", err)
	}
	if !found {
		return session.SessionMeta{}, ErrSessionNotFound
	}

	// Asked before anything is created, so a refusal leaves nothing behind. The
	// question is about the agent, not about this session or this anchor: an agent
	// that cannot reopen a conversation cannot be forked from anywhere in one.
	support, err := c.pm.ForkSupport(source.AgentType)
	if err != nil {
		return session.SessionMeta{}, fmt.Errorf("resolve agent: %w", err)
	}
	if !support.CanFork() {
		return session.SessionMeta{}, fmt.Errorf("%w: %s cannot reopen a conversation at an earlier message",
			ErrForkUnsupported, source.AgentType.DisplayName())
	}

	records, err := c.store.GetHistory(ctx, sourceID)
	if err != nil {
		return session.SessionMeta{}, fmt.Errorf("read history: %w", err)
	}
	keepThrough, found := session.FindHistorySeq(records, anchor)
	if !found {
		return session.SessionMeta{}, fmt.Errorf("%w: seq %d names no record of the session",
			ErrForkAnchorOutOfRange, int(anchor))
	}

	if isUserMessageRecord(records[keepThrough]) {
		// They had not sent it yet at the moment this fork returns to. That the
		// agent's own context stopped one message short of it anyway — the CLI
		// never streams back the prompts Pockode sends it, so there is no uuid to
		// resume at — is why the rule costs nothing to honour, not why it exists.
		keepThrough--
	}
	if keepThrough < 0 {
		return session.SessionMeta{}, fmt.Errorf("%w: seq %d is the session's first record",
			ErrForkAnchorNoHistory, int(anchor))
	}

	history := agent.TruncateHistory(records, keepThrough)
	// The fork's state at the cut is the fold of the copy alone — not the
	// source's projection, which has gone on past it.
	atCut := projection.Fold(history, source.AgentType).State()

	newID := uuid.Must(uuid.NewV7()).String()
	meta, err := c.store.CreateFork(ctx, newID, session.ForkSpec{
		Source: source,
		Title:  title,
		// The copied history already holds the agent's output, so the fork is a
		// session that has run — which is what Activated guards: switching its
		// agent type would throw that context away.
		Activated: agent.HistoryActivatesSession(history),
		// Read out of the copied records, not off the source's live list: what
		// the fork inherits is what was unanswered *at the cut*, and the source
		// may have answered three of them since.
		Unanswered: atCut.Unanswered(),
		// Only the pages the cut keeps a record of: one drawn past it is not
		// in the fork's transcript (htmlpage.Clone says why its number is
		// still not reused).
		PagesThrough: htmlpage.HighestInRecords(history),
	})
	if err != nil {
		return session.SessionMeta{}, fmt.Errorf("create forked session: %w", err)
	}

	// The session exists from here on, so every later failure has a half-made fork
	// to clean up: an empty session wearing the source's title is worse than none.
	fail := func(err error) (session.SessionMeta, error) {
		if delErr := c.store.Delete(ctx, newID); delErr != nil {
			slog.Error("failed to remove a fork that could not be completed",
				"sessionId", newID, "error", delErr)
		}
		return session.SessionMeta{}, err
	}

	if err := c.store.WriteHistory(ctx, newID, history); err != nil {
		return fail(fmt.Errorf("copy history: %w", err))
	}

	// A cut inside a turn leaves that turn open in the copy, and the fork's
	// own turn state idle (session.ForkSpec): no process of the fork's is
	// carrying it. The history says so the way it says it of any turn whose
	// process stopped carrying it — process_ended, in no turn — so the two
	// agree, and every reader of the copy sees the turn end where it was cut,
	// aborted rather than finished.
	if atCut.OpenTurn() != "" {
		if _, err := c.stream.AppendTo(ctx, newID, agent.ProcessEndedRecord{}, session.NoTurn); err != nil {
			return fail(fmt.Errorf("record that the fork carries no turn: %w", err))
		}
	}

	// Nothing about the source's present state goes with this, not even whether a
	// turn is in flight. The fork point lives in the copied history and nowhere
	// else: history is append-only, so the prefix above is already final, and
	// whatever the source adds — during this call or long after it — falls past
	// the anchor by construction (see agent.ForkOptions).
	carried, err := c.pm.ForkAgentSession(ctx, source.AgentType, agent.ForkOptions{
		SourceSessionID: sourceID,
		SessionID:       newID,
		History:         history,
	})
	if err != nil {
		return fail(fmt.Errorf("fork agent session: %w", err))
	}
	if !carried {
		// Last in the forked session's history, so it sits directly above the input
		// bar the user is about to type into. Without it they talk to an agent that
		// remembers none of the transcript they are looking at, and nothing anywhere
		// says so. The UI shows the same fact before the fork is confirmed; keep the
		// two wordings the same one.
		warning := agent.WarningEvent{
			Message: fmt.Sprintf("%s will not remember this conversation. The new session keeps the transcript, but the agent starts fresh — the earlier conversation could not be reopened. Tell it what you need in your first message.",
				source.AgentType.DisplayName()),
			Code: "fork_agent_context_unavailable",
		}
		// Failing the fork rather than logging it: the warning is the only way
		// the user learns the agent remembers nothing, and the new session has
		// no subscriber yet to be told that it could not be written.
		if _, err := c.stream.Append(ctx, newID, warning.ToRecord()); err != nil {
			return fail(fmt.Errorf("record that the fork has no agent context: %w", err))
		}
	}

	slog.Info("session forked",
		"sourceSessionId", sourceID, "sessionId", newID,
		"anchorSeq", int(anchor), "records", len(history),
		"agentContextCarried", carried)
	return meta, nil
}

// liveProcess returns the session's running process. Unlike getOrCreateProcess it
// never starts one, for requests that are only meaningful to a process already
// there.
func (c *Client) liveProcess(sessionID string) (*process.Process, error) {
	_, found, err := c.store.Get(sessionID)
	if err != nil {
		return nil, fmt.Errorf("get session: %w", err)
	}
	if !found {
		return nil, ErrSessionNotFound
	}

	proc := c.pm.GetProcess(sessionID)
	if proc == nil {
		return nil, ErrSessionNotRunning
	}
	// Answering counts as activity, the same way GetOrCreateProcess treats a
	// message, so the reaper does not collect a session the user is using.
	c.pm.Touch(sessionID)
	return proc, nil
}

// getOrCreateProcess handles session validation and process creation.
//
// Activation is not decided here: a session counts as started once the agent
// produces output, which the process manager sees and records. Marking it here
// would claim a session had started whenever the CLI merely spawned, and a first
// turn that failed outright would then be resumed — and locked to its agent
// type — as if it had run.
func (c *Client) getOrCreateProcess(ctx context.Context, sessionID string) (*process.Process, error) {
	meta, found, err := c.store.Get(sessionID)
	if err != nil {
		return nil, fmt.Errorf("get session: %w", err)
	}
	if !found {
		return nil, ErrSessionNotFound
	}

	proc, _, err := c.pm.GetOrCreateProcess(ctx, meta)
	if err != nil {
		return nil, err
	}

	return proc, nil
}

// isUserMessageRecord reports whether a history record is a message that came
// into the session from outside it, as opposed to one Pockode wrote itself.
//
// EventTypeMessage carries both — a typed prompt, another agent's answer to a
// posted question, a work kickoff or step advance — and only Origin tells them
// apart. An agent's answer counts here with the typed ones, and that is the
// point of the test being on `system` rather than on "the user": a fork cuts
// around what entered the conversation, whoever supplied it, and an answer is
// as much a thing the session was told as a sentence somebody typed. Today's
// clients offer no fork action on Pockode's own annotations, but the rule about
// where a fork cuts is this function's to state, not something to infer from
// what a client happens to send.
//
// A record that does not parse is not a user message: TruncateHistory keeps
// such records as they are, and silently shortening the fork over a parse
// failure would be the larger harm.
func isUserMessageRecord(raw json.RawMessage) bool {
	rec, err := agent.DecodeRecord(raw)
	if err != nil {
		return false
	}
	message, ok := rec.(agent.MessageRecord)
	return ok && message.Origin != agent.MessageOriginSystem
}
