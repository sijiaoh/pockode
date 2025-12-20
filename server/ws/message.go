package ws

import "encoding/json"

// ClientMessage represents a message sent by the client.
type ClientMessage struct {
	Type    string `json:"type"`    // "message" or "cancel"
	ID      string `json:"id"`      // Message ID (UUID)
	Content string `json:"content"` // User input (for "message" type)
}

// ServerMessage represents a message sent by the server.
type ServerMessage struct {
	Type       string          `json:"type"`                  // Event type
	MessageID  string          `json:"message_id,omitempty"`  // Associated message ID
	Content    string          `json:"content,omitempty"`     // Text content
	ToolName   string          `json:"tool_name,omitempty"`   // Tool name (for tool_call)
	ToolInput  json.RawMessage `json:"tool_input,omitempty"`  // Tool input (for tool_call)
	ToolUseID  string          `json:"tool_use_id,omitempty"` // Tool use ID (for tool_result)
	ToolResult string          `json:"tool_result,omitempty"` // Tool result content
	Error      string          `json:"error,omitempty"`       // Error message
}
