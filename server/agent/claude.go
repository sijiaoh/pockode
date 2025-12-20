package agent

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

const (
	DefaultTimeout = 5 * time.Minute
	ClaudeBinary   = "claude"
)

// ClaudeAgent implements the Agent interface using Claude CLI.
type ClaudeAgent struct {
	timeout time.Duration
}

// NewClaudeAgent creates a new ClaudeAgent with default settings.
func NewClaudeAgent() *ClaudeAgent {
	return &ClaudeAgent{timeout: DefaultTimeout}
}

// Run executes Claude CLI with the given prompt and streams events.
func (c *ClaudeAgent) Run(ctx context.Context, prompt string, workDir string) (<-chan AgentEvent, error) {
	events := make(chan AgentEvent)

	timeoutCtx, cancel := context.WithTimeout(ctx, c.timeout)

	cmd := exec.CommandContext(timeoutCtx,
		ClaudeBinary,
		"-p", prompt,
		"--output-format", "stream-json",
		"--verbose",
	)
	cmd.Dir = workDir

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

	go func() {
		defer close(events)
		defer cancel()

		// Read stderr in a separate goroutine
		stderrCh := make(chan string, 1)
		go func() {
			var stderrContent strings.Builder
			scanner := bufio.NewScanner(stderr)
			for scanner.Scan() {
				stderrContent.WriteString(scanner.Text())
				stderrContent.WriteString("\n")
			}
			stderrCh <- stderrContent.String()
		}()

		scanner := bufio.NewScanner(stdout)
		// Increase buffer size for long lines
		scanner.Buffer(make([]byte, 1024*1024), 1024*1024)

		for scanner.Scan() {
			line := scanner.Bytes()
			if len(line) == 0 {
				continue
			}

			event := c.parseLine(line)
			if event != nil {
				select {
				case events <- *event:
				case <-timeoutCtx.Done():
					return
				}
			}
		}

		// Wait for stderr goroutine to complete
		stderrContent := <-stderrCh

		if err := cmd.Wait(); err != nil {
			errMsg := stderrContent
			if errMsg == "" {
				errMsg = err.Error()
			}
			select {
			case events <- AgentEvent{Type: EventTypeError, Error: errMsg}:
			case <-timeoutCtx.Done():
			}
		}

		select {
		case events <- AgentEvent{Type: EventTypeDone}:
		case <-timeoutCtx.Done():
		}
	}()

	return events, nil
}

// cliEvent represents a raw event from Claude CLI verbose stream-json output.
type cliEvent struct {
	Type    string          `json:"type"`
	Subtype string          `json:"subtype,omitempty"`
	Message json.RawMessage `json:"message,omitempty"`
	Result  string          `json:"result,omitempty"`
}

// cliMessage represents the message object in assistant events.
type cliMessage struct {
	Content []cliContentBlock `json:"content"`
}

// cliContentBlock represents a content block in the message.
type cliContentBlock struct {
	Type  string          `json:"type"`
	Text  string          `json:"text,omitempty"`
	ID    string          `json:"id,omitempty"`
	Name  string          `json:"name,omitempty"`
	Input json.RawMessage `json:"input,omitempty"`
}

// parseLine parses a single line of Claude CLI verbose stream-json output.
func (c *ClaudeAgent) parseLine(line []byte) *AgentEvent {
	var event cliEvent
	if err := json.Unmarshal(line, &event); err != nil {
		return nil
	}

	switch event.Type {
	case "assistant":
		return c.parseAssistantEvent(event)
	case "result":
		// Result event means completion, we'll send done in the main loop
		return nil
	case "system":
		// Ignore system/init events
		return nil
	default:
		return nil
	}
}

// parseAssistantEvent handles assistant message events.
func (c *ClaudeAgent) parseAssistantEvent(event cliEvent) *AgentEvent {
	if event.Message == nil {
		return nil
	}

	var msg cliMessage
	if err := json.Unmarshal(event.Message, &msg); err != nil {
		return nil
	}

	// Collect all text content
	var textParts []string
	for _, block := range msg.Content {
		switch block.Type {
		case "text":
			if block.Text != "" {
				textParts = append(textParts, block.Text)
			}
		case "tool_use":
			return &AgentEvent{
				Type:      EventTypeToolCall,
				ToolName:  block.Name,
				ToolInput: block.Input,
			}
		}
	}

	if len(textParts) > 0 {
		return &AgentEvent{
			Type:    EventTypeText,
			Content: strings.Join(textParts, ""),
		}
	}

	return nil
}
