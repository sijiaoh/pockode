package ws

import (
	"encoding/json"

	"github.com/pockode/server/agent"
)

// ClientMessage represents a message sent by the client.
type ClientMessage struct {
	Type      string            `json:"type"`                 // "message", "interrupt", "permission_response", or "question_response"
	Content   string            `json:"content"`              // User input (for "message" type)
	SessionID string            `json:"session_id,omitempty"` // Session identifier
	RequestID string            `json:"request_id,omitempty"` // Request ID (for permission_response and question_response)
	Choice    string            `json:"choice,omitempty"`     // "deny", "allow", or "always_allow" (for permission_response)
	Answers   map[string]string `json:"answers,omitempty"`    // question -> selected label(s), nil = cancel (for question_response)
}

// ServerMessage represents a message sent by the server.
type ServerMessage struct {
	Type                  string                   `json:"type"`                             // Event type
	SessionID             string                   `json:"session_id,omitempty"`             // Session identifier
	Content               string                   `json:"content,omitempty"`                // Text content
	ToolName              string                   `json:"tool_name,omitempty"`              // Tool name (for tool_call, permission_request)
	ToolInput             json.RawMessage          `json:"tool_input,omitempty"`             // Tool input (for tool_call, permission_request)
	ToolUseID             string                   `json:"tool_use_id,omitempty"`            // Tool use ID (for tool_call, tool_result, permission_request)
	ToolResult            string                   `json:"tool_result,omitempty"`            // Tool result content
	Error                 string                   `json:"error,omitempty"`                  // Error message
	RequestID             string                   `json:"request_id,omitempty"`             // Request ID (for permission_request, ask_user_question)
	PermissionSuggestions []agent.PermissionUpdate `json:"permission_suggestions,omitempty"` // Permission suggestions (for permission_request)
	Questions             []agent.AskUserQuestion  `json:"questions,omitempty"`              // Questions to ask (for ask_user_question)
}
