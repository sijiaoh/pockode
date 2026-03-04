// Package codex implements Agent interface using Codex CLI via MCP over STDIO.
package codex

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/logger"
	"github.com/pockode/server/session"
)

const Binary = "codex"

// Agent implements agent.Agent using Codex CLI via MCP.
type Agent struct{}

// New creates a new Codex Agent.
func New() *Agent {
	return &Agent{}
}

// Start launches a persistent Codex MCP server process.
func (a *Agent) Start(ctx context.Context, opts agent.StartOptions) (agent.Session, error) {
	procCtx, cancel := context.WithCancel(ctx)

	mcpSubcommand, err := getMCPSubcommand()
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
		agent.WaitForProcess(procCtx, log, cmd, stderrCh, events)

		select {
		case events <- agent.ProcessEndedEvent{}:
		case <-procCtx.Done():
		}
	}()

	// Initialize the MCP connection before returning.
	if err := sess.initialize(procCtx); err != nil {
		sess.Close()
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
	interrupted       atomic.Bool

	idMu           sync.Mutex // protects sessionID and conversationID
	sessionID      string
	conversationID string

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
	sid := s.sessionID
	cid := s.conversationID
	s.idMu.Unlock()

	if sid == "" {
		// First message: start a new session.
		return s.callToolAsync("codex", s.buildStartConfig(prompt))
	}

	// Subsequent messages: continue the session.
	return s.callToolAsync("codex-reply", map[string]interface{}{
		"sessionId":      sid,
		"conversationId": cid,
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
	s.interrupted.Store(true)

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

		// Unblock the callToolAsync goroutine by sending a synthetic response.
		// Codex may not return the RPC response upon cancellation.
		ch := value.(chan *rpcResponse)
		select {
		case ch <- &rpcResponse{Error: &rpcError{Code: -32800, Message: "cancelled"}}:
		default:
		}
		return true
	})

	// Resolve any pending elicitation requests.
	s.pendingElicit.Range(func(key, value any) bool {
		ch := value.(chan elicitAnswer)
		select {
		case ch <- elicitAnswer{decision: "denied"}:
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
		if s.interrupted.CompareAndSwap(true, false) {
			s.emitEvent(agent.InterruptedEvent{})
			return
		}
		if resp.Error != nil {
			s.emitEvent(agent.ErrorEvent{Error: fmt.Sprintf("codex tool call failed: %s", resp.Error.Message)})
			return
		}
		// Extract session/conversation IDs from response.
		s.extractIdentifiers(resp.Result)
		s.emitEvent(agent.DoneEvent{})
	}()

	return nil
}

// buildStartConfig builds the Codex session start configuration.
func (s *mcpSession) buildStartConfig(prompt string) map[string]interface{} {
	config := map[string]interface{}{
		"prompt": prompt,
		"cwd":    s.opts.WorkDir,
		"config": map[string]interface{}{
			"mcp_servers": map[string]interface{}{
				"pockode": map[string]interface{}{
					"command": s.exe,
					"args":    []string{"mcp", "--data-dir", s.opts.DataDir},
				},
			},
		},
	}

	switch s.opts.Mode {
	case session.ModeYolo:
		config["approval-policy"] = "never"
		config["sandbox"] = "danger-full-access"
	default:
		config["approval-policy"] = "untrusted"
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
// Wire format: {"jsonrpc":"2.0","method":"codex/event","params":{"msg":{...}}}
func (s *mcpSession) handleCodexEventDirect(params json.RawMessage) {
	var notif struct {
		Msg json.RawMessage `json:"msg"`
	}
	if err := json.Unmarshal(params, &notif); err != nil {
		s.log.Warn("failed to parse codex/event params", "error", err)
		return
	}
	s.processCodexMsg(notif.Msg)
}

// handleCodexEventLogging handles the standard MCP notifications/message.
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
	s.processCodexMsg(notif.Data.Msg)
}

// processCodexMsg processes a single Codex event message.
func (s *mcpSession) processCodexMsg(raw json.RawMessage) {
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

	s.updateIdentifiersFromEvent(raw)

	switch codexMsg.Type {
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

	case "exec_command_begin", "exec_approval_request":
		var ev struct {
			CallID  string          `json:"call_id"`
			Command json.RawMessage `json:"command"`
			Cwd     string          `json:"cwd"`
		}
		if err := json.Unmarshal(raw, &ev); err != nil {
			s.log.Warn("failed to parse exec event", "error", err)
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
			Output string `json:"output"`
			Error  string `json:"error"`
		}
		if err := json.Unmarshal(raw, &ev); err != nil {
			s.log.Warn("failed to parse exec_command_end", "error", err)
			return
		}
		result := ev.Output
		if result == "" {
			result = ev.Error
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
		inputMap := map[string]interface{}{
			"changes": ev.Changes,
		}
		if fp := extractFilePath(ev.Changes); fp != "" {
			inputMap["file_path"] = fp
		}
		input, _ := json.Marshal(inputMap)
		s.emitEvent(agent.ToolCallEvent{
			ToolUseID: ev.CallID,
			ToolName:  "Edit",
			ToolInput: input,
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

	case "task_complete":
		// Informational; the actual DoneEvent is sent when the RPC result arrives.

	case "turn_aborted":
		// Mark as interrupted so the callToolAsync goroutine emits InterruptedEvent
		// instead of DoneEvent when the RPC response arrives.
		s.interrupted.Store(true)

	default:
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
		CodexMCPToolCallID string          `json:"codex_mcp_tool_call_id"`
		CodexEventID       string          `json:"codex_event_id"`
	}
	if err := json.Unmarshal(msg.Params, &params); err != nil {
		s.log.Warn("failed to parse elicitation params", "error", err)
		s.sendRPCResponse(*msg.ID, map[string]interface{}{"action": "deny"}, nil)
		return
	}

	requestID := params.CodexCallID
	if requestID == "" {
		requestID = fmt.Sprintf("elicit-%d", *msg.ID)
	}

	// Build tool input for the permission request event.
	command := normalizeCommand(params.CodexCommand)
	inputMap := map[string]interface{}{
		"command": command,
		"cwd":     params.CodexCwd,
	}
	toolInput, _ := json.Marshal(inputMap)

	ch := make(chan elicitAnswer, 1)
	s.pendingElicit.Store(requestID, ch)

	// Emit permission request event.
	s.emitEvent(agent.PermissionRequestEvent{
		RequestID: requestID,
		ToolName:  "Bash",
		ToolInput: toolInput,
		ToolUseID: params.CodexMCPToolCallID,
	})

	// Wait for user response.
	var answer elicitAnswer
	select {
	case answer = <-ch:
	case <-ctx.Done():
		answer = elicitAnswer{decision: "denied"}
	}

	s.pendingElicit.Delete(requestID)

	// Map our decision to MCP elicitation response.
	action := "deny"
	if answer.decision == "approved" || answer.decision == "approved_for_session" {
		action = "accept"
	}

	s.sendRPCResponse(*msg.ID, map[string]interface{}{
		"action":   action,
		"decision": answer.decision,
	}, nil)
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

func (s *mcpSession) extractIdentifiers(result json.RawMessage) {
	if len(result) == 0 {
		return
	}
	var data struct {
		Meta struct {
			SessionID      string `json:"sessionId"`
			ConversationID string `json:"conversationId"`
		} `json:"meta"`
		SessionID      string `json:"sessionId"`
		ConversationID string `json:"conversationId"`
		Content        []struct {
			SessionID      string `json:"sessionId"`
			ConversationID string `json:"conversationId"`
		} `json:"content"`
	}
	if err := json.Unmarshal(result, &data); err != nil {
		return
	}

	s.idMu.Lock()
	defer s.idMu.Unlock()

	if id := firstNonEmpty(data.Meta.SessionID, data.SessionID); id != "" {
		s.sessionID = id
		s.log.Debug("session ID extracted", "sessionId", id)
	}
	if id := firstNonEmpty(data.Meta.ConversationID, data.ConversationID); id != "" {
		s.conversationID = id
		s.log.Debug("conversation ID extracted", "conversationId", id)
	}
	for _, item := range data.Content {
		if s.sessionID == "" && item.SessionID != "" {
			s.sessionID = item.SessionID
		}
		if s.conversationID == "" && item.ConversationID != "" {
			s.conversationID = item.ConversationID
		}
	}
	if s.conversationID == "" && s.sessionID != "" {
		s.conversationID = s.sessionID
	}
}

func (s *mcpSession) updateIdentifiersFromEvent(raw json.RawMessage) {
	var ev struct {
		SessionID      string `json:"session_id"`
		ConversationID string `json:"conversation_id"`
		Data           struct {
			SessionID      string `json:"session_id"`
			ConversationID string `json:"conversation_id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &ev); err != nil {
		return
	}

	s.idMu.Lock()
	defer s.idMu.Unlock()

	if id := firstNonEmpty(ev.SessionID, ev.Data.SessionID); id != "" {
		s.sessionID = id
	}
	if id := firstNonEmpty(ev.ConversationID, ev.Data.ConversationID); id != "" {
		s.conversationID = id
	}
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

// --- Codex message helpers ---

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
func getMCPSubcommand() (string, error) {
	out, err := exec.Command(Binary, "--version").Output()
	if err != nil {
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
