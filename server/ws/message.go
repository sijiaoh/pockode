package ws

import "encoding/json"

// ClientMessage represents a message sent by the client.
type ClientMessage struct {
	Type      string `json:"type"`                 // "message", "interrupt", or "permission_response"
	Content   string `json:"content"`              // User input (for "message" type)
	SessionID string `json:"session_id,omitempty"` // Session identifier
	// Permission response fields (for "permission_response" type)
	RequestID string `json:"request_id,omitempty"` // Permission request ID
	Allow     bool   `json:"allow,omitempty"`      // Whether to allow the tool execution
}

// ServerMessage represents a message sent by the server.
type ServerMessage struct {
	Type       string          `json:"type"`                  // Event type
	Content    string          `json:"content,omitempty"`     // Text content
	ToolName   string          `json:"tool_name,omitempty"`   // Tool name (for tool_call, permission_request)
	ToolInput  json.RawMessage `json:"tool_input,omitempty"`  // Tool input (for tool_call, permission_request)
	ToolUseID  string          `json:"tool_use_id,omitempty"` // Tool use ID (for tool_result)
	ToolResult string          `json:"tool_result,omitempty"` // Tool result content
	Error      string          `json:"error,omitempty"`       // Error message
	RequestID  string          `json:"request_id,omitempty"`  // Permission request ID (for permission_request)
}
