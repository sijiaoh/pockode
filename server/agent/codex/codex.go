// Package codex implements Agent interface using Codex CLI via MCP over STDIO.
package codex

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/logger"
	"github.com/pockode/server/session"
)

const Binary = "codex"

// Startup steps must be bounded: process.Manager calls Agent.Start while holding
// its worktree-wide process lock, so a step that never returns deadlocks every
// session of the worktree. A timeout downgrades that to a recoverable start
// failure.
//
// Both budgets cover local work only — `--version` just prints a string, and the
// MCP handshake is answered before Codex does anything with the model — so they
// are sized for a cold start on a loaded machine, not for model latency.
//
// The client is sized against their sum: web/src/lib/wsStore.ts mirrors it as
// CODEX_START_BUDGET_MS and keeps the timeout of the requests that run Start
// above it, with margin. Raising either budget eats into that margin, and once
// the sum outgrows it the client gives up first: the error naming the stalled
// step then goes into a reply nobody is waiting for. Grow these two and the web
// constant together.
const (
	versionProbeTimeout = 10 * time.Second
	handshakeTimeout    = 30 * time.Second
)

// Agent implements agent.Agent using Codex CLI via MCP.
type Agent struct{}

// New creates a new Codex Agent.
func New() *Agent {
	return &Agent{}
}

// Start launches a persistent Codex MCP server process.
func (a *Agent) Start(ctx context.Context, opts agent.StartOptions) (agent.Session, error) {
	procCtx, cancel := context.WithCancel(ctx)

	mcpSubcommand, err := getMCPSubcommand(procCtx)
	if err != nil {
		cancel()
		return nil, err
	}

	exe, err := os.Executable()
	if err != nil {
		cancel()
		return nil, fmt.Errorf("resolve executable path: %w", err)
	}

	cmd := exec.CommandContext(procCtx, Binary, mcpSubcommand)
	cmd.Dir = opts.WorkDir

	stdin, err := cmd.StdinPipe()
	if err != nil {
		cancel()
		return nil, fmt.Errorf("failed to create stdin pipe: %w", err)
	}

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		stdin.Close()
		cancel()
		return nil, fmt.Errorf("failed to create stdout pipe: %w", err)
	}

	stderr, err := cmd.StderrPipe()
	if err != nil {
		stdin.Close()
		stdout.Close()
		cancel()
		return nil, fmt.Errorf("failed to create stderr pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		stdin.Close()
		stdout.Close()
		stderr.Close()
		cancel()
		return nil, fmt.Errorf("failed to start codex: %w", err)
	}

	log := slog.With("sessionId", opts.SessionID, "agent", "codex")
	log.Info("codex process started", "pid", cmd.Process.Pid, "subcommand", mcpSubcommand)

	events := make(chan agent.AgentEvent, 100)

	sess := &mcpSession{
		log:               log,
		events:            events,
		stdin:             stdin,
		cancel:            cancel,
		procCtx:           procCtx,
		opts:              opts,
		exe:               exe,
		pendingRPCResults: &sync.Map{},
		pendingElicit:     &sync.Map{},
	}

	if opts.Resume {
		sess.warnSessionNotResumable()
	}

	go func() {
		defer func() {
			if r := recover(); r != nil {
				logger.LogPanic(r, "codex process crashed", "sessionId", opts.SessionID)
			}
		}()
		defer close(events)
		defer cancel()
		defer stdout.Close()
		defer stderr.Close()

		stderrCh := agent.ReadStderr(stderr, "codex")
		sess.runMCPLoop(procCtx, stdout)
		sess.cleanupPendingElicitations()
		agent.WaitForProcess(procCtx, log, cmd, stderrCh, events)

		select {
		case events <- agent.ProcessEndedEvent{}:
		case <-procCtx.Done():
		}
	}()

	// Initialize the MCP connection before returning. The deadline lives on a
	// child context so it expires with the handshake instead of taking procCtx —
	// and the running CLI — down with it.
	initCtx, cancelInit := context.WithTimeout(procCtx, handshakeTimeout)
	defer cancelInit()

	if err := sess.initialize(initCtx); err != nil {
		sess.Close()
		if errors.Is(initCtx.Err(), context.DeadlineExceeded) {
			return nil, fmt.Errorf("codex did not answer the MCP handshake within %s", handshakeTimeout)
		}
		return nil, fmt.Errorf("MCP initialize failed: %w", err)
	}

	return sess, nil
}

// mcpSession implements agent.Session for Codex MCP.
type mcpSession struct {
	log     *slog.Logger
	events  chan agent.AgentEvent
	stdin   io.WriteCloser
	stdinMu sync.Mutex
	cancel  func()
	procCtx context.Context
	opts    agent.StartOptions
	exe     string // resolved executable path for MCP server config

	nextID            atomic.Int64
	pendingRPCResults *sync.Map // id -> chan *rpcResponse
	pendingElicit     *sync.Map // id -> chan elicitAnswer

	idMu     sync.Mutex // protects threadID
	threadID string

	closeOnce sync.Once
}

// Events returns the event channel.
func (s *mcpSession) Events() <-chan agent.AgentEvent {
	return s.events
}

// SendMessage sends a message to Codex.
func (s *mcpSession) SendMessage(prompt string) error {
	s.log.Debug("sending prompt", "length", len(prompt))

	s.idMu.Lock()
	threadID := s.threadID
	s.idMu.Unlock()

	if threadID == "" {
		// First message: start a new session.
		return s.callToolAsync("codex", s.buildStartConfig(prompt))
	}

	// Subsequent messages continue the same thread. `threadId` is what current
	// CLIs read; `conversationId` is its deprecated predecessor, still accepted
	// and the only key CLIs before the rename understand. Sending both keeps one
	// call working across versions — neither side rejects the extra field.
	return s.callToolAsync("codex-reply", map[string]interface{}{
		"threadId":       threadID,
		"conversationId": threadID,
		"prompt":         prompt,
	})
}

// SendPermissionResponse sends a permission response.
func (s *mcpSession) SendPermissionResponse(data agent.PermissionRequestData, choice agent.PermissionChoice) error {
	var decision string
	switch choice {
	case agent.PermissionAllow:
		decision = "approved"
	case agent.PermissionAlwaysAllow:
		decision = "approved_for_session"
	default:
		decision = "denied"
	}

	if pending, ok := s.pendingElicit.LoadAndDelete(data.RequestID); ok {
		ch := pending.(chan elicitAnswer)
		select {
		case ch <- elicitAnswer{decision: decision}:
		default:
		}
	}
	return nil
}

// SendQuestionResponse is not applicable for Codex (Codex doesn't use AskUserQuestion).
func (s *mcpSession) SendQuestionResponse(data agent.QuestionRequestData, answers map[string]string) error {
	// Codex uses elicitation for permissions, not AskUserQuestion.
	return nil
}

// SendInterrupt sends an abort by cancelling the current tool call.
func (s *mcpSession) SendInterrupt() error {
	s.log.Info("sending interrupt (cancel notification)")

	// Resolve pending elicitations FIRST so RequestCancelledEvent is enqueued
	// before InterruptedEvent (which is emitted when callToolAsync receives
	// the synthetic RPC response below).
	s.cleanupPendingElicitations()

	// Send MCP cancellation for pending requests.
	s.pendingRPCResults.Range(func(key, value any) bool {
		id := key.(int64)
		notification := rpcRequest{
			JSONRPC: "2.0",
			Method:  "notifications/cancelled",
			Params:  json.RawMessage(fmt.Sprintf(`{"requestId":%d,"reason":"user interrupted"}`, id)),
		}
		if data, err := json.Marshal(notification); err == nil {
			s.writeStdin(data)
		}

		// Unblock the callToolAsync goroutine with a synthetic response: Codex
		// answers neither the cancelled tools/call nor any other pending request.
		ch := value.(chan *rpcResponse)
		select {
		case ch <- &rpcResponse{abortReason: abortReasonInterrupted}:
		default:
		}
		return true
	})

	return nil
}

// Close terminates the Codex process.
func (s *mcpSession) Close() {
	s.closeOnce.Do(func() {
		s.log.Info("terminating codex process")
		s.cancel()
		s.stdinMu.Lock()
		s.stdin.Close()
		s.stdinMu.Unlock()
	})
}

// --- MCP JSON-RPC 2.0 ---

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      *int64          `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      *int64          `json:"id,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`

	// abortReason is only set on responses Pockode synthesizes for a turn Codex
	// aborted. Codex never answers the tools/call of an aborted turn, so without
	// a synthetic response the turn would stay "running" until the process exits.
	abortReason string
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
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

type elicitAnswer struct {
	decision string
}

// initialize sends the MCP initialize handshake.
func (s *mcpSession) initialize(ctx context.Context) error {
	params := map[string]interface{}{
		"protocolVersion": "2025-03-26",
		"capabilities": map[string]interface{}{
			"elicitation": map[string]interface{}{},
		},
		"clientInfo": map[string]interface{}{
			"name":    "pockode",
			"version": "1.0.0",
		},
	}
	result, err := s.sendRPC(ctx, "initialize", params)
	if err != nil {
		return fmt.Errorf("initialize: %w", err)
	}
	s.log.Info("MCP initialized", "result", string(result))

	// Send initialized notification.
	notification := rpcRequest{
		JSONRPC: "2.0",
		Method:  "notifications/initialized",
	}
	data, err := json.Marshal(notification)
	if err != nil {
		return err
	}
	return s.writeStdin(data)
}

// sendRPC sends a JSON-RPC request and waits for the response.
func (s *mcpSession) sendRPC(ctx context.Context, method string, params interface{}) (json.RawMessage, error) {
	id := s.nextID.Add(1)
	ch := make(chan *rpcResponse, 1)
	s.pendingRPCResults.Store(id, ch)
	defer s.pendingRPCResults.Delete(id)

	paramsData, err := json.Marshal(params)
	if err != nil {
		return nil, err
	}

	req := rpcRequest{
		JSONRPC: "2.0",
		ID:      &id,
		Method:  method,
		Params:  paramsData,
	}
	data, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}

	if err := s.writeStdin(data); err != nil {
		return nil, err
	}

	select {
	case resp := <-ch:
		// An interrupt resolves every pending request, this one included.
		if resp.abortReason != "" {
			return nil, fmt.Errorf("%s cancelled: %s", method, resp.abortReason)
		}
		if resp.Error != nil {
			return nil, fmt.Errorf("RPC error %d: %s", resp.Error.Code, resp.Error.Message)
		}
		return resp.Result, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// callToolAsync sends a tools/call request and processes the result asynchronously.
// Events are emitted via the events channel as they arrive (from notifications).
// The tool call result triggers a DoneEvent.
func (s *mcpSession) callToolAsync(toolName string, args interface{}) error {
	id := s.nextID.Add(1)
	ch := make(chan *rpcResponse, 1)
	s.pendingRPCResults.Store(id, ch)

	params := map[string]interface{}{
		"name":      toolName,
		"arguments": args,
	}
	paramsData, err := json.Marshal(params)
	if err != nil {
		s.pendingRPCResults.Delete(id)
		return err
	}

	req := rpcRequest{
		JSONRPC: "2.0",
		ID:      &id,
		Method:  "tools/call",
		Params:  paramsData,
	}
	data, err := json.Marshal(req)
	if err != nil {
		s.pendingRPCResults.Delete(id)
		return err
	}

	if err := s.writeStdin(data); err != nil {
		s.pendingRPCResults.Delete(id)
		return err
	}

	// Wait for the response in a goroutine to keep SendMessage non-blocking.
	go func() {
		defer s.pendingRPCResults.Delete(id)
		var resp *rpcResponse
		select {
		case resp = <-ch:
		case <-s.procCtx.Done():
			return
		}
		if resp == nil {
			return
		}
		if resp.abortReason != "" {
			s.emitEvent(abortEvent(resp.abortReason))
			return
		}
		if resp.Error != nil {
			s.emitEvent(agent.ErrorEvent{Error: fmt.Sprintf("codex tool call failed: %s", resp.Error.Message)})
			return
		}
		s.emitEvent(s.parseTurnResult(resp.Result))
	}()

	return nil
}

// buildStartConfig builds the Codex session start configuration.
func (s *mcpSession) buildStartConfig(prompt string) map[string]interface{} {
	overrides := map[string]interface{}{}
	if !s.opts.DisableMCP {
		overrides["mcp_servers"] = map[string]interface{}{
			"pockode": map[string]interface{}{
				"command": s.exe,
				"args":    []string{"mcp", "--data-dir", s.opts.MCPDir()},
			},
		}
	}

	config := map[string]interface{}{
		"prompt": prompt,
		"cwd":    s.opts.WorkDir,
		"config": overrides,
	}

	switch s.opts.Mode {
	case session.ModeYolo:
		config["approval-policy"] = "never"
		config["sandbox"] = "danger-full-access"
	default:
		// Not "untrusted": current Codex CLIs reject that policy from both the tool
		// arg ("unknown variant `untrusted`", failing the session's first call, so
		// not one message gets through) and config.toml ("no longer supported");
		// verified on codex-cli 0.153.0. "on-request" + "workspace-write" is Codex's
		// own auto mode and is valid on old and new CLIs alike: work inside the
		// sandbox runs unprompted, only escapes from it (writes outside WorkDir,
		// network) ask for approval.
		config["approval-policy"] = "on-request"
		config["sandbox"] = "workspace-write"
	}

	return config
}

// runMCPLoop reads JSON-RPC messages from stdout and dispatches them.
func (s *mcpSession) runMCPLoop(ctx context.Context, stdout io.Reader) {
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}

		var msg rpcMessage
		if err := json.Unmarshal(line, &msg); err != nil {
			s.log.Warn("failed to parse JSON-RPC from codex", "error", err, "lineLength", len(line))
			continue
		}

		if msg.Method != "" && msg.ID != nil {
			// Server-to-client request (e.g., elicitation/create).
			s.handleServerRequest(ctx, msg)
		} else if msg.Method != "" {
			// Notification (e.g., codex/event).
			s.handleNotification(msg)
		} else if msg.ID != nil {
			// Response to our request.
			s.handleResponse(msg)
		}
	}

	if err := scanner.Err(); err != nil {
		s.log.Error("stdout scanner error", "error", err)
	}
}

// handleResponse routes a JSON-RPC response to the waiting caller.
func (s *mcpSession) handleResponse(msg rpcMessage) {
	id := *msg.ID
	if pending, ok := s.pendingRPCResults.Load(id); ok {
		ch := pending.(chan *rpcResponse)
		resp := &rpcResponse{
			JSONRPC: msg.JSONRPC,
			ID:      msg.ID,
			Result:  msg.Result,
			Error:   msg.Error,
		}
		select {
		case ch <- resp:
		default:
		}
	}
}

// handleNotification processes notifications from the Codex MCP server.
func (s *mcpSession) handleNotification(msg rpcMessage) {
	switch msg.Method {
	case "codex/event":
		s.handleCodexEventDirect(msg.Params)
	case "notifications/message":
		s.handleCodexEventLogging(msg.Params)
	default:
		s.log.Debug("unhandled notification", "method", msg.Method)
	}
}

// handleCodexEventDirect handles the codex/event custom notification.
// Wire format: {"jsonrpc":"2.0","method":"codex/event","params":{"_meta":{"requestId":2},"msg":{...}}}
func (s *mcpSession) handleCodexEventDirect(params json.RawMessage) {
	var notif struct {
		Meta json.RawMessage `json:"_meta"`
		Msg  json.RawMessage `json:"msg"`
	}
	if err := json.Unmarshal(params, &notif); err != nil {
		s.log.Warn("failed to parse codex/event params", "error", err)
		return
	}
	s.processCodexMsg(notif.Msg, requestIDFromMeta(notif.Meta))
}

// requestIDFromMeta extracts the id of the tools/call an event belongs to.
// Codex mirrors the id type the client used, and Pockode only ever sends
// numeric ids, so anything else did not originate from one of our calls.
func requestIDFromMeta(meta json.RawMessage) *int64 {
	if len(meta) == 0 {
		return nil
	}
	var parsed struct {
		RequestID *int64 `json:"requestId"`
	}
	if err := json.Unmarshal(meta, &parsed); err != nil {
		return nil
	}
	return parsed.RequestID
}

// handleCodexEventLogging handles the standard MCP notifications/message, the
// channel CLIs older than the codex/event notification used.
// Wire format: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":{"msg":{...}}}}
func (s *mcpSession) handleCodexEventLogging(params json.RawMessage) {
	var notif struct {
		Data struct {
			Msg json.RawMessage `json:"msg"`
		} `json:"data"`
	}
	if err := json.Unmarshal(params, &notif); err != nil {
		s.log.Warn("failed to parse notifications/message params", "error", err)
		return
	}
	s.processCodexMsg(notif.Data.Msg, nil)
}

// ignoredCodexEvents are event types Pockode deliberately drops, listed so the
// default branch keeps meaning "type we have never seen".
//
// Why a list and not a blanket "forward what we do not recognise": Codex emits
// 70+ event types, most of them per-turn bookkeeping or duplicates of data we
// already render, and it keeps adding more — anything forwarded by default ends
// up as transcript noise.
//
// Two groups deserve a note beyond their heading below: item_started and
// item_completed mirror the whole turn a second time in the "thread item"
// shape, and the last group (reasoning, plan, web search, turn diff) carries
// information Pockode simply has no surface for yet — dropped by choice, not by
// accident.
var ignoredCodexEvents = map[string]bool{
	// Turn bookkeeping.
	"task_started":        true,
	"turn_started":        true, // newer alias of task_started
	"task_complete":       true, // the tools/call result ends the turn
	"turn_complete":       true, // newer alias of task_complete
	"token_count":         true, // usage and rate-limit accounting
	"shutdown_complete":   true,
	"context_compacted":   true,
	"thread_goal_updated": true,
	"hook_started":        true,
	"hook_completed":      true,
	"mcp_startup_update":  true, // per-server progress; the summary is reported
	"deprecation_notice":  true, // aimed at CLI users, not at this session

	// Second copies of content rendered elsewhere.
	"user_message":      true, // echo of the prompt Pockode just sent
	"raw_response_item": true,
	"item_started":      true,
	"item_completed":    true,

	// Approval requests reach the user as an elicitation instead. Codex emits
	// the begin event of a command or patch *before* asking for approval, and
	// the approval request repeats that call_id, so rendering both shows the
	// same work twice and leaves one copy without a result.
	"exec_approval_request":        true,
	"apply_patch_approval_request": true,

	// Incremental copies of content that also arrives complete.
	"agent_message_content_delta": true,
	"reasoning_content_delta":     true,
	"reasoning_raw_content_delta": true,
	"exec_command_output_delta":   true,
	"plan_delta":                  true,
	"patch_apply_updated":         true, // partial patch preview; the begin/end pair is rendered

	// Real information with no surface in Pockode yet.
	"agent_reasoning":               true,
	"agent_reasoning_raw_content":   true,
	"agent_reasoning_section_break": true,
	"plan_update":                   true,
	"turn_diff":                     true,
	"web_search_begin":              true,
	"web_search_end":                true,
}

// processCodexMsg processes a single Codex event message. requestID identifies
// the tools/call the event belongs to, when the notification carried one.
func (s *mcpSession) processCodexMsg(raw json.RawMessage, requestID *int64) {
	if len(raw) == 0 {
		return
	}

	var codexMsg struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(raw, &codexMsg); err != nil {
		s.log.Debug("codex event msg not structured", "error", err)
		return
	}

	switch codexMsg.Type {
	case "session_configured":
		// Start of the session, and the earliest report of the thread id that
		// every following turn has to be sent to.
		s.rememberThreadIDFromEvent(raw)

	case "agent_message":
		var ev struct {
			Message string `json:"message"`
		}
		if err := json.Unmarshal(raw, &ev); err != nil {
			s.log.Warn("failed to parse agent_message", "error", err)
			return
		}
		if ev.Message != "" {
			s.emitEvent(agent.TextEvent{Content: ev.Message})
		}

	case "exec_command_begin":
		var ev struct {
			CallID  string          `json:"call_id"`
			Command json.RawMessage `json:"command"`
			Cwd     string          `json:"cwd"`
		}
		if err := json.Unmarshal(raw, &ev); err != nil {
			s.log.Warn("failed to parse exec_command_begin", "error", err)
			return
		}
		command := normalizeCommand(ev.Command)
		inputMap := map[string]interface{}{
			"command": command,
			"cwd":     ev.Cwd,
		}
		input, _ := json.Marshal(inputMap)
		s.emitEvent(agent.ToolCallEvent{
			ToolUseID: ev.CallID,
			ToolName:  "Bash",
			ToolInput: input,
		})

	case "exec_command_end":
		var ev struct {
			CallID string `json:"call_id"`
			// formatted_output is the output as the model saw it: the merged
			// stream, truncated, with a note when the command timed out. The
			// other fields back it up for CLIs that omit it.
			FormattedOutput  string `json:"formatted_output"`
			AggregatedOutput string `json:"aggregated_output"`
			Stdout           string `json:"stdout"`
			Stderr           string `json:"stderr"`
			ExitCode         int    `json:"exit_code"`
		}
		if err := json.Unmarshal(raw, &ev); err != nil {
			s.log.Warn("failed to parse exec_command_end", "error", err)
			return
		}
		result := firstNonEmpty(ev.FormattedOutput, ev.AggregatedOutput, joinOutput(ev.Stdout, ev.Stderr))
		if result == "" && ev.ExitCode != 0 {
			// A silent failure is still a failure: without this the user sees an
			// empty result and no hint that the command did not succeed.
			result = fmt.Sprintf("(no output, exit code %d)", ev.ExitCode)
		}
		s.emitEvent(agent.ToolResultEvent{
			ToolUseID:  ev.CallID,
			ToolResult: result,
		})

	case "patch_apply_begin":
		var ev struct {
			CallID  string          `json:"call_id"`
			Changes json.RawMessage `json:"changes"`
		}
		if err := json.Unmarshal(raw, &ev); err != nil {
			s.log.Warn("failed to parse patch_apply_begin", "error", err)
			return
		}
		s.emitEvent(agent.ToolCallEvent{
			ToolUseID: ev.CallID,
			ToolName:  "Edit",
			ToolInput: buildEditInput(ev.Changes),
		})

	case "patch_apply_end":
		var ev struct {
			CallID  string `json:"call_id"`
			Stdout  string `json:"stdout"`
			Stderr  string `json:"stderr"`
			Success bool   `json:"success"`
		}
		if err := json.Unmarshal(raw, &ev); err != nil {
			s.log.Warn("failed to parse patch_apply_end", "error", err)
			return
		}
		result := ev.Stdout
		if !ev.Success && ev.Stderr != "" {
			result = ev.Stderr
		}
		s.emitEvent(agent.ToolResultEvent{
			ToolUseID:  ev.CallID,
			ToolResult: result,
		})

	case "mcp_tool_call_begin":
		var ev struct {
			CallID     string `json:"call_id"`
			Invocation struct {
				Server    string          `json:"server"`
				Tool      string          `json:"tool"`
				Arguments json.RawMessage `json:"arguments"`
			} `json:"invocation"`
		}
		if err := json.Unmarshal(raw, &ev); err != nil {
			s.log.Warn("failed to parse mcp_tool_call_begin", "error", err)
			return
		}
		// Use arguments directly as input; server:tool is encoded in the name.
		input := ev.Invocation.Arguments
		if len(input) == 0 {
			input = json.RawMessage("{}")
		}
		s.emitEvent(agent.ToolCallEvent{
			ToolUseID: ev.CallID,
			ToolName:  ev.Invocation.Server + ":" + ev.Invocation.Tool,
			ToolInput: input,
		})

	case "mcp_tool_call_end":
		var ev struct {
			CallID string `json:"call_id"`
			Result struct {
				Ok *struct {
					Content []struct {
						Text string `json:"text"`
					} `json:"content"`
					IsError bool `json:"isError"`
				} `json:"Ok"`
				Err string `json:"Err"`
			} `json:"result"`
		}
		if err := json.Unmarshal(raw, &ev); err != nil {
			s.log.Warn("failed to parse mcp_tool_call_end", "error", err)
			return
		}
		var result string
		if ev.Result.Err != "" {
			result = ev.Result.Err
		} else if ev.Result.Ok != nil {
			var parts []string
			for _, c := range ev.Result.Ok.Content {
				if c.Text != "" {
					parts = append(parts, c.Text)
				}
			}
			result = strings.Join(parts, "\n")
		}
		s.emitEvent(agent.ToolResultEvent{
			ToolUseID:  ev.CallID,
			ToolResult: result,
		})

	case "mcp_startup_complete":
		var ev struct {
			Failed []struct {
				Server string `json:"server"`
				Error  string `json:"error"`
			} `json:"failed"`
		}
		if err := json.Unmarshal(raw, &ev); err != nil {
			s.log.Warn("failed to parse mcp_startup_complete", "error", err)
			return
		}
		// A server that fails to start silently removes its tools from the
		// session — for the pockode server that means no work_* tools at all.
		for _, failed := range ev.Failed {
			s.log.Warn("codex MCP server failed to start", "server", failed.Server, "error", failed.Error)
			s.emitEvent(agent.WarningEvent{
				Message: fmt.Sprintf("MCP server %q failed to start, its tools are unavailable: %s", failed.Server, failed.Error),
				Code:    "mcp_startup_failed",
			})
		}

	case "stream_error", "warning", "guardian_warning":
		// Non-fatal: the turn keeps going. Surfacing them is what explains a
		// stalled turn (stream retries) or a guardrail that changed what ran.
		var ev struct {
			Message string `json:"message"`
		}
		if err := json.Unmarshal(raw, &ev); err != nil {
			s.log.Warn("failed to parse codex warning event", "type", codexMsg.Type, "error", err)
			return
		}
		if ev.Message == "" {
			s.log.Debug("ignoring codex warning without a message", "type", codexMsg.Type)
			return
		}
		s.emitEvent(agent.WarningEvent{Message: ev.Message, Code: codexMsg.Type})

	case "error":
		// Fatal for the turn, and Codex answers the tools/call with the same
		// message and isError set. parseTurnResult reports it from there, which
		// also covers the failures that never produce an error event.
		var ev struct {
			Message string `json:"message"`
			// A plain string for most causes, an object for the ones that carry
			// details (an HTTP status, for example).
			Info json.RawMessage `json:"codex_error_info"`
		}
		if err := json.Unmarshal(raw, &ev); err != nil {
			s.log.Warn("failed to parse codex error event", "error", err)
			return
		}
		s.log.Info("codex reported a turn error", "message", ev.Message, "info", string(ev.Info))

	case "turn_aborted":
		var ev struct {
			Reason string `json:"reason"`
		}
		if err := json.Unmarshal(raw, &ev); err != nil {
			// Deliberately no early return: an abort we cannot read is still an
			// abort, and leaving the turn pending would hang the session.
			s.log.Warn("failed to parse turn_aborted", "error", err)
		}
		s.log.Info("codex turn aborted", "reason", ev.Reason)
		s.abortPendingTurn(requestID, ev.Reason)

	default:
		if ignoredCodexEvents[codexMsg.Type] {
			return
		}
		s.log.Debug("unhandled codex event type", "type", codexMsg.Type)
	}
}

// handleServerRequest handles JSON-RPC requests from the server (e.g., elicitation).
func (s *mcpSession) handleServerRequest(ctx context.Context, msg rpcMessage) {
	switch msg.Method {
	case "elicitation/create":
		go s.handleElicitation(ctx, msg)
	default:
		s.log.Debug("unhandled server request", "method", msg.Method)
		// Respond with method not found.
		s.sendRPCResponse(*msg.ID, nil, &rpcError{Code: -32601, Message: "method not found"})
	}
}

// handleElicitation handles an elicitation request (permission prompt) from Codex.
func (s *mcpSession) handleElicitation(ctx context.Context, msg rpcMessage) {
	var params struct {
		Message            string          `json:"message"`
		CodexElicitation   string          `json:"codex_elicitation"`
		CodexCallID        string          `json:"codex_call_id"`
		CodexCommand       json.RawMessage `json:"codex_command"`
		CodexCwd           string          `json:"codex_cwd"`
		CodexChanges       json.RawMessage `json:"codex_changes"`
		CodexMCPToolCallID string          `json:"codex_mcp_tool_call_id"`
		CodexEventID       string          `json:"codex_event_id"`
	}
	if err := json.Unmarshal(msg.Params, &params); err != nil {
		s.log.Warn("failed to parse elicitation params", "error", err)
		// Deliberately not deniedByUser: nobody decided anything here, and this
		// text is what the model gets told, so blaming the user for a request we
		// could not read would send it looking in the wrong place.
		s.sendRPCResponse(*msg.ID, denialResponse("Pockode could not read this approval request."), nil)
		return
	}

	requestID := params.CodexCallID
	if requestID == "" {
		requestID = fmt.Sprintf("elicit-%d", *msg.ID)
	}

	// Route based on elicitation type. Codex only ever sends these two, and a
	// patch approval describes its edits in codex_changes, not codex_command.
	toolName := "Bash"
	var toolInput json.RawMessage
	switch params.CodexElicitation {
	case "patch-approval":
		toolName = "Edit"
		toolInput = buildEditInput(params.CodexChanges)
	default:
		command := normalizeCommand(params.CodexCommand)
		inputMap := map[string]interface{}{
			"command": command,
			"cwd":     params.CodexCwd,
		}
		toolInput, _ = json.Marshal(inputMap)
	}

	ch := make(chan elicitAnswer, 1)
	s.pendingElicit.Store(requestID, ch)

	// ToolUseID is the id of the command or patch being approved, so the prompt
	// points at the same call as the tool events. codex_mcp_tool_call_id, which
	// identifies the whole tools/call, is the fallback for CLIs that omit it.
	s.emitEvent(agent.PermissionRequestEvent{
		RequestID: requestID,
		ToolName:  toolName,
		ToolInput: toolInput,
		ToolUseID: firstNonEmpty(params.CodexCallID, params.CodexMCPToolCallID),
	})

	// Wait for user response.
	var answer elicitAnswer
	select {
	case answer = <-ch:
	case <-ctx.Done():
		answer = elicitAnswer{decision: "denied"}
	}

	s.pendingElicit.Delete(requestID)

	s.sendRPCResponse(*msg.ID, elicitationResponse(answer.decision), nil)
}

// deniedByUser is the reason Codex hands the model when the user refuses; it
// reaches the transcript as Rejected("..."), so it has to read as an
// explanation rather than a status code.
const deniedByUser = "The user denied this request."

// elicitationResponse answers one elicitation. Anything that is not an approval
// denies, so a decision we do not recognise fails closed.
func elicitationResponse(decision string) map[string]interface{} {
	if decision == "approved" || decision == "approved_for_session" {
		return map[string]interface{}{"action": "accept", "decision": decision}
	}
	return denialResponse(deniedByUser)
}

// denialResponse refuses an elicitation, telling Codex why.
//
// Codex deserializes `decision` into its ReviewDecision, which is externally
// tagged: the approvals are unit variants and travel as bare strings, but
// `denied` is a struct variant and needs {"denied": {"rejection": "..."}}. The
// bare string "denied" fails to deserialize, after which Codex reports
// "approval request failed" to the model instead of the refusal. It still
// blocks the request either way, which is why that mistake survives any test
// that only checks the denied work did not happen — the difference is in what
// comes back. `rejection` is the text the model reads, and for a patch it also
// returns as patch_apply_end's stderr. Verified against codex-cli 0.153.0.
func denialResponse(rejection string) map[string]interface{} {
	return map[string]interface{}{
		// MCP's own field, which Codex does not appear to read at all: the
		// "deny" this used to send is not one of MCP's values and Codex took it
		// regardless. "decline" is the value MCP defines for a refusal.
		"action":   "decline",
		"decision": map[string]interface{}{"denied": map[string]interface{}{"rejection": rejection}},
	}
}

// --- Helpers ---

func (s *mcpSession) emitEvent(event agent.AgentEvent) {
	select {
	case s.events <- event:
	case <-s.procCtx.Done():
	}
}

func (s *mcpSession) sendRPCResponse(id int64, result interface{}, rpcErr *rpcError) {
	resp := struct {
		JSONRPC string      `json:"jsonrpc"`
		ID      int64       `json:"id"`
		Result  interface{} `json:"result,omitempty"`
		Error   *rpcError   `json:"error,omitempty"`
	}{
		JSONRPC: "2.0",
		ID:      id,
		Result:  result,
		Error:   rpcErr,
	}
	data, err := json.Marshal(resp)
	if err != nil {
		s.log.Error("failed to marshal RPC response", "error", err)
		return
	}
	if err := s.writeStdin(data); err != nil {
		s.log.Error("failed to send RPC response", "id", id, "error", err)
	}
}

func (s *mcpSession) writeStdin(data []byte) error {
	s.stdinMu.Lock()
	defer s.stdinMu.Unlock()
	_, err := s.stdin.Write(append(data, '\n'))
	return err
}

// turnResult is the tools/call payload Codex returns when a turn ends.
//
// `structuredContent.threadId` is the only identifier current CLIs report here;
// older ones exposed the same value as sessionId/conversationId. `isError` is
// how a failed turn is reported: the JSON-RPC frame stays a success, so a turn
// that died on an API error, an unusable thread id or a runtime failure is
// indistinguishable from a completed one unless this field is read.
type turnResult struct {
	Content []struct {
		Text string `json:"text"`
	} `json:"content"`
	StructuredContent struct {
		ThreadID string `json:"threadId"`
		Content  string `json:"content"`
	} `json:"structuredContent"`
	IsError bool `json:"isError"`

	// Identifier fields of pre-threadId CLIs.
	SessionID      string `json:"sessionId"`
	ConversationID string `json:"conversationId"`

	// How CLIs before the MCP result shape was standardised reported a failed
	// turn: a bare {"error": "..."} object with no isError flag.
	LegacyError string `json:"error"`
}

// text returns the turn's closing message: the agent's last message on success,
// the failure description when isError is set.
func (r turnResult) text() string {
	if r.StructuredContent.Content != "" {
		return r.StructuredContent.Content
	}
	var parts []string
	for _, c := range r.Content {
		if c.Text != "" {
			parts = append(parts, c.Text)
		}
	}
	return strings.Join(parts, "\n")
}

// parseTurnResult converts the tools/call result into the event that ends the turn.
func (s *mcpSession) parseTurnResult(result json.RawMessage) agent.AgentEvent {
	if len(result) == 0 {
		return agent.DoneEvent{}
	}

	var parsed turnResult
	if err := json.Unmarshal(result, &parsed); err != nil {
		s.log.Warn("failed to parse codex tool call result", "error", err)
		return agent.DoneEvent{}
	}

	if parsed.IsError || parsed.LegacyError != "" {
		// A failed turn's thread id is not evidence that the thread exists:
		// Codex answers a reply to an unknown thread with "Session not found
		// for thread_id: X" and echoes X straight back in structuredContent
		// (verified against the CLI). Adopting it re-pins the dead id on every
		// attempt, so a session that ends up holding one never recovers.
		//
		// An id already held is deliberately left alone rather than cleared:
		// session_configured or a completed turn confirmed it, and a turn that
		// dies on an expired login or a budget cap still ran inside a
		// registered thread that codex-reply still works against (also
		// verified) — clearing it would drop the agent's context for nothing.
		return agent.ErrorEvent{Error: firstNonEmpty(
			parsed.text(),
			parsed.LegacyError,
			"codex reported an error without a message",
		)}
	}

	s.rememberThreadID(parsed.StructuredContent.ThreadID, parsed.ConversationID, parsed.SessionID)

	return agent.DoneEvent{}
}

const (
	abortReasonInterrupted   = "interrupted"
	abortReasonBudgetLimited = "budget_limited"
)

// abortEvent maps a Codex turn abort to the event that ends the turn.
//
// Everything except a budget cap is a stop somebody asked for (the user
// interrupting, a turn being replaced, a review ending), which is what
// InterruptedEvent means: work.AutoResumer stops the work item instead of
// continuing it. A budget cap is a failure the user has to be told about, so it
// surfaces as an error rather than a silent stop.
func abortEvent(reason string) agent.AgentEvent {
	if reason == abortReasonBudgetLimited {
		return agent.ErrorEvent{Error: "codex aborted the turn: budget limit reached"}
	}
	return agent.InterruptedEvent{}
}

// abortPendingTurn resolves the tools/call that the aborted turn belongs to.
// requestID comes from the event's _meta and is what keeps a late abort of a
// finished turn from ending the turn that is running now.
func (s *mcpSession) abortPendingTurn(requestID *int64, reason string) {
	if requestID == nil {
		s.log.Debug("ignoring turn_aborted without request id", "reason", reason)
		return
	}
	pending, ok := s.pendingRPCResults.Load(*requestID)
	if !ok {
		s.log.Debug("ignoring turn_aborted for a settled request", "requestId", *requestID, "reason", reason)
		return
	}
	ch := pending.(chan *rpcResponse)
	select {
	case ch <- &rpcResponse{abortReason: reason}:
	default:
	}
}

// rememberThreadID stores the first non-empty thread identifier, in preference
// order. Codex reports it under different names depending on its version.
//
// Only call it for a thread Codex has confirmed exists: a session_configured
// event (the server registered it) or a turn that completed on it. A failed
// turn is not a confirmation — Codex echoes back the very thread id it just
// rejected as unknown, so believing it pins a dead id in place for good.
func (s *mcpSession) rememberThreadID(candidates ...string) {
	for _, id := range candidates {
		if id == "" {
			continue
		}
		s.idMu.Lock()
		changed := s.threadID != id
		s.threadID = id
		s.idMu.Unlock()
		if changed {
			s.log.Debug("codex thread ID updated", "threadId", id)
		}
		return
	}
}

// rememberThreadIDFromEvent reads the thread identifier out of a
// session_configured event. Which field holds it depends on the CLI version:
// current ones send thread_id, older ones only session_id.
func (s *mcpSession) rememberThreadIDFromEvent(raw json.RawMessage) {
	var ev struct {
		ThreadID       string `json:"thread_id"`
		ConversationID string `json:"conversation_id"`
		SessionID      string `json:"session_id"`
	}
	if err := json.Unmarshal(raw, &ev); err != nil {
		return
	}
	s.rememberThreadID(ev.ThreadID, ev.ConversationID, ev.SessionID)
}

// --- Lifecycle helpers ---

// cleanupPendingElicitations resolves all pending elicitations by denying them
// and emitting RequestCancelledEvent for each. Called during interrupt and
// after process exit (as a safety net for in-flight permission dialogs).
func (s *mcpSession) cleanupPendingElicitations() {
	s.pendingElicit.Range(func(key, value any) bool {
		requestID := key.(string)
		ch := value.(chan elicitAnswer)
		select {
		case ch <- elicitAnswer{decision: "denied"}:
		default:
		}
		s.emitEvent(agent.RequestCancelledEvent{RequestID: requestID})
		return true
	})
}

// --- Resume ---

// warnSessionNotResumable tells the user that a restarted session starts over.
//
// Codex keeps threads in the memory of the mcp-server process that created
// them: codex-reply resolves a thread id against an in-memory map and answers
// "Session not found for thread_id" for anything else, verified against the
// real CLI. So a thread id carried across process restarts is not just useless,
// it makes every following message fail — the only way to keep the session
// usable is to start a new thread, and the only honest thing to do is say that
// the earlier turns are gone from the agent's memory (Pockode's own transcript
// keeps them).
func (s *mcpSession) warnSessionNotResumable() {
	s.log.Info("codex session restarted without its previous thread")
	s.emitEvent(agent.WarningEvent{
		Message: "Codex cannot continue a conversation across restarts, so it does not have the earlier messages of this session.",
		Code:    "session_not_resumable",
	})
}

// --- Codex message helpers ---

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

// joinOutput merges the two captured streams for CLIs that report them
// separately instead of as one aggregated stream.
func joinOutput(stdout, stderr string) string {
	if stdout != "" && stderr != "" {
		return stdout + "\n" + stderr
	}
	return firstNonEmpty(stdout, stderr)
}

// normalizeCommand converts a Codex command field (string or array) to a plain string.
// Codex emits command as either a JSON string or a JSON array of strings.
func normalizeCommand(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return s
	}
	var arr []string
	if err := json.Unmarshal(raw, &arr); err == nil {
		return strings.Join(arr, " ")
	}
	return ""
}

// buildEditInput builds the ToolInput JSON for an Edit permission/tool-call event.
// Used by both patch_apply_begin notifications and patch_apply elicitations.
func buildEditInput(changes json.RawMessage) json.RawMessage {
	inputMap := map[string]interface{}{
		"changes": changes,
	}
	if fp := extractFilePath(changes); fp != "" {
		inputMap["file_path"] = fp
	}
	data, _ := json.Marshal(inputMap)
	return data
}

// extractFilePath extracts the file path from a Codex patch changes object.
// Returns the single file path when exactly one file is changed, empty otherwise.
func extractFilePath(changes json.RawMessage) string {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(changes, &m); err != nil {
		return ""
	}
	if len(m) == 1 {
		for k := range m {
			return k
		}
	}
	return ""
}

// --- Version detection ---

// getMCPSubcommand determines the correct MCP subcommand based on codex version.
// Versions >= 0.43.0-alpha.5 use "mcp-server", older versions use "mcp".
func getMCPSubcommand(ctx context.Context) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, versionProbeTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, Binary, "--version")
	// The context kills the process, but Wait still blocks until the stdout pipe
	// closes — a grandchild holding it open would restore the unbounded wait this
	// timeout exists to prevent. WaitDelay caps that tail.
	cmd.WaitDelay = time.Second

	out, err := cmd.Output()
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return "", fmt.Errorf("codex --version did not finish within %s", versionProbeTimeout)
		}
		return "", fmt.Errorf("codex CLI not found: %w", err)
	}

	version := strings.TrimSpace(string(out))
	return parseMCPSubcommand(version), nil
}

// parseMCPSubcommand extracts the subcommand from the version string.
// Exported for testing.
func parseMCPSubcommand(version string) string {
	// Expected format: "codex-cli X.Y.Z" or "codex-cli X.Y.Z-alpha.N"
	parts := strings.Fields(version)
	if len(parts) < 2 {
		return "mcp"
	}

	versionStr := parts[len(parts)-1]
	segments := strings.SplitN(versionStr, ".", 3)
	if len(segments) < 3 {
		return "mcp"
	}

	major, err1 := strconv.Atoi(segments[0])
	minor, err2 := strconv.Atoi(segments[1])
	if err1 != nil || err2 != nil {
		return "mcp"
	}

	if major > 0 || minor > 43 {
		return "mcp-server"
	}

	if minor == 43 {
		// Parse patch: "0-alpha.5" or "0"
		patchStr := segments[2]
		patchParts := strings.SplitN(patchStr, "-", 2)
		patch, err := strconv.Atoi(patchParts[0])
		if err != nil {
			return "mcp"
		}
		if patch > 0 {
			return "mcp-server"
		}
		// patch == 0: check alpha version
		if len(patchParts) > 1 && strings.HasPrefix(patchParts[1], "alpha.") {
			alphaStr := strings.TrimPrefix(patchParts[1], "alpha.")
			alphaNum, err := strconv.Atoi(alphaStr)
			if err != nil {
				return "mcp"
			}
			if alphaNum >= 5 {
				return "mcp-server"
			}
			return "mcp"
		}
		// 0.43.0 stable
		return "mcp-server"
	}

	return "mcp"
}
