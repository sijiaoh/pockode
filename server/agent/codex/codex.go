// Package codex implements Agent interface using Codex CLI's app-server
// JSON-RPC channel over STDIO.
//
// Why app-server and not `codex mcp-server`, which this used to speak: a thread
// created over MCP lives in the memory of the process that created it, so every
// restart of the CLI threw the conversation away. app-server's `thread/resume`
// loads a thread back from its rollout file on disk, which is what lets a
// session survive a restart at all — and it reopens threads the MCP channel
// created too, so sessions recorded before this change are not lost.
//
// The trade is that `codex app-server` is marked [experimental] in `codex
// --help` while `mcp-server` is not. What makes that acceptable is that the CLI
// generates the JSON schema for its own protocol, so the shapes this package
// depends on can be asked about instead of waited for:
// TestIntegration_ProtocolSchemaStillFitsWhatWeSend does the asking, and costs
// no tokens because generation never reaches a model.
package codex

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/attachments"
	"github.com/pockode/server/logger"
	"github.com/pockode/server/session"
)

const Binary = "codex"

// appServerSubcommand is the CLI entry point for the JSON-RPC channel.
const appServerSubcommand = "app-server"

// Startup steps must be bounded: process.Manager calls Agent.Start while holding
// its worktree-wide process lock, so a step that never returns deadlocks every
// session of the worktree. A timeout downgrades that to a recoverable start
// failure.
//
// Neither budget covers model latency: `--help` just lists subcommands, and the
// startup budget covers the `initialize` handshake plus one `thread/start`,
// `thread/resume` or `thread/fork`, none of which sends a prompt anywhere.
//
// That is not the same as covering only local work, and measuring says so. On
// codex-cli 0.153.0, with no prompt in sight, `initialize` took 2.3-4.9s and
// `thread/start` 8.6-14.2s over five cold runs — 11-19s together — and the CLI
// logs its own network timeouts during the handshake ("failed to refresh
// available models"). So the CLI does reach the network here, and the 30s this
// budget started at was a margin of well under 2x on a bad day rather than the
// wide one those figures look like — two integration runs on a contended machine
// exceeded it. Hence 45s: about 3x the worst measured start.
//
// The asymmetry is what picks the number. The budget is only ever spent in full
// when a start is genuinely stuck, and then it decides how long the user waits
// to be told. Set it too low and it kills starts that would have succeeded, and
// the user pays the whole wait again on the retry. Waiting longer to report a
// real failure is the cheaper of the two mistakes.
//
// The client is sized against their sum: web/src/lib/wsStore.ts mirrors it as
// CODEX_START_BUDGET_MS and keeps the timeout of the requests that run Start
// above it, with margin. Raising either budget eats into that margin, and once
// the sum outgrows it the client gives up first: the error naming the stalled
// step then goes into a reply nobody is waiting for. Grow these two and the web
// constant together.
const (
	supportProbeTimeout = 10 * time.Second
	startupTimeout      = 45 * time.Second
)

// threadSource classifies this thread for Codex's own bookkeeping. It lands in
// the rollout's `thread_source`, next to `originator` (which takes clientInfo's
// name, also "pockode").
//
// It does not change the rollout's `source` field: on codex-cli 0.153.0 that one
// is hard-coded per channel and reads "vscode" for everything app-server
// creates, whatever is passed here (measured). Passing it is still the only way
// to say whose thread this is.
const threadSource = "pockode"

// Agent implements agent.Agent using the Codex CLI app-server.
type Agent struct{}

// New creates a new Codex Agent.
func New() *Agent {
	return &Agent{}
}

// Start launches a persistent `codex app-server` process and opens this
// session's thread on it — resuming the recorded one when there is one.
func (a *Agent) Start(ctx context.Context, opts agent.StartOptions) (agent.Session, error) {
	procCtx, cancel := context.WithCancel(ctx)

	if err := checkAppServerSupport(procCtx); err != nil {
		cancel()
		return nil, err
	}

	exe, err := os.Executable()
	if err != nil {
		cancel()
		return nil, fmt.Errorf("resolve executable path: %w", err)
	}

	log := slog.With("sessionId", opts.SessionID, "agent", "codex")

	proc, err := agent.StartProcess(procCtx, log, Binary, []string{appServerSubcommand}, opts.WorkDir)
	if err != nil {
		cancel()
		return nil, fmt.Errorf("failed to start codex: %w", err)
	}

	log.Info("codex process started", "pid", proc.Pid(), "subcommand", appServerSubcommand)

	events := make(chan agent.AgentEvent, 100)

	sess := &appSession{
		log:               log,
		events:            events,
		stdin:             proc.Stdin,
		cancel:            cancel,
		procCtx:           procCtx,
		opts:              opts,
		exe:               exe,
		pendingRPCResults: &sync.Map{},
		pendingApprovals:  &sync.Map{},
		toolInputs:        map[string]json.RawMessage{},
		resume:            newResumeStateStore(opts, log),
		attachments:       attachments.NewStore(opts.DataDir, opts.SessionID),
		// Per-process: Codex's totals count from the start of the app-server
		// process holding the thread, and reset again on every resume. See
		// agent.UsageAccumulator.
		usage: newUsageObserver(log, opts),
	}

	go func() {
		defer func() {
			if r := recover(); r != nil {
				logger.LogPanic(r, "codex process crashed", "sessionId", opts.SessionID)
			}
		}()
		defer sess.closeEvents()

		stderrCh := agent.ReadStderr(proc.Stderr, "codex")
		sess.runReadLoop(proc.Stdout)
		sess.cancelPendingApprovals()
		agent.WaitForProcess(procCtx, log, proc, stderrCh, events)

		agent.EmitProcessEnded(log, events)
	}()

	// Handshake and open the thread before returning. The deadline lives on a
	// child context so it expires with the startup instead of taking procCtx —
	// and the running CLI — down with it.
	startCtx, cancelStart := context.WithTimeout(procCtx, startupTimeout)
	defer cancelStart()

	if err := sess.initialize(startCtx); err != nil {
		sess.Close()
		return nil, startupError(startCtx, "answer the app-server handshake", err)
	}
	if err := sess.openThread(startCtx); err != nil {
		sess.Close()
		return nil, startupError(startCtx, "open a thread", err)
	}

	return sess, nil
}

// startupError names the step that failed, and says so as a timeout when that is
// what happened: "codex did not open a thread within 30s" is actionable where
// "context deadline exceeded" is not.
func startupError(ctx context.Context, step string, err error) error {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return fmt.Errorf("codex did not %s within %s", step, startupTimeout)
	}
	return fmt.Errorf("codex failed to %s: %w", step, err)
}

// appSession implements agent.Session over the Codex app-server protocol.
type appSession struct {
	log     *slog.Logger
	events  chan agent.AgentEvent
	stdin   io.WriteCloser
	stdinMu sync.Mutex
	cancel  func()
	procCtx context.Context
	opts    agent.StartOptions
	exe     string // resolved executable path for the MCP server config

	nextID            atomic.Int64
	pendingRPCResults *sync.Map // id -> chan *rpcResponse
	pendingApprovals  *sync.Map // request id -> chan approvalDecision

	// attachments is where the images this session's tools look at are kept, so
	// the events naming them stay small enough to hold in the history (see
	// package attachments). handleImageViewCompleted is what writes to it. The
	// store is opened here rather than there because opening it is what ties it
	// to this session's data directory, and that is settled here and nowhere
	// else.
	attachments attachments.Store

	stateMu  sync.Mutex // protects threadID, turnID, interruptPending and openerEchoTurnID
	threadID string
	turnID   string // the turn currently running, or empty between turns
	// interruptPending is a stop that arrived before there was a turn to name.
	// See SendInterrupt.
	interruptPending bool
	// openerEchoTurnID is the last turn whose opening message Codex has echoed
	// back. See claimTurnOpener.
	openerEchoTurnID string

	// toolInputs holds the rendered input of items still in flight, keyed by
	// item id. An approval request names only the item it is about, so this is
	// where the description of a file change comes from — it arrives in the
	// item/started that precedes the approval and nowhere else.
	toolInputsMu sync.Mutex
	toolInputs   map[string]json.RawMessage

	usage  *usageObserver
	resume *resumeStateStore

	// eventsMu is held for reading by every sender and for writing by the one
	// close, so that no send can be in flight while the channel is closed. See
	// emitEvent.
	eventsMu     sync.RWMutex
	eventsClosed bool

	closeOnce sync.Once
}

// Events returns the event channel.
func (s *appSession) Events() <-chan agent.AgentEvent {
	return s.events
}

// SendMessage starts a turn on this session's thread.
//
// The reply to `turn/start` only says the turn was accepted; the turn itself
// ends later, with the turn/completed notification that produces this turn's
// done, error or interrupted event.
//
// Sending while a turn is already running steers that turn rather than starting
// a second one: the reply carries the running turn's id, both messages are
// answered inside it, and one turn/completed ends them both (verified on
// codex-cli 0.153.0). That is a change from the MCP channel, which aborted the
// running turn and replaced it — and it is the better of the two, since nothing
// the agent had already done is thrown away. It is also why nothing here counts
// endings per message; see agent.Session.
func (s *appSession) SendMessage(prompt agent.Prompt) error {
	s.log.Debug("sending prompt", "length", len(prompt.Text))

	// A new prompt is the user asking for work, which retires a stop that never
	// found a turn to name — one pressed while the session was idle, or one that
	// lost the race with the turn it meant to stop. Without this, that stop would
	// be carried out on the turn this prompt is about to start.
	s.forgetWaitingStop()

	threadID := s.currentThreadID()
	if threadID == "" {
		// Start opens the thread before returning a session, so reaching here
		// means the process died between then and now.
		return errors.New("codex session has no open thread")
	}

	params := map[string]interface{}{
		"threadId": threadID,
		"input":    []map[string]interface{}{{"type": "text", "text": prompt.Text}},
	}
	if prompt.ID != "" {
		// Codex echoes this back as the `clientId` of the userMessage item it
		// emits when it reads the message, which is what lets that echo name one
		// specific message rather than "whichever was sent last" — the case that
		// needs it is two messages steered into one turn. Verified against
		// codex-cli 0.153.0. See handleUserMessageItem.
		params["clientUserMessageId"] = prompt.ID
	}

	return s.sendRPCAsync("turn/start", params, func(_ json.RawMessage, err error) {
		if err == nil {
			return
		}
		// No turn started, so nothing else will end this one.
		s.emitEvent(agent.ErrorEvent{Error: fmt.Sprintf("codex could not start the turn: %s", err)})
	})
}

// ReportsMessageIngest marks this session as one that says for itself when the
// agent has read a message; see agent.MessageIngestReporter and
// handleUserMessageItem.
func (s *appSession) ReportsMessageIngest() {}

// SendPermissionResponse answers the approval request the user just decided on.
func (s *appSession) SendPermissionResponse(data agent.PermissionRequestData, choice agent.PermissionChoice) error {
	var decision string
	switch choice {
	case agent.PermissionAllow:
		decision = decisionAccept
	case agent.PermissionAlwaysAllow:
		decision = decisionAcceptForSession
	default:
		// decline, not cancel: a refusal tells the model to try something else
		// and the turn carries on, which is what Codex has always done here.
		decision = decisionDecline
	}
	s.answerApproval(data.RequestID, decision)
	return nil
}

// SendInterrupt stops the running turn, or the one about to start.
//
// turn/interrupt has to name a turn, and the id only arrives with turn/started —
// which trails the prompt by however long the CLI takes to get going, measured at
// over two seconds on a loaded machine. A stop pressed inside that window used to
// find no turn and send nothing, silently: the user's stop was dropped and the
// turn they wanted stopped ran to completion. So a stop with no turn to name is
// remembered instead, and handleTurnStarted carries it out on the turn it was
// meant for.
func (s *appSession) SendInterrupt() error {
	// Pending approvals first, so RequestCancelledEvent is enqueued before the
	// InterruptedEvent that turn/completed produces. A turn blocked on an
	// approval is also not looking at its interrupt request, so answering is
	// what actually unblocks it — `cancel` is the decision that refuses and ends
	// the turn in one step.
	s.cancelPendingApprovals()

	threadID, turnID := s.claimTurnToInterrupt()
	if turnID == "" {
		s.log.Info("no codex turn to interrupt yet, stopping the one that starts next")
		return nil
	}
	return s.interruptTurn(threadID, turnID)
}

// claimTurnToInterrupt returns the turn to stop, or records that the next one to
// start is to be stopped as soon as it names itself.
func (s *appSession) claimTurnToInterrupt() (threadID, turnID string) {
	s.stateMu.Lock()
	defer s.stateMu.Unlock()
	if s.turnID == "" {
		s.interruptPending = true
		return "", ""
	}
	return s.threadID, s.turnID
}

func (s *appSession) interruptTurn(threadID, turnID string) error {
	s.log.Info("interrupting codex turn", "turnId", turnID)

	return s.sendRPCAsync("turn/interrupt", map[string]interface{}{
		"threadId": threadID,
		"turnId":   turnID,
	}, func(_ json.RawMessage, err error) {
		if err != nil {
			// Losing the race with a turn that was ending anyway is the ordinary
			// cause ("no active turn to interrupt"), and that turn's own
			// turn/completed is already on its way.
			s.log.Warn("codex refused the interrupt", "error", err, "turnId", turnID)
		}
	})
}

// Close terminates the Codex process.
func (s *appSession) Close() {
	s.closeOnce.Do(func() {
		s.log.Info("terminating codex process")
		s.cancel()
		s.stdinMu.Lock()
		s.stdin.Close()
		s.stdinMu.Unlock()
	})
}

// --- Thread lifecycle ---

// initialize performs the app-server handshake.
func (s *appSession) initialize(ctx context.Context) error {
	params := map[string]interface{}{
		"clientInfo": map[string]interface{}{
			"name":    "pockode",
			"version": "1.0.0",
		},
		"capabilities": map[string]interface{}{
			// A fork anchor can be refused outright without it —
			// `thread/fork.beforeTurnId requires experimentalApi capability`.
			// Only beforeTurnId was seen refused that way; lastTurnId, the one
			// forkThread sends, is in the schema generated without
			// --experimental too, so it may well not need the flag. Declaring it
			// settles that rather than leaving it to be rediscovered, and costs
			// nothing: capabilities are negotiated once, at the handshake, and
			// nothing arrives because of it that the notification dispatch does
			// not already ignore by default.
			"experimentalApi": true,
		},
	}
	result, err := s.sendRPC(ctx, "initialize", params)
	if err != nil {
		return err
	}
	s.log.Info("codex app-server initialized", "result", string(result))

	notification := rpcRequest{JSONRPC: "2.0", Method: "initialized"}
	data, err := json.Marshal(notification)
	if err != nil {
		return err
	}
	return s.writeStdin(data)
}

// openThread gives this session a thread to talk in: the fork it was created as,
// the thread it already has, or a new one.
//
// Reopening that fails does not fail the session. A thread whose rollout is gone
// (deleted, or written by a Codex install that is no longer there) would
// otherwise make the session permanently unusable. It starts a fresh thread
// instead and says so — the user needs to know the agent no longer remembers the
// transcript they are looking at, and Pockode's own history is unaffected.
func (s *appSession) openThread(ctx context.Context) error {
	state, _ := s.resume.load()

	switch {
	case state.ForkAtTurnID != "":
		return s.openRecordedThread(ctx, state, s.forkThread,
			"Codex could not reopen the conversation this session was forked from (%s), so it is starting without it. The transcript above is unaffected.")
	case state.ThreadID != "":
		return s.openRecordedThread(ctx, state, s.resumeThread,
			"Codex could not reopen this session's earlier conversation (%s), so it is starting over without those messages. The transcript above is unaffected.")
	default:
		return s.startThread(ctx)
	}
}

// openRecordedThread reopens the thread the recorded state names, degrading to a
// new one when Codex will not.
//
// The degradation is always to a *new* thread, never to a lesser way of reopening
// the same conversation. A fork whose fork failed must not fall back to resuming
// the thread it was forked from: the two sessions would then write their turns
// into one conversation, which is the one thing forking exists to prevent.
func (s *appSession) openRecordedThread(ctx context.Context, state codexResumeState, open func(context.Context, codexResumeState) error, degraded string) error {
	if err := open(ctx, state); err == nil {
		return nil
	} else if ctx.Err() != nil {
		// Out of budget, or the process is gone: a new thread would not fare
		// better, and starting one would burn the recorded id for nothing.
		return err
	} else {
		s.log.Warn("could not reopen codex thread, starting a new one",
			"threadId", state.ThreadID, "forkAtTurnId", state.ForkAtTurnID, "error", err)
		s.emitEvent(agent.WarningEvent{
			Message: fmt.Sprintf(degraded, err),
			Code:    "session_not_resumable",
		})
	}

	return s.startThread(ctx)
}

func (s *appSession) startThread(ctx context.Context) error {
	params := s.buildThreadParams()
	params["threadSource"] = threadSource

	result, err := s.sendRPC(ctx, "thread/start", params)
	if err != nil {
		return err
	}
	return s.adoptThread(result)
}

func (s *appSession) resumeThread(ctx context.Context, state codexResumeState) error {
	s.log.Info("resuming codex thread", "threadId", state.ThreadID)

	params := s.buildThreadParams()
	params["threadId"] = state.ThreadID
	// Pockode keeps its own transcript and renders from it, so hydrating the
	// thread's turns into the reply would only cost the time to serialise them.
	// The CLI has deprecated full hydration in favour of this flag.
	params["excludeTurns"] = true

	result, err := s.sendRPC(ctx, "thread/resume", params)
	if err != nil {
		return err
	}
	return s.adoptThread(result)
}

// forkThread opens a copy of the source's thread carrying its conversation
// through the turn the fork was taken at, and leaves the source untouched.
//
// `lastTurnId` is inclusive, so the fork keeps the whole turn its anchor sits in
// — including anything the agent went on to do later in that same turn, which
// the forked transcript may stop short of. A turn is as coarse as that gets:
// a message sent while one was already running is steered into it rather than
// starting its own, so a fork taken at such a message carries the answer to it
// as well. The alternative selector, `beforeTurnId`, would cut the turn away
// entirely: the agent would then not remember the very exchange the user forked
// at, prompt included, while the transcript in front of them shows it. Carrying
// a little more than is shown is the smaller of the two mismatches, and it is
// the one Claude's fork makes too (at the finer grain of a message, which is as
// fine as each CLI's own anchors go).
//
// The anchor turn "cannot be in progress", says the protocol schema codex-cli
// 0.153.0 generates — which is what a fork taken from a session mid-turn and
// typed into before that turn ends would name. Whatever Codex answers to that
// lands in openRecordedThread's degradation: a new thread, and the user is told.
func (s *appSession) forkThread(ctx context.Context, state codexResumeState) error {
	s.log.Info("forking codex thread", "sourceThreadId", state.ThreadID, "lastTurnId", state.ForkAtTurnID)

	params := s.buildThreadParams()
	params["threadSource"] = threadSource
	params["threadId"] = state.ThreadID
	params["lastTurnId"] = state.ForkAtTurnID
	// As for a resume: Pockode renders the copied conversation from its own
	// history, so hydrating the fork's turns into the reply would buy nothing.
	params["excludeTurns"] = true

	result, err := s.sendRPC(ctx, "thread/fork", params)
	if err != nil {
		return err
	}
	return s.adoptThread(result)
}

// adoptThread records the thread a start, resume or fork opened. All three
// replies carry the same `thread` object — a new id for a start or a fork, the
// id it was given for a resume.
func (s *appSession) adoptThread(result json.RawMessage) error {
	var parsed struct {
		Thread struct {
			ID string `json:"id"`
		} `json:"thread"`
	}
	if err := json.Unmarshal(result, &parsed); err != nil {
		return fmt.Errorf("parse thread reply: %w", err)
	}
	if parsed.Thread.ID == "" {
		return errors.New("codex opened a thread without reporting its id")
	}

	s.stateMu.Lock()
	s.threadID = parsed.Thread.ID
	s.stateMu.Unlock()

	s.resume.record(parsed.Thread.ID)
	return nil
}

// buildThreadParams builds the settings shared by thread/start and thread/resume.
func (s *appSession) buildThreadParams() map[string]interface{} {
	overrides := map[string]interface{}{}
	if !s.opts.DisableMCP {
		// The proxy is spawned per thread, so it can be told which session it
		// speaks for right here (see mcp.Caller). An empty worktree name is the
		// main worktree, which the proxy assumes when not told.
		args := []string{"mcp", "--data-dir", s.opts.MCPDir()}
		if s.opts.SessionID != "" {
			args = append(args, "--session-id", s.opts.SessionID)
		}
		if s.opts.Worktree != "" {
			args = append(args, "--worktree", s.opts.Worktree)
		}
		overrides["mcp_servers"] = map[string]interface{}{
			"pockode": map[string]interface{}{
				"command": s.exe,
				"args":    args,
			},
		}
	}

	// Effort has no field of its own on thread/start — checked against the
	// protocol schema codex-cli 0.153.0 generates — so it rides in as a config
	// override, under the key config.toml uses. Codex forwards the value to the
	// API's reasoning.effort without checking it, which is why
	// session.IsValidEffort has to.
	if s.opts.Effort != "" {
		overrides["model_reasoning_effort"] = s.opts.Effort
	}

	params := map[string]interface{}{
		"cwd":    s.opts.WorkDir,
		"config": overrides,
	}

	if s.opts.Model != "" {
		params["model"] = s.opts.Model
	}

	switch s.opts.Mode {
	case session.ModeYolo:
		params["approvalPolicy"] = "never"
		params["sandbox"] = "danger-full-access"
	default:
		// "on-request" + "workspace-write" is Codex's own auto mode: work inside
		// the sandbox runs unprompted, only escapes from it (writes outside
		// WorkDir, network) ask for approval.
		//
		// Not "untrusted", which asks before every command. This channel does
		// accept it — unlike the MCP one, which rejected it outright — so the
		// choice is now a product one rather than a limit of the CLI: approving
		// every command one at a time on a phone is not a session anyone can
		// use. See docs/code/agent-integration.md.
		params["approvalPolicy"] = "on-request"
		params["sandbox"] = "workspace-write"
	}

	return params
}

func (s *appSession) currentThreadID() string {
	s.stateMu.Lock()
	defer s.stateMu.Unlock()
	return s.threadID
}

func (s *appSession) currentTurn() (threadID, turnID string) {
	s.stateMu.Lock()
	defer s.stateMu.Unlock()
	return s.threadID, s.turnID
}

// adoptTurn records the turn now running and reports whether a stop was waiting
// for it, which is the caller's cue to send the interrupt.
//
// Driven by notifications, which arrive on the single reader goroutine, so the
// recorded turn can never describe one that has already been replaced. The turn
// id the turn/start reply carries is deliberately not used for this: that reply
// is handled on a goroutine of its own, and a slow one could put a finished turn
// back after turn/completed had cleared it.
func (s *appSession) adoptTurn(turnID string) (threadID string, interrupt bool) {
	s.stateMu.Lock()
	defer s.stateMu.Unlock()
	s.turnID = turnID
	interrupt = s.interruptPending
	s.interruptPending = false
	return s.threadID, interrupt
}

// claimTurnOpener reports whether this is the first user message Codex has
// echoed inside the given turn, which is the message that opened it.
//
// Keyed on the turn the echo arrived stamped with rather than on the turn the
// session believes is running: the two can differ while a turn/start reply is
// still in flight, and the item's own stamp is the fact that cannot be stale.
//
// One turn can hold several echoes — every message steered into it is echoed as
// it is read — and only the first of them is the opener.
func (s *appSession) claimTurnOpener(turnID string) bool {
	s.stateMu.Lock()
	defer s.stateMu.Unlock()
	if s.openerEchoTurnID == turnID {
		return false
	}
	s.openerEchoTurnID = turnID
	return true
}

// clearTurn forgets the turn that just ended, along with any stop still waiting
// for one. A turn that ended on its own has nothing left to stop, and carrying
// the stop forward would kill whatever the user sends next.
func (s *appSession) clearTurn() {
	s.stateMu.Lock()
	s.turnID = ""
	s.interruptPending = false
	s.stateMu.Unlock()
}

// forgetWaitingStop drops a stop that is still waiting for a turn to name.
func (s *appSession) forgetWaitingStop() {
	s.stateMu.Lock()
	s.interruptPending = false
	s.stateMu.Unlock()
}

// --- JSON-RPC 2.0 ---

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      *int64          `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcResponse struct {
	Result json.RawMessage
	Error  *rpcError
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (e *rpcError) Error() string {
	return e.Message
}

// rpcMessage is used to determine the type of incoming message.
type rpcMessage struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      *int64          `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

// sendRPC sends a request and waits for its reply.
func (s *appSession) sendRPC(ctx context.Context, method string, params interface{}) (json.RawMessage, error) {
	id, ch, err := s.writeRPC(method, params)
	if err != nil {
		return nil, err
	}
	defer s.pendingRPCResults.Delete(id)

	select {
	case resp := <-ch:
		if resp.Error != nil {
			return nil, resp.Error
		}
		return resp.Result, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// sendRPCAsync sends a request and hands the reply to done on a goroutine, so
// the caller is not held up for as long as the CLI takes to answer. done is not
// called when the process ends first: everything waiting on that process is
// already being ended by ProcessEndedEvent.
func (s *appSession) sendRPCAsync(method string, params interface{}, done func(json.RawMessage, error)) error {
	id, ch, err := s.writeRPC(method, params)
	if err != nil {
		return err
	}

	go func() {
		defer s.pendingRPCResults.Delete(id)
		select {
		case resp := <-ch:
			if resp.Error != nil {
				done(nil, resp.Error)
				return
			}
			done(resp.Result, nil)
		case <-s.procCtx.Done():
		}
	}()

	return nil
}

// writeRPC registers a reply channel and writes the request.
func (s *appSession) writeRPC(method string, params interface{}) (int64, chan *rpcResponse, error) {
	paramsData, err := json.Marshal(params)
	if err != nil {
		return 0, nil, err
	}

	id := s.nextID.Add(1)
	ch := make(chan *rpcResponse, 1)
	s.pendingRPCResults.Store(id, ch)

	req := rpcRequest{JSONRPC: "2.0", ID: &id, Method: method, Params: paramsData}
	data, err := json.Marshal(req)
	if err == nil {
		err = s.writeStdin(data)
	}
	if err != nil {
		s.pendingRPCResults.Delete(id)
		return 0, nil, err
	}
	return id, ch, nil
}

// runReadLoop reads JSON-RPC messages from stdout and dispatches them.
func (s *appSession) runReadLoop(stdout io.Reader) {
	scanner := agent.NewLineScanner(stdout, agent.MaxLineBytes)

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}

		// A message too large to buffer is lost, but the stream is not: reading
		// on is what lets the turn still be ended by the frames behind it. See
		// agent.LineScanner.
		if scanner.Truncated() {
			s.log.Error("dropped a codex line too large to buffer", "lineLength", scanner.Len(), "limit", agent.MaxLineBytes)
			s.emitEvent(agent.WarningEvent{
				Message: fmt.Sprintf("Some output was too large to display (%d bytes) and was skipped", scanner.Len()),
				Code:    "scanner_buffer_overflow",
			})
			continue
		}

		var msg rpcMessage
		if err := json.Unmarshal(line, &msg); err != nil {
			s.log.Warn("failed to parse JSON-RPC from codex", "error", err, "lineLength", len(line))
			continue
		}

		switch {
		case msg.Method != "" && msg.ID != nil:
			s.handleServerRequest(msg)
		case msg.Method != "":
			s.handleNotification(msg)
		case msg.ID != nil:
			s.handleResponse(msg)
		}
	}

	if err := scanner.Err(); err != nil {
		s.log.Error("stdout scanner error", "error", err)
	}
}

// handleResponse routes a reply to the waiting caller.
func (s *appSession) handleResponse(msg rpcMessage) {
	pending, ok := s.pendingRPCResults.Load(*msg.ID)
	if !ok {
		s.log.Debug("reply to a request nobody is waiting for", "id", *msg.ID)
		return
	}
	ch := pending.(chan *rpcResponse)
	select {
	case ch <- &rpcResponse{Result: msg.Result, Error: msg.Error}:
	default:
	}
}

// --- Helpers ---

// emitEvent puts an event on the channel, from whichever goroutine produced it.
//
// The lock is what makes that safe from the goroutines that are not the reader:
// an approval waiting on the user, or the reply to an async request. Those can
// reach here for the first time after the reader has already closed the channel,
// and a send on a closed channel panics — on a goroutine with no recover, which
// takes the whole server with it. Holding it as a reader keeps the close out
// until every sender in flight has left, and closed tells the ones that arrive
// afterwards that there is nowhere to put this.
//
// Senders parked in the select do not hold the close out forever: closeEvents
// cancels procCtx before it asks for the lock, which frees every one of them.
//
// A lock rather than joining the senders, which is how the Claude session keeps
// its one off-reader emitter out of the way (background_wait, waited for before
// the close). There is no fixed set to join here: a goroutine is spawned per
// approval and per async request, so there is nothing to hold a WaitGroup that
// the close could not race with.
func (s *appSession) emitEvent(event agent.AgentEvent) {
	s.eventsMu.RLock()
	defer s.eventsMu.RUnlock()
	if s.eventsClosed {
		return
	}
	select {
	case s.events <- event:
	case <-s.procCtx.Done():
	}
}

// closeEvents ends the session's event stream, after the senders still inside
// emitEvent have left. Cancelling first is what lets them leave: it is the other
// half of every select in there, and of every wait an approval is parked on.
func (s *appSession) closeEvents() {
	s.cancel()

	s.eventsMu.Lock()
	defer s.eventsMu.Unlock()
	s.eventsClosed = true
	close(s.events)
}

func (s *appSession) sendRPCResponse(id int64, result interface{}, rpcErr *rpcError) {
	resp := struct {
		JSONRPC string      `json:"jsonrpc"`
		ID      int64       `json:"id"`
		Result  interface{} `json:"result,omitempty"`
		Error   *rpcError   `json:"error,omitempty"`
	}{JSONRPC: "2.0", ID: id, Result: result, Error: rpcErr}

	data, err := json.Marshal(resp)
	if err != nil {
		s.log.Error("failed to marshal RPC response", "error", err)
		return
	}
	if err := s.writeStdin(data); err != nil {
		s.log.Error("failed to send RPC response", "id", id, "error", err)
	}
}

func (s *appSession) writeStdin(data []byte) error {
	s.stdinMu.Lock()
	defer s.stdinMu.Unlock()
	_, err := s.stdin.Write(append(data, '\n'))
	return err
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

// --- Version detection ---

// checkAppServerSupport refuses to start when the installed CLI has no
// app-server subcommand, which is the whole of what this package speaks.
//
// The subcommand list is asked for directly rather than derived from
// `--version`: the version this channel appeared in is not documented anywhere
// Pockode can check, and a wrong guess would either lock out installs that work
// or let a failure surface as an unreadable JSON-RPC error much later.
func checkAppServerSupport(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, supportProbeTimeout)
	defer cancel()

	cmd, err := agent.CommandContext(ctx, Binary, "--help")
	if err != nil {
		return err
	}
	// The context kills the process, but Wait still blocks until the stdout pipe
	// closes — a grandchild holding it open would restore the unbounded wait this
	// timeout exists to prevent. WaitDelay caps that tail.
	cmd.WaitDelay = time.Second

	out, err := cmd.Output()
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return fmt.Errorf("codex --help did not finish within %s", supportProbeTimeout)
		}
		return fmt.Errorf("could not run %s --help: %w", Binary, err)
	}

	if !listsAppServer(string(out)) {
		return errors.New("this codex CLI has no `app-server` subcommand, which Pockode needs to run a Codex session; update codex and try again")
	}
	return nil
}

// listsAppServer reports whether `codex --help` offers the app-server
// subcommand. Subcommands are listed one per line as an indented name followed
// by its description, so the name is the line's first field — matching anywhere
// in the text would also hit the prose of neighbouring entries ("remote-control
// [experimental] Manage the app-server daemon ...", on codex-cli 0.153.0).
func listsAppServer(help string) bool {
	for _, line := range strings.Split(help, "\n") {
		if !strings.HasPrefix(line, " ") && !strings.HasPrefix(line, "\t") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) > 0 && fields[0] == appServerSubcommand {
			return true
		}
	}
	return false
}
