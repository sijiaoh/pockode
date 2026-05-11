// Package claude implements Agent interface using Claude CLI.
package claude

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/logger"
	"github.com/pockode/server/session"
)

// Binary is the Claude CLI executable name.
const Binary = "claude"

const resumeStateFile = "claude_resume.json"

// Agent implements agent.Agent using Claude CLI.
type Agent struct{}

// New creates a new Claude Agent.
func New() *Agent {
	return &Agent{}
}

// ensureMCPConfig writes the MCP config file and returns its path.
// The config points to the current binary with the "mcp" subcommand.
func ensureMCPConfig(dataDir string) (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("resolve executable path: %w", err)
	}

	config := map[string]interface{}{
		"mcpServers": map[string]interface{}{
			"pockode": map[string]interface{}{
				"command": exe,
				"args":    []string{"mcp", "--data-dir", dataDir},
			},
		},
	}

	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return "", err
	}

	configPath := filepath.Join(dataDir, "mcp-config.json")
	if err := os.WriteFile(configPath, data, 0644); err != nil {
		return "", err
	}

	return configPath, nil
}

// Start launches a persistent Claude CLI process.
func (a *Agent) Start(ctx context.Context, opts agent.StartOptions) (agent.Session, error) {
	procCtx, cancel := context.WithCancel(ctx)

	claudeArgs := []string{
		"--output-format", "stream-json",
		"--input-format", "stream-json",
		"--verbose",
	}

	// Always use permission-prompt-tool so we receive control_request events
	// (including AskUserQuestion) regardless of mode.
	claudeArgs = append(claudeArgs, "--permission-prompt-tool", "stdio")
	if opts.Mode == session.ModeYolo {
		claudeArgs = append(claudeArgs, "--permission-mode", "bypassPermissions")
	}

	resumeState := newClaudeResumeStateManager(opts, slog.With("sessionId", opts.SessionID))
	providerSessionID, shouldResume := resumeState.resolve()
	if providerSessionID != "" {
		if shouldResume {
			claudeArgs = append(claudeArgs, "--resume", providerSessionID)
		} else {
			claudeArgs = append(claudeArgs, "--session-id", providerSessionID)
		}
	}

	// Add MCP config for work management tools
	mcpConfigPath, err := ensureMCPConfig(opts.DataDir)
	if err != nil {
		cancel()
		return nil, fmt.Errorf("failed to create MCP config: %w", err)
	}
	claudeArgs = append(claudeArgs, "--mcp-config", mcpConfigPath)

	cmd := exec.CommandContext(procCtx, Binary, claudeArgs...)
	cmd.Dir = opts.WorkDir

	// stdin ownership is transferred to session; closed by session.Close()
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
		return nil, fmt.Errorf("failed to start claude: %w", err)
	}

	log := slog.With("sessionId", opts.SessionID)
	log.Info("claude process started", "pid", cmd.Process.Pid, "mode", opts.Mode)

	events := make(chan agent.AgentEvent)
	pendingRequests := &sync.Map{}

	sess := &cliSession{
		log:             log,
		events:          events,
		stdin:           stdin,
		pendingRequests: pendingRequests,
		cancel:          cancel,
	}

	// Stream events from the process.
	// Note: When procCtx is cancelled (via sess.Close), CommandContext sends SIGKILL,
	// which terminates the process and closes stdout, causing streamOutput to exit.
	go func() {
		defer func() {
			if r := recover(); r != nil {
				logger.LogPanic(r, "claude process crashed", "sessionId", opts.SessionID)
			}
		}()
		defer close(events)
		defer cancel()
		defer stdout.Close()
		defer stderr.Close()

		stderrCh := agent.ReadStderr(stderr, "claude")
		streamOutput(procCtx, log, stdout, events, pendingRequests, resumeState)
		agent.WaitForProcess(procCtx, log, cmd, stderrCh, events)

		// Notify client that process has ended (abnormal: process should stay alive)
		select {
		case events <- agent.ProcessEndedEvent{}:
		case <-procCtx.Done():
		}
	}()

	return sess, nil
}

// session implements agent.Session for Claude CLI.
type cliSession struct {
	log             *slog.Logger
	events          chan agent.AgentEvent
	stdin           io.WriteCloser
	stdinMu         sync.Mutex
	pendingRequests *sync.Map // tracks sent control requests by requestID for response matching
	cancel          func()
	closeOnce       sync.Once
}

// Events returns the event channel.
func (s *cliSession) Events() <-chan agent.AgentEvent {
	return s.events
}

// SendMessage sends a message to Claude.
func (s *cliSession) SendMessage(prompt string) error {
	msg := userMessage{
		Type: "user",
		Message: userContent{
			Role:    "user",
			Content: []textContent{{Type: "text", Text: prompt}},
		},
	}
	data, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("failed to marshal message: %w", err)
	}
	s.log.Debug("sending prompt", "length", len(prompt))
	return s.writeStdin(data)
}

// SendPermissionResponse sends a permission response to Claude.
func (s *cliSession) SendPermissionResponse(data agent.PermissionRequestData, choice agent.PermissionChoice) error {
	var content controlResponseContent

	switch choice {
	case agent.PermissionAllow, agent.PermissionAlwaysAllow:
		content = controlResponseContent{
			Behavior:     "allow",
			ToolUseID:    data.ToolUseID,
			UpdatedInput: data.ToolInput,
		}
		if choice == agent.PermissionAlwaysAllow && len(data.PermissionSuggestions) > 0 {
			content.UpdatedPermissions = data.PermissionSuggestions
		}
	default:
		content = controlResponseContent{
			Behavior:  "deny",
			Message:   "User denied permission",
			Interrupt: true,
			ToolUseID: data.ToolUseID,
		}
	}

	return s.sendControlResponse(data.RequestID, content)
}

// SendQuestionResponse sends answers to user questions.
// If answers is nil, sends a cancel (deny) response.
func (s *cliSession) SendQuestionResponse(data agent.QuestionRequestData, answers map[string]string) error {
	var content controlResponseContent

	if answers == nil {
		content = controlResponseContent{
			Behavior:  "deny",
			Message:   "User cancelled the question",
			Interrupt: true,
			ToolUseID: data.ToolUseID,
		}
	} else {
		updatedInput, err := json.Marshal(questionAnswerInput{Answers: answers})
		if err != nil {
			return fmt.Errorf("failed to marshal updated input: %w", err)
		}
		content = controlResponseContent{
			Behavior:     "allow",
			ToolUseID:    data.ToolUseID,
			UpdatedInput: updatedInput,
		}
	}

	return s.sendControlResponse(data.RequestID, content)
}

func (s *cliSession) sendControlResponse(requestID string, content controlResponseContent) error {
	response := controlResponse{
		Type: "control_response",
		Response: controlResponsePayload{
			Subtype:   "success",
			RequestID: requestID,
			Response:  content,
		},
	}

	data, err := json.Marshal(response)
	if err != nil {
		return fmt.Errorf("failed to marshal control response: %w", err)
	}

	s.log.Debug("sending control response")
	return s.writeStdin(data)
}

// interruptMarker is stored in pendingRequests to identify interrupt responses.
// Needed because control_response only contains request_id, not the request type.
type interruptMarker struct{}

// SendInterrupt sends an interrupt signal to stop the current task.
func (s *cliSession) SendInterrupt() error {
	requestID := generateRequestID()
	request := interruptRequest{
		Type:      "control_request",
		RequestID: requestID,
		Request: interruptRequestData{
			Subtype: "interrupt",
		},
	}

	data, err := json.Marshal(request)
	if err != nil {
		return fmt.Errorf("failed to marshal interrupt request: %w", err)
	}

	// Store marker so parseControlResponse can identify interrupt responses.
	s.pendingRequests.Store(requestID, interruptMarker{})

	s.log.Info("sending interrupt signal")
	if err := s.writeStdin(data); err != nil {
		s.pendingRequests.Delete(requestID)
		return err
	}
	return nil
}

func generateRequestID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		// crypto/rand.Read failure is extremely rare (only on entropy exhaustion).
		// Log and continue with zero bytes rather than failing the interrupt.
		slog.Error("rand.Read failed", "error", err)
	}
	return hex.EncodeToString(b)
}

// Close terminates the Claude process. Safe to call multiple times.
func (s *cliSession) Close() {
	s.closeOnce.Do(func() {
		s.log.Info("terminating claude process")
		s.cancel()
		s.stdinMu.Lock()
		s.stdin.Close()
		s.stdinMu.Unlock()
	})
}

// writeStdin writes data to stdin with mutex protection.
func (s *cliSession) writeStdin(data []byte) error {
	s.stdinMu.Lock()
	defer s.stdinMu.Unlock()
	_, err := s.stdin.Write(append(data, '\n'))
	return err
}

func streamOutput(ctx context.Context, log *slog.Logger, stdout io.Reader, events chan<- agent.AgentEvent, pendingRequests *sync.Map, resumeState *claudeResumeStateManager) {
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}

		if resumeState != nil {
			resumeState.observeLine(line)
		}

		for _, event := range parseLine(log, line, pendingRequests) {
			select {
			case events <- event:
			case <-ctx.Done():
				return
			}
		}
	}

	if err := scanner.Err(); err != nil {
		log.Error("stdout scanner error", "error", err)
		msg := "Some output could not be read"
		code := "scanner_error"
		if errors.Is(err, bufio.ErrTooLong) {
			msg = "Some output was too large to display"
			code = "scanner_buffer_overflow"
		}
		select {
		case events <- agent.WarningEvent{
			Message: msg,
			Code:    code,
		}:
		case <-ctx.Done():
		}
	}
}

// --- Resume state ---

type claudeResumeState struct {
	SessionID string `json:"sessionId"`
}

type claudeResumeStateManager struct {
	opts agent.StartOptions
	log  *slog.Logger

	sessionID atomic.Value // string
	saved     atomic.Bool
}

func newClaudeResumeStateManager(opts agent.StartOptions, log *slog.Logger) *claudeResumeStateManager {
	m := &claudeResumeStateManager{opts: opts, log: log}
	if opts.SessionID != "" {
		m.sessionID.Store(opts.SessionID)
	}
	return m
}

func (m *claudeResumeStateManager) path() string {
	return filepath.Join(m.opts.DataDir, "sessions", m.opts.SessionID, resumeStateFile)
}

func (m *claudeResumeStateManager) resolve() (providerSessionID string, resume bool) {
	if m.opts.SessionID == "" {
		return "", false
	}
	if !m.opts.Resume {
		return m.opts.SessionID, false
	}

	state, ok := m.load()
	if ok && state.SessionID != "" {
		m.sessionID.Store(state.SessionID)
		m.log.Info("resuming claude session", "claudeSessionId", state.SessionID)
		return state.SessionID, true
	}

	if m.hasAssistantHistory() {
		m.sessionID.Store(m.opts.SessionID)
		m.save(m.opts.SessionID)
		m.log.Info("migrated legacy claude session", "claudeSessionId", m.opts.SessionID)
		return m.opts.SessionID, true
	}

	m.log.Info("starting new claude session because resume state is missing")
	return m.opts.SessionID, false
}

func (m *claudeResumeStateManager) load() (claudeResumeState, bool) {
	data, err := os.ReadFile(m.path())
	if err != nil {
		return claudeResumeState{}, false
	}
	var state claudeResumeState
	if err := json.Unmarshal(data, &state); err != nil {
		m.log.Warn("failed to parse claude resume state", "error", err)
		return claudeResumeState{}, false
	}
	return state, true
}

func (m *claudeResumeStateManager) save(sessionID string) {
	if sessionID == "" {
		return
	}
	data, err := json.Marshal(claudeResumeState{SessionID: sessionID})
	if err != nil {
		m.log.Error("failed to marshal claude resume state", "error", err)
		return
	}
	path := m.path()
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		m.log.Error("failed to create claude resume state directory", "error", err)
		return
	}
	if err := os.WriteFile(path, data, 0644); err != nil {
		m.log.Error("failed to write claude resume state", "error", err)
	}
}

func (m *claudeResumeStateManager) observeLine(line []byte) {
	var event cliEvent
	if err := json.Unmarshal(line, &event); err != nil {
		return
	}
	if event.SessionID != "" {
		m.sessionID.Store(event.SessionID)
	}
	if event.Type != "assistant" || m.saved.Load() {
		return
	}
	sessionID, _ := m.sessionID.Load().(string)
	if sessionID == "" {
		return
	}
	m.save(sessionID)
	m.saved.Store(true)
}

func (m *claudeResumeStateManager) hasAssistantHistory() bool {
	path := filepath.Join(m.opts.DataDir, "sessions", m.opts.SessionID, "history.jsonl")
	file, err := os.Open(path)
	if err != nil {
		return false
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)
	for scanner.Scan() {
		var record struct {
			Type agent.EventType `json:"type"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &record); err != nil {
			continue
		}
		switch record.Type {
		case agent.EventTypeText, agent.EventTypeToolCall, agent.EventTypeToolResult,
			agent.EventTypeDone, agent.EventTypeInterrupted, agent.EventTypePermissionRequest,
			agent.EventTypeAskUserQuestion:
			return true
		}
	}
	if err := scanner.Err(); err != nil {
		m.log.Warn("failed to scan claude history for legacy migration", "error", err)
	}
	return false
}

// --- Types ---

type userMessage struct {
	Type    string      `json:"type"`
	Message userContent `json:"message"`
}

type userContent struct {
	Role    string        `json:"role"`
	Content []textContent `json:"content"`
}

type textContent struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type controlRequest struct {
	RequestID string          `json:"request_id"`
	Request   *controlPayload `json:"request"`
}

type controlPayload struct {
	Subtype               string                   `json:"subtype"`
	ToolName              string                   `json:"tool_name,omitempty"`
	Input                 json.RawMessage          `json:"input,omitempty"`
	ToolUseID             string                   `json:"tool_use_id,omitempty"`
	PermissionSuggestions []agent.PermissionUpdate `json:"permission_suggestions,omitempty"`
}

type controlResponse struct {
	Type     string                 `json:"type"`
	Response controlResponsePayload `json:"response"`
}

type controlResponsePayload struct {
	Subtype   string                 `json:"subtype"`
	RequestID string                 `json:"request_id"`
	Response  controlResponseContent `json:"response"`
}

type controlResponseContent struct {
	// Permission/Question response fields
	Behavior           string                   `json:"behavior,omitempty"`
	Message            string                   `json:"message,omitempty"`
	Interrupt          bool                     `json:"interrupt,omitempty"`
	ToolUseID          string                   `json:"toolUseID,omitempty"`
	UpdatedInput       json.RawMessage          `json:"updatedInput,omitempty"`
	UpdatedPermissions []agent.PermissionUpdate `json:"updatedPermissions,omitempty"`
}

type interruptRequest struct {
	Type      string               `json:"type"`
	RequestID string               `json:"request_id"`
	Request   interruptRequestData `json:"request"`
}

type interruptRequestData struct {
	Subtype string `json:"subtype"`
}

// questionAnswerInput is the UpdatedInput format for question responses.
type questionAnswerInput struct {
	Answers map[string]string `json:"answers"`
}

// --- Parsing ---

type cliEvent struct {
	Type      string          `json:"type"`
	Subtype   string          `json:"subtype,omitempty"`
	Message   json.RawMessage `json:"message,omitempty"`
	SessionID string          `json:"session_id,omitempty"`
}

type cliMessage struct {
	Content []cliContentBlock `json:"content"`
}

// cliMessageString is for user messages where content is a plain string instead of array.
type cliMessageString struct {
	Content string `json:"content"`
}

type cliContentBlock struct {
	Type      string          `json:"type"`
	Text      string          `json:"text,omitempty"`
	ID        string          `json:"id,omitempty"`
	Name      string          `json:"name,omitempty"`
	Input     json.RawMessage `json:"input,omitempty"`
	ToolUseID string          `json:"tool_use_id,omitempty"`
	Content   json.RawMessage `json:"content,omitempty"`
}

func parseLine(log *slog.Logger, line []byte, pendingRequests *sync.Map) []agent.AgentEvent {
	if len(line) == 0 {
		return nil
	}

	var event cliEvent
	if err := json.Unmarshal(line, &event); err != nil {
		log.Warn("failed to parse JSON from CLI", "error", err, "lineLength", len(line))
		return []agent.AgentEvent{agent.TextEvent{Content: string(line)}}
	}

	switch event.Type {
	case "assistant":
		return parseAssistantEvent(log, event)
	case "user":
		return parseUserEvent(log, event)
	case "result":
		return []agent.AgentEvent{parseResultEvent(line)}
	case "system":
		// Skip init event (noise at session start)
		if event.Subtype == "init" {
			return nil
		}
		return []agent.AgentEvent{agent.SystemEvent{Content: string(line)}}
	case "control_request":
		return parseControlRequest(log, line)
	case "control_response":
		return parseControlResponse(log, line, pendingRequests)
	case "control_cancel_request":
		return parseControlCancelRequest(log, line)
	case "progress":
		// Undocumented event (e.g., bash_progress) not in official SDK docs.
		// Other CLI wrappers also ignore it.
		return nil
	default:
		log.Debug("unhandled event type from CLI", "type", event.Type)
		return nil
	}
}

func parseControlRequest(log *slog.Logger, line []byte) []agent.AgentEvent {
	var req controlRequest
	if err := json.Unmarshal(line, &req); err != nil {
		log.Warn("failed to parse control request from CLI", "error", err)
		return nil
	}

	if req.Request == nil {
		log.Debug("ignoring request with nil request data")
		return nil
	}

	switch req.Request.Subtype {
	case "can_use_tool":
		// AskUserQuestion is sent as can_use_tool with tool_name="AskUserQuestion"
		if req.Request.ToolName == "AskUserQuestion" {
			var input struct {
				Questions []agent.AskUserQuestion `json:"questions"`
			}
			if err := json.Unmarshal(req.Request.Input, &input); err != nil {
				log.Warn("failed to parse AskUserQuestion input from CLI", "error", err)
				return nil
			}

			log.Info("AskUserQuestion received", "requestId", req.RequestID)
			return []agent.AgentEvent{agent.AskUserQuestionEvent{
				RequestID: req.RequestID,
				ToolUseID: req.Request.ToolUseID,
				Questions: input.Questions,
			}}
		}

		log.Info("tool permission request", "tool", req.Request.ToolName, "requestId", req.RequestID)
		return []agent.AgentEvent{agent.PermissionRequestEvent{
			RequestID:             req.RequestID,
			ToolName:              req.Request.ToolName,
			ToolInput:             req.Request.Input,
			ToolUseID:             req.Request.ToolUseID,
			PermissionSuggestions: req.Request.PermissionSuggestions,
		}}

	default:
		log.Debug("ignoring unknown subtype", "subtype", req.Request.Subtype)
		return nil
	}
}

// cliControlResponse represents a control_response from Claude CLI.
type cliControlResponse struct {
	Type     string `json:"type"`
	Response struct {
		Subtype   string `json:"subtype"`
		RequestID string `json:"request_id"`
	} `json:"response"`
}

func parseControlResponse(log *slog.Logger, line []byte, pendingRequests *sync.Map) []agent.AgentEvent {
	var resp cliControlResponse
	if err := json.Unmarshal(line, &resp); err != nil {
		log.Warn("failed to parse control response from CLI", "error", err)
		return nil
	}

	// Check if this response is for an interrupt request we sent.
	requestID := resp.Response.RequestID
	if pending, ok := pendingRequests.LoadAndDelete(requestID); ok {
		if _, isInterrupt := pending.(interruptMarker); isInterrupt {
			log.Info("interrupt acknowledged", "requestId", requestID)
			return []agent.AgentEvent{agent.InterruptedEvent{}}
		}
	}

	// Other control responses (permission, question) don't need client notification.
	return nil
}

// controlCancelRequest represents a control_cancel_request from Claude CLI.
type controlCancelRequest struct {
	Type      string `json:"type"`
	RequestID string `json:"request_id"`
}

func parseControlCancelRequest(log *slog.Logger, line []byte) []agent.AgentEvent {
	var req controlCancelRequest
	if err := json.Unmarshal(line, &req); err != nil {
		log.Warn("failed to parse control cancel request from CLI", "error", err)
		return nil
	}

	log.Debug("control cancel request received", "requestId", req.RequestID)
	return []agent.AgentEvent{agent.RequestCancelledEvent{RequestID: req.RequestID}}
}

func parseAssistantEvent(log *slog.Logger, event cliEvent) []agent.AgentEvent {
	if event.Message == nil {
		log.Warn("assistant event message is nil", "subtype", event.Subtype)
		return nil
	}

	var msg cliMessage
	if err := json.Unmarshal(event.Message, &msg); err != nil {
		log.Warn("failed to parse assistant message from CLI", "error", err)
		return []agent.AgentEvent{agent.TextEvent{Content: string(event.Message)}}
	}

	var events []agent.AgentEvent
	var textParts []string

	// TODO: Handle thinking/redacted_thinking blocks and other missing fields.
	for _, block := range msg.Content {
		switch block.Type {
		case "text":
			if block.Text != "" {
				textParts = append(textParts, block.Text)
			}
		case "tool_use", "server_tool_use":
			if len(textParts) > 0 {
				events = append(events, agent.TextEvent{Content: strings.Join(textParts, "")})
				textParts = nil
			}
			events = append(events, agent.ToolCallEvent{
				ToolUseID: block.ID,
				ToolName:  block.Name,
				ToolInput: block.Input,
			})
		}
	}

	if len(textParts) > 0 {
		events = append(events, agent.TextEvent{Content: strings.Join(textParts, "")})
	}

	return events
}

func parseUserEvent(log *slog.Logger, event cliEvent) []agent.AgentEvent {
	if event.Message == nil {
		return nil
	}

	// Try to parse as cliMessage (content is array of blocks)
	var msg cliMessage
	if err := json.Unmarshal(event.Message, &msg); err != nil {
		// content might be a plain string - try parsing as cliMessageString
		var msgStr cliMessageString
		if err := json.Unmarshal(event.Message, &msgStr); err != nil {
			// Unknown format - output raw for visibility
			return []agent.AgentEvent{agent.TextEvent{Content: string(event.Message)}}
		}
		return extractEventsFromText(log, msgStr.Content)
	}

	var events []agent.AgentEvent
	for _, block := range msg.Content {
		switch block.Type {
		case "tool_result":
			// Check if content contains image (array with type:"image" elements).
			// TODO: Support image display. Also note current HTTP relay has 10MB limit,
			// which may need adjustment for large images.
			if hasImageContent(block.Content) {
				events = append(events, agent.WarningEvent{
					Message: "Image content is not supported yet",
					Code:    "image_not_supported",
				})
				continue
			}

			// Content is JSON: either a string ("...") or array/object.
			// Unmarshal extracts the string value; for non-strings, use raw JSON.
			var content string
			if err := json.Unmarshal(block.Content, &content); err != nil {
				content = string(block.Content)
			}
			events = append(events, agent.ToolResultEvent{
				ToolUseID:  block.ToolUseID,
				ToolResult: content,
			})

		default:
			// Unknown block type - log for debugging but don't output to UI
			if data, err := json.Marshal(block); err == nil {
				log.Debug("unknown user message block type", "block", string(data))
			}
		}
	}

	return events
}

// extractEventsFromText extracts agent events from text, handling special tags.
// Content inside command output tags becomes CommandOutputEvent.
// Text outside tags is logged but not emitted as events.
func extractEventsFromText(log *slog.Logger, text string) []agent.AgentEvent {
	commandOutputTags := []struct{ open, close string }{
		{"<local-command-stdout>", "</local-command-stdout>"},
		{"<local-command-stderr>", "</local-command-stderr>"},
	}

	logIgnored := func(content string) {
		if trimmed := strings.TrimSpace(content); trimmed != "" {
			log.Debug("text outside command tags ignored", "content", trimmed)
		}
	}

	var events []agent.AgentEvent
	remaining := text

	for len(remaining) > 0 {
		bestIdx := -1
		var bestTag struct{ open, close string }
		for _, tag := range commandOutputTags {
			idx := strings.Index(remaining, tag.open)
			if idx != -1 && (bestIdx == -1 || idx < bestIdx) {
				bestIdx = idx
				bestTag = tag
			}
		}

		if bestIdx == -1 {
			break
		}

		logIgnored(remaining[:bestIdx])

		endIdx := strings.Index(remaining[bestIdx:], bestTag.close)
		if endIdx == -1 {
			logIgnored(remaining[bestIdx:])
			return events
		}
		endIdx += bestIdx

		contentStart := bestIdx + len(bestTag.open)
		content := strings.TrimSpace(remaining[contentStart:endIdx])
		if content != "" {
			events = append(events, agent.CommandOutputEvent{Content: content})
		}

		remaining = remaining[endIdx+len(bestTag.close):]
	}

	logIgnored(remaining)

	return events
}

// hasImageContent checks if JSON content contains image type elements.
// Returns true if content is an array containing any element with type:"image".
func hasImageContent(content json.RawMessage) bool {
	if len(content) == 0 || content[0] != '[' {
		return false
	}

	var items []struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(content, &items); err != nil {
		return false
	}

	for _, item := range items {
		if item.Type == "image" {
			return true
		}
	}
	return false
}

type resultEvent struct {
	Subtype   string   `json:"subtype"`
	SessionID string   `json:"session_id"`
	Errors    []string `json:"errors"`
}

func parseResultEvent(line []byte) agent.AgentEvent {
	var result resultEvent
	if err := json.Unmarshal(line, &result); err != nil {
		return agent.DoneEvent{}
	}

	// Check if this was an interrupt (aborted request)
	if result.Subtype == "error_during_execution" {
		for _, e := range result.Errors {
			if strings.Contains(e, "Request was aborted") {
				return agent.InterruptedEvent{}
			}
		}
	}

	return agent.DoneEvent{}
}
