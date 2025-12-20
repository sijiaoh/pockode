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
		expected []AgentEvent
	}{
		{
			name:     "empty line",
			input:    "",
			expected: nil,
		},
		{
			name:  "invalid json falls back to raw text",
			input: "not json",
			expected: []AgentEvent{{
				Type:    EventTypeText,
				Content: "not json",
			}},
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
			expected: []AgentEvent{{
				Type:    EventTypeText,
				Content: "Hello World",
			}},
		},
		{
			name:  "assistant message with multiple text blocks",
			input: `{"type":"assistant","message":{"content":[{"type":"text","text":"Hello"},{"type":"text","text":" World"}]}}`,
			expected: []AgentEvent{{
				Type:    EventTypeText,
				Content: "Hello World",
			}},
		},
		{
			name:     "assistant message with empty content",
			input:    `{"type":"assistant","message":{"content":[]}}`,
			expected: nil,
		},
		{
			name:  "assistant tool_use message",
			input: `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_123","name":"Read","input":{"file":"test.go"}}]}}`,
			expected: []AgentEvent{{
				Type:      EventTypeToolCall,
				ToolUseID: "toolu_123",
				ToolName:  "Read",
				ToolInput: json.RawMessage(`{"file":"test.go"}`),
			}},
		},
		{
			name:  "assistant text and tool_use in same message",
			input: `{"type":"assistant","message":{"content":[{"type":"text","text":"I will read the file"},{"type":"tool_use","id":"toolu_456","name":"Read","input":{"path":"main.go"}}]}}`,
			expected: []AgentEvent{
				{
					Type:    EventTypeText,
					Content: "I will read the file",
				},
				{
					Type:      EventTypeToolCall,
					ToolUseID: "toolu_456",
					ToolName:  "Read",
					ToolInput: json.RawMessage(`{"path":"main.go"}`),
				},
			},
		},
		{
			name:  "assistant multiple tool_use (parallel tools)",
			input: `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_1","name":"Read","input":{"path":"a.go"}},{"type":"tool_use","id":"toolu_2","name":"Read","input":{"path":"b.go"}}]}}`,
			expected: []AgentEvent{
				{
					Type:      EventTypeToolCall,
					ToolUseID: "toolu_1",
					ToolName:  "Read",
					ToolInput: json.RawMessage(`{"path":"a.go"}`),
				},
				{
					Type:      EventTypeToolCall,
					ToolUseID: "toolu_2",
					ToolName:  "Read",
					ToolInput: json.RawMessage(`{"path":"b.go"}`),
				},
			},
		},
		{
			name:  "user tool_result message",
			input: `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_123","content":"file contents here"}]}}`,
			expected: []AgentEvent{{
				Type:       EventTypeToolResult,
				ToolUseID:  "toolu_123",
				ToolResult: "file contents here",
			}},
		},
		{
			name:  "user multiple tool_results (parallel tool results)",
			input: `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"result 1"},{"type":"tool_result","tool_use_id":"toolu_2","content":"result 2"}]}}`,
			expected: []AgentEvent{
				{
					Type:       EventTypeToolResult,
					ToolUseID:  "toolu_1",
					ToolResult: "result 1",
				},
				{
					Type:       EventTypeToolResult,
					ToolUseID:  "toolu_2",
					ToolResult: "result 2",
				},
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
			results := agent.parseLine([]byte(tt.input))

			if tt.expected == nil {
				if len(results) != 0 {
					t.Errorf("expected nil/empty, got %+v", results)
				}
				return
			}

			if len(results) != len(tt.expected) {
				t.Fatalf("expected %d events, got %d: %+v", len(tt.expected), len(results), results)
			}

			for i, expected := range tt.expected {
				result := results[i]

				if result.Type != expected.Type {
					t.Errorf("event[%d] Type: expected %q, got %q", i, expected.Type, result.Type)
				}

				if result.Content != expected.Content {
					t.Errorf("event[%d] Content: expected %q, got %q", i, expected.Content, result.Content)
				}

				if result.ToolName != expected.ToolName {
					t.Errorf("event[%d] ToolName: expected %q, got %q", i, expected.ToolName, result.ToolName)
				}

				if result.ToolUseID != expected.ToolUseID {
					t.Errorf("event[%d] ToolUseID: expected %q, got %q", i, expected.ToolUseID, result.ToolUseID)
				}

				if result.ToolResult != expected.ToolResult {
					t.Errorf("event[%d] ToolResult: expected %q, got %q", i, expected.ToolResult, result.ToolResult)
				}

				if expected.ToolInput != nil {
					if string(result.ToolInput) != string(expected.ToolInput) {
						t.Errorf("event[%d] ToolInput: expected %s, got %s", i, expected.ToolInput, result.ToolInput)
					}
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
