// Package claude implements Agent interface using Claude CLI.
package claude

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/logger"
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
func (a *Agent) Start(ctx context.Context, workDir string, sessionID string) (agent.Session, error) {
	procCtx, cancel := context.WithCancel(ctx)

	args := []string{
		"--output-format", "stream-json",
		"--input-format", "stream-json",
		"--permission-prompt-tool", "stdio",
		"--verbose",
	}
	if sessionID != "" {
		args = append(args, "--resume", sessionID)
	}

	cmd := exec.CommandContext(procCtx, Binary, args...)
	cmd.Dir = workDir

	stdin, err := cmd.StdinPipe()
	if err != nil {
		cancel()
		return nil, fmt.Errorf("failed to create stdin pipe: %w", err)
	}

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		return nil, fmt.Errorf("failed to create stdout pipe: %w", err)
	}

	stderr, err := cmd.StderrPipe()
	if err != nil {
		cancel()
		return nil, fmt.Errorf("failed to create stderr pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		cancel()
		return nil, fmt.Errorf("failed to start claude: %w", err)
	}

	logger.Info("Start: claude process started (pid=%d)", cmd.Process.Pid)

	events := make(chan agent.AgentEvent)
	pendingRequests := &sync.Map{}

	sess := &session{
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

		stderrCh := readStderr(stderr)
		streamOutput(procCtx, stdout, events, pendingRequests)
		waitForProcess(procCtx, cmd, stderrCh, events)
	}()

	return sess, nil
}

// session implements agent.Session for Claude CLI.
type session struct {
	events          chan agent.AgentEvent
	stdin           io.WriteCloser
	stdinMu         sync.Mutex
	pendingRequests *sync.Map
	cancel          func()
}

// Events returns the event channel.
func (s *session) Events() <-chan agent.AgentEvent {
	return s.events
}

// SendMessage sends a message to Claude.
func (s *session) SendMessage(prompt string) error {
	s.stdinMu.Lock()
	defer s.stdinMu.Unlock()

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
	logger.Debug("sendMessage: sending prompt (len=%d)", len(prompt))
	if _, err := s.stdin.Write(append(data, '\n')); err != nil {
		return fmt.Errorf("failed to write to stdin: %w", err)
	}
	return nil
}

// SendPermissionResponse sends a permission response to Claude.
func (s *session) SendPermissionResponse(requestID string, allow bool) error {
	pending, ok := s.pendingRequests.LoadAndDelete(requestID)
	if !ok {
		return fmt.Errorf("no pending request for id: %s", requestID)
	}
	req := pending.(*controlRequest)

	s.stdinMu.Lock()
	defer s.stdinMu.Unlock()
	return s.sendControlResponse(req, allow)
}

// Close terminates the Claude process.
func (s *session) Close() {
	logger.Info("Session.Close: terminating claude process")
	s.cancel()
}

func (s *session) sendControlResponse(req *controlRequest, allow bool) error {
	var content controlResponseContent
	if allow {
		content = controlResponseContent{
			Behavior:     "allow",
			ToolUseID:    req.Request.ToolUseID,
			UpdatedInput: req.Request.Input,
		}
	} else {
		content = controlResponseContent{
			Behavior:  "deny",
			Message:   "User denied permission",
			Interrupt: true,
			ToolUseID: req.Request.ToolUseID,
		}
	}

	response := controlResponse{
		Type: "control_response",
		Response: controlResponsePayload{
			Subtype:   "success",
			RequestID: req.RequestID,
			Response:  content,
		},
	}

	data, err := json.Marshal(response)
	if err != nil {
		return fmt.Errorf("failed to marshal control response: %w", err)
	}

	logger.Debug("sendControlResponse: %s", string(data))
	_, err = s.stdin.Write(append(data, '\n'))
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

func streamOutput(ctx context.Context, stdout io.Reader, events chan<- agent.AgentEvent, pendingRequests *sync.Map) {
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}

		parsedEvents, isResult := parseLine(line, pendingRequests)
		for _, event := range parsedEvents {
			select {
			case events <- event:
			case <-ctx.Done():
				return
			}
		}

		if isResult {
			select {
			case events <- agent.AgentEvent{Type: agent.EventTypeDone}:
			case <-ctx.Done():
				return
			}
		}
	}

	if err := scanner.Err(); err != nil {
		logger.Error("stdout scanner error: %v", err)
	}
}

func waitForProcess(ctx context.Context, cmd *exec.Cmd, stderrCh <-chan string, events chan<- agent.AgentEvent) {
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

	logger.Info("waitForProcess: claude process exited")
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
	Request   *permissionData `json:"request"`
}

type permissionData struct {
	Subtype   string          `json:"subtype"`
	ToolName  string          `json:"tool_name"`
	Input     json.RawMessage `json:"input"`
	ToolUseID string          `json:"tool_use_id"`
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
	Behavior     string          `json:"behavior"`
	Message      string          `json:"message,omitempty"`
	Interrupt    bool            `json:"interrupt,omitempty"`
	ToolUseID    string          `json:"toolUseID"`
	UpdatedInput json.RawMessage `json:"updatedInput,omitempty"`
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
	Content   string          `json:"content,omitempty"`
}

func parseLine(line []byte, pendingRequests *sync.Map) ([]agent.AgentEvent, bool) {
	if len(line) == 0 {
		return nil, false
	}

	var event cliEvent
	if err := json.Unmarshal(line, &event); err != nil {
		logger.Error("parseLine: failed to parse JSON: %v, line: %s", err, logger.Truncate(string(line), 100))
		return []agent.AgentEvent{{
			Type:    agent.EventTypeText,
			Content: string(line),
		}}, false
	}

	switch event.Type {
	case "assistant":
		return parseAssistantEvent(event), false
	case "user":
		return parseUserEvent(event), false
	case "result":
		return nil, true
	case "system":
		if event.SessionID != "" {
			return []agent.AgentEvent{{
				Type:      agent.EventTypeSession,
				SessionID: event.SessionID,
			}}, false
		}
		return nil, false
	case "control_request":
		return parseControlRequest(line, pendingRequests), false
	default:
		logger.Info("parseLine: unknown event type: %s", event.Type)
		return []agent.AgentEvent{{
			Type:    agent.EventTypeText,
			Content: string(line),
		}}, false
	}
}

func parseControlRequest(line []byte, pendingRequests *sync.Map) []agent.AgentEvent {
	var req controlRequest
	if err := json.Unmarshal(line, &req); err != nil {
		logger.Error("parseControlRequest: failed to parse: %v", err)
		return nil
	}

	if req.Request == nil {
		logger.Debug("parseControlRequest: ignoring request with nil request data")
		return nil
	}
	if req.Request.Subtype != "can_use_tool" {
		logger.Debug("parseControlRequest: ignoring non-permission request: %s", req.Request.Subtype)
		return nil
	}

	logger.Info("parseControlRequest: tool=%s, requestID=%s", req.Request.ToolName, req.RequestID)
	pendingRequests.Store(req.RequestID, &req)

	return []agent.AgentEvent{{
		Type:      agent.EventTypePermissionRequest,
		RequestID: req.RequestID,
		ToolName:  req.Request.ToolName,
		ToolInput: req.Request.Input,
		ToolUseID: req.Request.ToolUseID,
	}}
}

func parseAssistantEvent(event cliEvent) []agent.AgentEvent {
	if event.Message == nil {
		logger.Error("parseAssistantEvent: message is nil, subtype: %s", event.Subtype)
		return nil
	}

	var msg cliMessage
	if err := json.Unmarshal(event.Message, &msg); err != nil {
		logger.Error("parseAssistantEvent: failed to parse message: %v", err)
		return []agent.AgentEvent{{
			Type:    agent.EventTypeText,
			Content: string(event.Message),
		}}
	}

	var events []agent.AgentEvent
	var textParts []string

	for _, block := range msg.Content {
		switch block.Type {
		case "text":
			if block.Text != "" {
				textParts = append(textParts, block.Text)
			}
		case "tool_use":
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

func parseUserEvent(event cliEvent) []agent.AgentEvent {
	if event.Message == nil {
		return nil
	}

	var msg cliMessage
	if err := json.Unmarshal(event.Message, &msg); err != nil {
		logger.Error("parseUserEvent: failed to parse message: %v", err)
		return []agent.AgentEvent{{
			Type:    agent.EventTypeText,
			Content: string(event.Message),
		}}
	}

	var events []agent.AgentEvent
	for _, block := range msg.Content {
		if block.Type == "tool_result" {
			events = append(events, agent.AgentEvent{
				Type:       agent.EventTypeToolResult,
				ToolUseID:  block.ToolUseID,
				ToolResult: block.Content,
			})
		}
	}

	return events
}
