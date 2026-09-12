package chat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"

	"github.com/google/uuid"
	"github.com/pockode/server/agent"
	"github.com/pockode/server/process"
	"github.com/pockode/server/session"
)

var ErrSessionNotFound = errors.New("session not found")

// ErrSessionNotRunning is returned when a request only makes sense to a live
// agent process and the session has none.
//
// Answers belong to the process that asked the question, so a prompt whose
// process is gone — reaped after an idle timeout, or replayed from history after
// a server restart — cannot be answered at all. Starting a process to receive the
// answer sends it nowhere and leaves that process marked running with nothing to
// run, which is worse than saying so.
var ErrSessionNotRunning = errors.New("session is no longer running, send a message to continue")

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

// MessageBroadcastFunc broadcasts a user message to all session subscribers,
// optionally excluding one notifier. seq is where the message landed in the
// session's history, so subscribers can name that record later, or
// session.NoHistorySeq when it was not recorded and there is nothing to name.
// The exclude parameter is typed as any to avoid importing the watch package;
// the wiring code casts it.
type MessageBroadcastFunc func(sessionID string, event agent.MessageEvent, seq session.HistorySeq, exclude any)

// Client coordinates chat operations across session and process management.
// It is the single entry point for programmatic chat interactions.
type Client struct {
	store     session.Store
	pm        *process.Manager
	broadcast MessageBroadcastFunc
}

func NewClient(store session.Store, pm *process.Manager) *Client {
	return &Client{store: store, pm: pm}
}

// SetBroadcaster sets the function used to broadcast user messages to subscribers.
func (c *Client) SetBroadcaster(fn MessageBroadcastFunc) {
	c.broadcast = fn
}

// SendMessageExcluding sends a user message to the agent process, persists it to
// history, and broadcasts it to every session subscriber except the given
// notifier — the caller that has already shown the message to itself (the
// WebSocket client that sent it).
//
// It returns where the message landed in the session's history so the caller can
// hand that address back to the sender. This is the only way the sender can
// learn it: the broadcast that tells every other subscriber a record's seq is
// the very thing being excluded here, so without this the one message a client
// can never name is its own (see session.HistorySeq).
//
// session.NoHistorySeq when the record was not persisted — see sendEvent.
func (c *Client) SendMessageExcluding(ctx context.Context, sessionID, content string, exclude any) (session.HistorySeq, error) {
	return c.sendEvent(ctx, sessionID, agent.MessageEvent{Content: content}, exclude)
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
	_, err := c.sendEvent(ctx, sessionID, event, nil)
	return err
}

// sendEvent delivers one message to the agent, records it, and tells subscribers.
// It returns the record's address in history, or session.NoHistorySeq if there
// is none.
func (c *Client) sendEvent(ctx context.Context, sessionID string, event agent.MessageEvent, exclude any) (session.HistorySeq, error) {
	proc, err := c.getOrCreateProcess(ctx, sessionID)
	if err != nil {
		return session.NoHistorySeq, err
	}

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
	}

	if err := proc.SendMessage(event.Content); err != nil {
		return session.NoHistorySeq, err
	}

	if c.broadcast != nil {
		c.broadcast(sessionID, event, seq, exclude)
	}

	return seq, nil
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

func (c *Client) SendQuestionResponse(ctx context.Context, sessionID string, data agent.QuestionRequestData, answers map[string]string) error {
	proc, err := c.liveProcess(sessionID)
	if err != nil {
		return err
	}

	if err := proc.SendQuestionResponse(data, answers); err != nil {
		return err
	}

	// Persist response to history
	event := agent.QuestionResponseEvent{
		RequestID: data.RequestID,
		Answers:   answers,
	}
	if _, err := c.store.AppendToHistory(ctx, sessionID, agent.NewEventRecord(event)); err != nil {
		slog.Error("failed to persist question response", "sessionId", sessionID, "error", err)
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

	history := agent.TruncateHistory(records, keepThrough)

	newID := uuid.Must(uuid.NewV7()).String()
	meta, err := c.store.CreateFork(ctx, newID, session.ForkSpec{
		Source: source,
		Title:  title,
		// The copied history already holds the agent's output, so the fork is a
		// session that has run — which is what Activated guards: switching its
		// agent type would throw that context away.
		Activated: agent.HistoryActivatesSession(history),
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

// isUserMessageRecord reports whether a history record is a message the user
// sent, as opposed to one Pockode wrote itself.
//
// EventTypeMessage carries both — a typed prompt and a work card or step
// advance — and only Origin tells them apart. Today's clients offer no fork
// action on Pockode's own annotations, but the rule about where a fork cuts is
// this function's to state, not something to infer from what a client happens
// to send.
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
