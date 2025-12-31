// Package claude implements Agent interface using Claude CLI.
package claude

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/pockode/server/agent"
)

const (
	// Binary is the Claude CLI executable name.
	Binary            = "claude"
	stderrReadTimeout = 5 * time.Second
)

// Agent implements agent.Agent using Claude CLI.
type Agent struct{}

// New creates a new Claude Agent.
func New() *Agent {
	return &Agent{}
}

// Start launches a persistent Claude CLI process.
func (a *Agent) Start(ctx context.Context, workDir string, sessionID string, resume bool) (agent.Session, error) {
	procCtx, cancel := context.WithCancel(ctx)

	args := []string{
		"--output-format", "stream-json",
		"--input-format", "stream-json",
		"--permission-prompt-tool", "stdio",
		"--verbose",
	}
	if sessionID != "" {
		if resume {
			args = append(args, "--resume", sessionID)
		} else {
			args = append(args, "--session-id", sessionID)
		}
	}

	cmd := exec.CommandContext(procCtx, Binary, args...)
	cmd.Dir = workDir

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

	log := slog.With("sessionId", sessionID)
	log.Info("claude process started", "pid", cmd.Process.Pid)

	events := make(chan agent.AgentEvent)
	pendingRequests := &sync.Map{}

	sess := &session{
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
		defer close(events)
		defer cancel()
		defer stdout.Close()
		defer stderr.Close()

		stderrCh := readStderr(stderr)
		streamOutput(procCtx, log, stdout, events, pendingRequests)
		waitForProcess(procCtx, log, cmd, stderrCh, events)

		// Notify client that process has ended (abnormal: process should stay alive)
		select {
		case events <- agent.AgentEvent{Type: agent.EventTypeProcessEnded}:
		case <-procCtx.Done():
		}
	}()

	return sess, nil
}

// session implements agent.Session for Claude CLI.
type session struct {
	log             *slog.Logger
	events          chan agent.AgentEvent
	stdin           io.WriteCloser
	stdinMu         sync.Mutex
	pendingRequests *sync.Map // tracks sent control requests by requestID for response matching
	cancel          func()
	closeOnce       sync.Once
}

// Events returns the event channel.
func (s *session) Events() <-chan agent.AgentEvent {
	return s.events
}

// SendMessage sends a message to Claude.
func (s *session) SendMessage(prompt string) error {
	msg := userMessage{
		Type: "user",
		Message: userContent{
			Role: "user",
			Content: []textContent{
				{Type: "text", Text: prompt},
			},
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
func (s *session) SendPermissionResponse(data agent.PermissionRequestData, choice agent.PermissionChoice) error {
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
func (s *session) SendQuestionResponse(data agent.QuestionRequestData, answers map[string]string) error {
	var content controlResponseContent

	if answers == nil {
		content = controlResponseContent{
			Behavior:  "deny",
			Message:   "User cancelled the question",
			ToolUseID: data.ToolUseID,
		}
	} else {
		updatedInput, err := json.Marshal(map[string]any{"answers": answers})
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

func (s *session) sendControlResponse(requestID string, content controlResponseContent) error {
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
func (s *session) SendInterrupt() error {
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
func (s *session) Close() {
	s.closeOnce.Do(func() {
		s.log.Info("terminating claude process")
		s.cancel()
		s.stdinMu.Lock()
		s.stdin.Close()
		s.stdinMu.Unlock()
	})
}

// writeStdin writes data to stdin with mutex protection.
func (s *session) writeStdin(data []byte) error {
	s.stdinMu.Lock()
	defer s.stdinMu.Unlock()
	_, err := s.stdin.Write(append(data, '\n'))
	return err
}

// --- Process management ---

func readStderr(stderr io.Reader) <-chan string {
	ch := make(chan string, 1)
	go func() {
		var content strings.Builder
		scanner := bufio.NewScanner(stderr)
		for scanner.Scan() {
			content.WriteString(scanner.Text())
			content.WriteString("\n")
		}
		ch <- content.String()
	}()
	return ch
}

func streamOutput(ctx context.Context, log *slog.Logger, stdout io.Reader, events chan<- agent.AgentEvent, pendingRequests *sync.Map) {
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
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
	}
}

func waitForProcess(ctx context.Context, log *slog.Logger, cmd *exec.Cmd, stderrCh <-chan string, events chan<- agent.AgentEvent) {
	var stderrContent string
	select {
	case stderrContent = <-stderrCh:
	case <-time.After(stderrReadTimeout):
	}

	if err := cmd.Wait(); err != nil {
		if ctx.Err() == nil {
			errMsg := stderrContent
			if errMsg == "" {
				errMsg = err.Error()
			}
			select {
			case events <- agent.AgentEvent{Type: agent.EventTypeError, Error: errMsg}:
			case <-ctx.Done():
			}
		}
	}

	log.Info("claude process exited")
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
		return []agent.AgentEvent{{
			Type:    agent.EventTypeText,
			Content: string(line),
		}}
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
		return []agent.AgentEvent{{
			Type:    agent.EventTypeSystem,
			Content: string(line),
		}}
	case "control_request":
		return parseControlRequest(log, line)
	case "control_response":
		return parseControlResponse(log, line, pendingRequests)
	default:
		log.Warn("unknown event type from CLI", "type", event.Type)
		return []agent.AgentEvent{{
			Type:    agent.EventTypeText,
			Content: string(line),
		}}
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
			return []agent.AgentEvent{{
				Type:      agent.EventTypeAskUserQuestion,
				RequestID: req.RequestID,
				ToolUseID: req.Request.ToolUseID,
				Questions: input.Questions,
			}}
		}

		log.Info("tool permission request", "tool", req.Request.ToolName, "requestId", req.RequestID)
		return []agent.AgentEvent{{
			Type:                  agent.EventTypePermissionRequest,
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
			return []agent.AgentEvent{{
				Type: agent.EventTypeInterrupted,
			}}
		}
	}

	// Other control responses (permission, question) don't need client notification.
	return nil
}

func parseAssistantEvent(log *slog.Logger, event cliEvent) []agent.AgentEvent {
	if event.Message == nil {
		log.Warn("assistant event message is nil", "subtype", event.Subtype)
		return nil
	}

	var msg cliMessage
	if err := json.Unmarshal(event.Message, &msg); err != nil {
		log.Warn("failed to parse assistant message from CLI", "error", err)
		return []agent.AgentEvent{{
			Type:    agent.EventTypeText,
			Content: string(event.Message),
		}}
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
				events = append(events, agent.AgentEvent{
					Type:    agent.EventTypeText,
					Content: strings.Join(textParts, ""),
				})
				textParts = nil
			}
			events = append(events, agent.AgentEvent{
				Type:      agent.EventTypeToolCall,
				ToolUseID: block.ID,
				ToolName:  block.Name,
				ToolInput: block.Input,
			})
		}
	}

	if len(textParts) > 0 {
		events = append(events, agent.AgentEvent{
			Type:    agent.EventTypeText,
			Content: strings.Join(textParts, ""),
		})
	}

	return events
}

func parseUserEvent(log *slog.Logger, event cliEvent) []agent.AgentEvent {
	if event.Message == nil {
		return nil
	}

	var msg cliMessage
	if err := json.Unmarshal(event.Message, &msg); err != nil {
		log.Warn("failed to parse user message from CLI", "error", err)
		return []agent.AgentEvent{{
			Type:    agent.EventTypeText,
			Content: string(event.Message),
		}}
	}

	var events []agent.AgentEvent
	for _, block := range msg.Content {
		if block.Type == "tool_result" {
			// Content is JSON: either a string ("...") or array/object.
			// Unmarshal extracts the string value; for non-strings, use raw JSON.
			var content string
			if err := json.Unmarshal(block.Content, &content); err != nil {
				content = string(block.Content)
			}
			events = append(events, agent.AgentEvent{
				Type:       agent.EventTypeToolResult,
				ToolUseID:  block.ToolUseID,
				ToolResult: content,
			})
		}
	}

	return events
}

type resultEvent struct {
	Subtype   string   `json:"subtype"`
	SessionID string   `json:"session_id"`
	Errors    []string `json:"errors"`
}

func parseResultEvent(line []byte) agent.AgentEvent {
	var result resultEvent
	if err := json.Unmarshal(line, &result); err != nil {
		return agent.AgentEvent{Type: agent.EventTypeDone}
	}

	eventType := agent.EventTypeDone

	// Check if this was an interrupt (aborted request)
	if result.Subtype == "error_during_execution" {
		for _, e := range result.Errors {
			if strings.Contains(e, "Request was aborted") {
				eventType = agent.EventTypeInterrupted
				break
			}
		}
	}

	return agent.AgentEvent{Type: eventType}
}
