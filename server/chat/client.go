package chat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync"

	"github.com/google/uuid"
	"github.com/pockode/server/agent"
	"github.com/pockode/server/canvas"
	"github.com/pockode/server/process"
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

// ErrNotCanvasSession is returned for a canvas request about any other session.
var ErrNotCanvasSession = errors.New("this session is not a canvas session")

// EventBroadcastFunc broadcasts a record Pockode wrote itself to all session
// subscribers, optionally excluding one notifier. seq is where the record landed
// in the session's history, so subscribers can name it later, or
// session.NoHistorySeq when it was not recorded and there is nothing to name.
// The exclude parameter is typed as any to avoid importing the watch package;
// the wiring code casts it.
//
// It takes a record rather than one event type because the records that need it
// are no longer only messages: a question Pockode posts on an agent's behalf,
// and its withdrawal, are written here too and never pass through the process's
// event stream, so this is the only way they reach an open chat before the next
// reload.
type EventBroadcastFunc func(sessionID string, record agent.EventRecord, seq session.HistorySeq, exclude any)

// Client coordinates chat operations across session and process management.
// It is the single entry point for programmatic chat interactions.
type Client struct {
	store     session.Store
	pm        *process.Manager
	broadcast EventBroadcastFunc
	settled   QuestionsSettledFunc
	canvas    *canvas.Store
	// postMu keeps each PostQuestions call's questions contiguous; see there.
	postMu sync.Mutex
}

func NewClient(store session.Store, pm *process.Manager) *Client {
	return &Client{store: store, pm: pm}
}

// SetCanvasStore installs the store a canvas session's fork copies its canvas
// through, and the reported size of a message from a canvas session is
// recorded in. Required before a canvas session is forked or sent a size.
func (c *Client) SetCanvasStore(store *canvas.Store) {
	c.canvas = store
}

// SetBroadcaster sets the function used to broadcast server-written records to
// subscribers.
func (c *Client) SetBroadcaster(fn EventBroadcastFunc) {
	c.broadcast = fn
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

// Sender is what a message's sender adds to the sending of it, beyond the
// message itself.
type Sender struct {
	// Exclude is the notifier left out of the broadcast — the WebSocket client
	// that sent the message and has already shown it to itself. Typed as any
	// for the reason EventBroadcastFunc's exclude is.
	Exclude any
	// CanvasSize is the sending device's canvas size, when it reported one
	// (docs/canvas-ui.md §5). Dropped for a session that is not a canvas
	// session once the message starts it: there is no canvas to measure.
	CanvasSize *canvas.Size
}

// SendMessageExcluding sends a user message to the agent process, persists it to
// history, and broadcasts it to every session subscriber except from.Exclude —
// the caller that has already shown the message to itself (the WebSocket
// client that sent it).
//
// It returns where the message landed in the session's history, and the id
// minted for it, so the caller can hand both back to the sender. This is the
// only way the sender can learn them: the broadcast that tells every other
// subscriber a record's seq and id is the very thing being excluded here, so
// without this the one message a client can never name is its own (see
// session.HistorySeq). The id is what a later record about the message names it
// by — the read point, or the record of a Stop discarding it.
//
// The zero Sent when the record was not persisted — see sendEvent.
//
// attachments are files already in the session's attachment store; the message
// is refused whole with ErrAttachmentsUnsupported when the agent cannot take
// them.
func (c *Client) SendMessageExcluding(ctx context.Context, sessionID, content string, attachments []agent.Attachment, from Sender) (Sent, error) {
	return c.sendEvent(ctx, sessionID, agent.MessageEvent{Content: content}, attachments, from)
}

// SendCommandExcluding is SendMessageExcluding for a Pockode command: content is
// the prompt the command expanded to, which is what the agent reads and what the
// record holds, and cmd is what the user typed. It is still the user's message —
// the origin is theirs, so it forks and drives a work like any other.
func (c *Client) SendCommandExcluding(ctx context.Context, sessionID, content string, cmd agent.CommandInvocation, attachments []agent.Attachment, from Sender) (Sent, error) {
	return c.sendEvent(ctx, sessionID, agent.MessageEvent{Content: content, Command: &cmd}, attachments, from)
}

// SendCanvasAction is SendMessageExcluding for something the user did on a
// canvas page, and returns the content the agent was sent
// (canvas.ActionText). It is the user's message like any other — refused
// while a permission request is open, folded into a running turn — but its
// content is machine text, which is what the record's canvas_action says.
//
// The caller has checked the action against the session (docs/canvas-ui.md
// §6.4): that it is a canvas session, and that the revision exists.
func (c *Client) SendCanvasAction(ctx context.Context, sessionID string, action canvas.Action, from Sender) (Sent, string, error) {
	content := canvas.ActionText(action)
	sent, err := c.sendEvent(ctx, sessionID, agent.MessageEvent{Content: content, CanvasAction: &action}, nil, from)
	return sent, content, err
}

// SendSystemMessage sends a system-driven automatic message (kickoff, restart,
// auto-continue, etc.). It is tagged with origin "system" plus a subtype and
// optional meta so the frontend can fold it into the receiving work's progress
// card rather than render it as a user bubble.
func (c *Client) SendSystemMessage(ctx context.Context, sessionID, content, subtype string, meta *agent.MessageMeta) error {
	event := agent.MessageEvent{
		Content: content,
		Origin:  agent.MessageOriginSystem,
		Subtype: subtype,
		Meta:    meta,
	}
	_, err := c.sendEvent(ctx, sessionID, event, nil, Sender{})
	return err
}

// SetCanvas changes an unstarted session's kind, refused with
// session.ErrSessionStarted once its first message has been delivered.
//
// The write comes first and the process is closed after it, only if it was
// spawned for the other kind. In that order a switch that loses to a send's
// MarkStarted is refused and closes nothing — the process just told the old
// kind is the session's for good — and one that wins leaves the send, which
// sees the new kind at its mark, to replace the process itself. A process
// already spawned from the new value is never touched by either.
func (c *Client) SetCanvas(ctx context.Context, sessionID string, canvas bool) error {
	if err := c.store.SetCanvas(ctx, sessionID, canvas); err != nil {
		return err
	}
	c.pm.CloseIfCanvasDiffers(sessionID, canvas)
	return nil
}

// Sent names the record a message was written to: its address in history and
// the id minted for it. Both are zero when the record could not be written —
// there is then nothing to name.
type Sent struct {
	Seq       session.HistorySeq
	MessageID string
}

// sendEvent delivers one message to the agent, records it, and tells subscribers.
// It returns what names the record, or the zero Sent if there is none.
func (c *Client) sendEvent(ctx context.Context, sessionID string, event agent.MessageEvent, attachments []agent.Attachment, from Sender) (Sent, error) {
	proc, _, err := c.getOrCreateProcess(ctx, sessionID)
	if err != nil {
		return Sent{}, err
	}

	// Before the append, not after: a refused message must leave no trace. A
	// record written here would be in the transcript on the next reload of a
	// conversation the agent never heard it in, which is a worse answer than the
	// error — the send failed, and only the client that tried knows that.
	//
	// Asked of the process rather than of the agent, and asked for every sender:
	// a kickoff or an auto-continuation lands in the same silence a typed message
	// does, and a work nudged into a session that is holding a request open is
	// nudged into nothing.
	if proc.TurnState().AwaitingUserAnswer() {
		return Sent{}, ErrTurnAwaitingAnswer
	}
	if len(attachments) > 0 && !proc.ReceivesAttachments() {
		return Sent{}, ErrAttachmentsUnsupported
	}
	for _, a := range attachments {
		event.Attachments = append(event.Attachments, a.File)
	}

	// Past every check, so a refused message leaves the session unstarted and
	// its kind still the user's to change; before the record and the delivery,
	// so from here the kind is fixed and the meta below is what the agent is
	// told (docs/new-session-ui.md §4.2).
	meta, err := c.store.MarkStarted(ctx, sessionID)
	if err != nil {
		return Sent{}, err
	}
	// A kind switch that landed between taking the process and the mark leaves
	// a process told the other kind. Replaced, never sent to; looped because a
	// concurrent send may have spawned another from the meta it read before the
	// switch.
	for proc.Canvas() != meta.Canvas {
		c.pm.CloseIfCanvasDiffers(sessionID, meta.Canvas)
		if proc, _, err = c.pm.GetOrCreateProcess(ctx, meta); err != nil {
			return Sent{}, err
		}
	}

	// Past every check, so a refused message reports nothing
	// (docs/canvas-ui.md §6.4); before the record and the delivery, so the
	// store agrees with the record that says so, and a canvas call the agent
	// makes in answer is drawn for this size, not the one before. A size that
	// could not be stored is not worth refusing the message over: the agent
	// still reads it in this message, and only the next revision's drawn_for
	// falls behind.
	// Judged against the marked kind rather than by the caller: the kind is
	// only fixed from the mark, and a message to a chat session has no canvas
	// to report (docs/canvas-ui.md §6.4).
	if from.CanvasSize != nil && meta.Canvas {
		event.CanvasSize = from.CanvasSize
		if err := c.canvas.ReportSize(sessionID, *from.CanvasSize); err != nil {
			slog.Error("failed to record the canvas size a message reported", "sessionId", sessionID, "error", err)
		}
	}

	// Minted here, once, for every sender: it goes into the record, to the agent
	// that can carry it, and into the read point that names this message later.
	event.MessageID = uuid.NewString()

	// Persist message to history
	seq, err := c.store.AppendToHistory(ctx, sessionID, agent.NewEventRecord(event))
	if err != nil {
		slog.Error("failed to persist message", "sessionId", sessionID, "error", err)
		// The prompt still goes to the agent — it is worth answering whether or not
		// the transcript kept it, and refusing it here would turn a disk hiccup into
		// a session that cannot be talked to. But the failed append handed back no
		// address, so nothing below may pass one on: a seq nobody can resolve would
		// send a later fork to whatever record eventually takes that number.
		seq = session.NoHistorySeq
		// The id goes with it. There is no record carrying this id, so a read
		// point naming it would name nothing.
		event.MessageID = ""
	}

	// Read and cleared around the delivery rather than taken before it, so a
	// delivery that fails leaves it for the next. Two inputs delivered at once
	// may then both carry it: the same true line twice, which misleads nobody.
	forkNote := c.forkNote(meta)
	openedTurn, err := proc.SendMessage(agent.Prompt{Text: deliveredText(event, forkNote), ID: event.MessageID, Attachments: attachments})
	if err != nil {
		return Sent{}, err
	}
	if forkNote != "" {
		if err := c.canvas.ForkNoteDelivered(sessionID, forkNote); err != nil {
			slog.Error("failed to clear a fork's canvas note; the next message carries it again", "sessionId", sessionID, "error", err)
		}
	}

	if c.broadcast != nil {
		c.broadcast(sessionID, event.ToRecord(), seq, from.Exclude)
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

// deliveredText is what the agent reads for a message: its content, the
// sender's canvas size on a line of its own when it reported one, and a fork's
// note on where its canvas is when one is still to be delivered. Both are
// added here and never stored in the content, so the content stays what the
// user typed — a prompt a fork drops comes back as a draft without them — and
// whoever needs the size reads it from canvas_size (docs/canvas-ui.md §6.3,
// §13.6).
func deliveredText(event agent.MessageEvent, forkNote string) string {
	text := event.Content
	if event.CanvasSize != nil {
		text += fmt.Sprintf("\n[Canvas size: %d×%d]", event.CanvasSize.Width, event.CanvasSize.Height)
	}
	if forkNote != "" {
		text += "\n" + forkNote
	}
	return text
}

// forkNote is the line a forked canvas session's next delivery carries, empty
// for any other session. One that cannot be read is not worth refusing the
// message over: the agent only misses where its canvas is.
func (c *Client) forkNote(meta session.SessionMeta) string {
	if !meta.Canvas {
		return ""
	}
	note, err := c.canvas.ForkNote(meta.ID)
	if err != nil {
		slog.Error("failed to read a fork's canvas note", "sessionId", meta.ID, "error", err)
	}
	return note
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
// A failed append is logged and nothing more. The message was delivered and the
// turn is under way; losing the boundary costs the reader a bubble break on the
// next reload, which is not worth failing a send that succeeded.
func (c *Client) noteIngested(ctx context.Context, sessionID, messageID string) {
	record := agent.NewEventRecord(agent.MessageIngestedEvent{MessageID: messageID})
	seq, err := c.store.AppendToHistory(ctx, sessionID, record)
	if err != nil {
		slog.Error("failed to persist the message read point", "sessionId", sessionID, "error", err)
		return
	}
	c.broadcastRecord(sessionID, record, seq)
}

func (c *Client) SendPermissionResponse(ctx context.Context, sessionID string, data agent.PermissionRequestData, choice agent.PermissionChoice) error {
	proc, err := c.liveProcess(sessionID)
	if err != nil {
		return err
	}

	if err := proc.SendPermissionResponse(data, choice); err != nil {
		return err
	}

	// Persist response to history
	event := agent.PermissionResponseEvent{
		RequestID: data.RequestID,
		Choice:    choiceToString(choice),
	}
	if _, err := c.store.AppendToHistory(ctx, sessionID, agent.NewEventRecord(event)); err != nil {
		slog.Error("failed to persist permission response", "sessionId", sessionID, "error", err)
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
// allowed, and leaves a last turn with no ending event, which is what the source
// really did contain up to that point. No terminal event is invented to tidy it
// up — a transcript claiming a turn finished where it was cut would be a lie,
// and the next agent reads that transcript too.
//
// The source may be mid-turn. Forking neither waits for it nor disturbs it.
//
// A session whose agent answers agent.ForkUnsupported cannot be forked at all
// (ErrForkUnsupported); see agent.ForkSupport for why that is a refusal rather
// than a fork with a warning on it.
func (c *Client) Fork(ctx context.Context, sourceID string, anchor session.HistorySeq, title string) (session.SessionMeta, error) {
	source, err := c.forkSource(sourceID)
	if err != nil {
		return session.SessionMeta{}, err
	}

	records, err := c.store.GetHistory(ctx, sourceID)
	if err != nil {
		return session.SessionMeta{}, fmt.Errorf("read history: %w", err)
	}
	if !anchor.Valid() || anchor.Index() >= len(records) {
		return session.SessionMeta{}, fmt.Errorf("%w: seq %d, the session has %d records",
			ErrForkAnchorOutOfRange, int(anchor), len(records))
	}

	keepThrough := anchor.Index()
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

	return c.fork(ctx, source, records, keepThrough, title, "anchorSeq", int(anchor))
}

// ForkAtCanvasRevision is Fork from a page rather than a message
// (docs/canvas-ui.md §13.6, From a revision): the cut is the tool_result record
// carrying canvas_revision, kept, which only the server can find — it may be
// in a page of history the client never loaded.
//
// Refused, before anything is created, for a session that is not a canvas
// session (ErrNotCanvasSession), a revision the canvas does not have
// (canvas.ErrNoRevision), and one whose record cannot be cut at
// (*canvas.ForkBlockedError, the same check chat.canvas_history lists).
func (c *Client) ForkAtCanvasRevision(ctx context.Context, sourceID string, revision int, title string) (session.SessionMeta, error) {
	source, err := c.forkSource(sourceID)
	if err != nil {
		return session.SessionMeta{}, err
	}
	if !source.Canvas {
		return session.SessionMeta{}, ErrNotCanvasSession
	}
	// A fork from a page that is not there would open on another one.
	snap, err := c.canvas.Snapshot(sourceID, revision)
	if err != nil {
		return session.SessionMeta{}, err
	}

	records, cuts, err := c.canvasForkCuts(ctx, sourceID)
	if err != nil {
		return session.SessionMeta{}, err
	}
	keepThrough, blocked := cuts.Cut(revision, snap.DrawnAt)
	if blocked != nil {
		return session.SessionMeta{}, blocked
	}
	return c.fork(ctx, source, records, keepThrough, title, "canvasRevision", revision)
}

// CanvasHistory lists a canvas session's revisions, newest first, each with
// whether a fork from it would be refused (docs/canvas-ui.md §13.5).
func (c *Client) CanvasHistory(ctx context.Context, sessionID string) ([]canvas.ListedRevision, error) {
	// The list first: a revision in it was drawn before its call's result was
	// recorded, so the cuts read after it see that result or the call in flight.
	entries, err := c.canvas.History(sessionID)
	if err != nil {
		return nil, err
	}
	_, cuts, err := c.canvasForkCuts(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	listed := make([]canvas.ListedRevision, len(entries))
	for i, e := range entries {
		listed[i] = canvas.ListedRevision{HistoryEntry: e, ForkBlocked: cuts.Blocked(e.Revision, e.DrawnAt)}
	}
	return listed, nil
}

// canvasForkCuts reads the session's history and where a fork from each of its
// revisions would cut. What the process is doing is asked before the records
// are read (see canvas.LiveCalls).
func (c *Client) canvasForkCuts(ctx context.Context, sessionID string) ([]json.RawMessage, canvas.ForkCuts, error) {
	live := c.pm.CanvasLive(sessionID)
	records, err := c.store.GetHistory(ctx, sessionID)
	if err != nil {
		return nil, canvas.ForkCuts{}, fmt.Errorf("read history: %w", err)
	}
	return records, canvas.ReadForkCuts(records, live), nil
}

// forkSource is the session a fork is asked of, if it can be forked at all.
func (c *Client) forkSource(sourceID string) (session.SessionMeta, error) {
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
	return source, nil
}

// fork makes the new session from source's records 0…keepThrough. at names
// the cut for the log.
func (c *Client) fork(ctx context.Context, source session.SessionMeta, records []json.RawMessage, keepThrough int, title, atKey string, at int) (session.SessionMeta, error) {
	sourceID := source.ID
	history := agent.TruncateHistory(records, keepThrough)

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
		// may have answered three of them since. See agent.UnansweredQuestions.
		Unanswered: agent.UnansweredQuestions(history),
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

	if source.Canvas {
		c.forkCanvas(ctx, sourceID, newID, history)
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
		if _, err := c.store.AppendToHistory(ctx, newID, agent.NewEventRecord(warning)); err != nil {
			slog.Error("failed to record that the fork has no agent context",
				"sessionId", newID, "error", err)
		}
	}

	slog.Info("session forked",
		"sourceSessionId", sourceID, "sessionId", newID,
		atKey, at, "records", len(history),
		"agentContextCarried", carried)
	return meta, nil
}

// forkCanvas gives the fork the canvas as it was at the cut, read from the
// history it was just given (docs/canvas-ui.md §13.6). After WriteHistory
// because that replaces the fork's whole history, so the warning appended here
// on failure would otherwise be lost.
//
// Not fatal, as for attachments: a fork without its canvas is still the
// conversation the user asked for, and the warning tells them to have it drawn
// again.
func (c *Client) forkCanvas(ctx context.Context, sourceID, forkID string, history []json.RawMessage) {
	revision, reported := canvas.ForkPoint(history)
	err := c.canvas.Fork(sourceID, forkID, revision, reported)
	if err == nil {
		return
	}
	slog.Error("failed to copy the canvas into a forked session",
		"sessionId", forkID, "sourceSessionId", sourceID, "revision", revision, "error", err)
	warning := agent.WarningEvent{
		Message: "The canvas could not be copied into this session. Ask the agent to draw it again.",
		Code:    "fork_canvas_unavailable",
	}
	if _, err := c.store.AppendToHistory(ctx, forkID, agent.NewEventRecord(warning)); err != nil {
		slog.Error("failed to record that the fork has no canvas",
			"sessionId", forkID, "error", err)
	}
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
func (c *Client) getOrCreateProcess(ctx context.Context, sessionID string) (*process.Process, session.SessionMeta, error) {
	meta, found, err := c.store.Get(sessionID)
	if err != nil {
		return nil, session.SessionMeta{}, fmt.Errorf("get session: %w", err)
	}
	if !found {
		return nil, session.SessionMeta{}, ErrSessionNotFound
	}

	proc, _, err := c.pm.GetOrCreateProcess(ctx, meta)
	if err != nil {
		return nil, session.SessionMeta{}, err
	}

	return proc, meta, nil
}

func choiceToString(choice agent.PermissionChoice) string {
	switch choice {
	case agent.PermissionAllow:
		return "allow"
	case agent.PermissionAlwaysAllow:
		return "always_allow"
	default:
		return "deny"
	}
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
	var rec agent.EventRecord
	if err := json.Unmarshal(raw, &rec); err != nil {
		return false
	}
	return rec.Type == agent.EventTypeMessage && rec.Origin != agent.MessageOriginSystem
}
