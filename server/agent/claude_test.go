package agent

import (
	"encoding/json"
	"testing"
)

func TestParseLine(t *testing.T) {
	agent := NewClaudeAgent()

	tests := []struct {
		name     string
		input    string
		expected *AgentEvent
	}{
		{
			name:     "empty line",
			input:    "",
			expected: nil,
		},
		{
			name:     "invalid json",
			input:    "not json",
			expected: nil,
		},
		{
			name:     "system init event",
			input:    `{"type":"system","subtype":"init","cwd":"/tmp"}`,
			expected: nil,
		},
		{
			name:     "result event",
			input:    `{"type":"result","subtype":"success","result":"Hello"}`,
			expected: nil,
		},
		{
			name:  "assistant text message",
			input: `{"type":"assistant","message":{"content":[{"type":"text","text":"Hello World"}]}}`,
			expected: &AgentEvent{
				Type:    EventTypeText,
				Content: "Hello World",
			},
		},
		{
			name:  "assistant message with multiple text blocks",
			input: `{"type":"assistant","message":{"content":[{"type":"text","text":"Hello"},{"type":"text","text":" World"}]}}`,
			expected: &AgentEvent{
				Type:    EventTypeText,
				Content: "Hello World",
			},
		},
		{
			name:     "assistant message with empty content",
			input:    `{"type":"assistant","message":{"content":[]}}`,
			expected: nil,
		},
		{
			name:  "assistant tool_use message",
			input: `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_123","name":"Read","input":{"file":"test.go"}}]}}`,
			expected: &AgentEvent{
				Type:      EventTypeToolCall,
				ToolName:  "Read",
				ToolInput: json.RawMessage(`{"file":"test.go"}`),
			},
		},
		{
			name:     "unknown event type",
			input:    `{"type":"unknown_event"}`,
			expected: nil,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := agent.parseLine([]byte(tt.input))

			if tt.expected == nil {
				if result != nil {
					t.Errorf("expected nil, got %+v", result)
				}
				return
			}

			if result == nil {
				t.Fatalf("expected %+v, got nil", tt.expected)
			}

			if result.Type != tt.expected.Type {
				t.Errorf("Type: expected %q, got %q", tt.expected.Type, result.Type)
			}

			if result.Content != tt.expected.Content {
				t.Errorf("Content: expected %q, got %q", tt.expected.Content, result.Content)
			}

			if result.ToolName != tt.expected.ToolName {
				t.Errorf("ToolName: expected %q, got %q", tt.expected.ToolName, result.ToolName)
			}

			if tt.expected.ToolInput != nil {
				if string(result.ToolInput) != string(tt.expected.ToolInput) {
					t.Errorf("ToolInput: expected %s, got %s", tt.expected.ToolInput, result.ToolInput)
				}
			}
		})
	}
}

func TestNewClaudeAgent(t *testing.T) {
	agent := NewClaudeAgent()

	if agent == nil {
		t.Fatal("NewClaudeAgent returned nil")
	}

	if agent.timeout != DefaultTimeout {
		t.Errorf("expected timeout %v, got %v", DefaultTimeout, agent.timeout)
	}
}
