// Package rpc defines JSON-RPC 2.0 wire format types for WebSocket communication.
// These types represent the params and result structures for all RPC methods.
package rpc

import (
	"encoding/json"

	"github.com/pockode/server/agent"
)

// Client → Server

type AuthParams struct {
	Token string `json:"token"`
}

type AttachParams struct {
	SessionID string `json:"session_id"`
}

type AttachResult struct {
	ProcessRunning bool `json:"process_running"`
}

type MessageParams struct {
	SessionID string `json:"session_id"`
	Content   string `json:"content"`
}

type InterruptParams struct {
	SessionID string `json:"session_id"`
}

type PermissionResponseParams struct {
	SessionID             string                   `json:"session_id"`
	RequestID             string                   `json:"request_id"`
	Choice                string                   `json:"choice"` // "deny", "allow", "always_allow"
	ToolInput             json.RawMessage          `json:"tool_input,omitempty"`
	ToolUseID             string                   `json:"tool_use_id,omitempty"`
	PermissionSuggestions []agent.PermissionUpdate `json:"permission_suggestions,omitempty"`
}

type QuestionResponseParams struct {
	SessionID string            `json:"session_id"`
	RequestID string            `json:"request_id"`
	ToolUseID string            `json:"tool_use_id"`
	Answers   map[string]string `json:"answers"` // nil = cancel
}

// Server → Client

// SessionParams is the params for done, interrupted, and process_ended notifications.
type SessionParams struct {
	SessionID string `json:"session_id"`
}

type TextParams struct {
	SessionID string `json:"session_id"`
	Content   string `json:"content"`
}

type ToolCallParams struct {
	SessionID string          `json:"session_id"`
	ToolName  string          `json:"tool_name"`
	ToolInput json.RawMessage `json:"tool_input"`
	ToolUseID string          `json:"tool_use_id"`
}

type ToolResultParams struct {
	SessionID  string `json:"session_id"`
	ToolUseID  string `json:"tool_use_id"`
	ToolResult string `json:"tool_result"`
}

type ErrorParams struct {
	SessionID string `json:"session_id"`
	Error     string `json:"error"`
}

type PermissionRequestParams struct {
	SessionID             string                   `json:"session_id"`
	RequestID             string                   `json:"request_id"`
	ToolName              string                   `json:"tool_name"`
	ToolInput             json.RawMessage          `json:"tool_input"`
	ToolUseID             string                   `json:"tool_use_id"`
	PermissionSuggestions []agent.PermissionUpdate `json:"permission_suggestions,omitempty"`
}

type RequestCancelledParams struct {
	SessionID string `json:"session_id"`
	RequestID string `json:"request_id"`
}

type AskUserQuestionParams struct {
	SessionID string                  `json:"session_id"`
	RequestID string                  `json:"request_id"`
	ToolUseID string                  `json:"tool_use_id"`
	Questions []agent.AskUserQuestion `json:"questions"`
}

type SystemParams struct {
	SessionID string `json:"session_id"`
	Content   string `json:"content"`
}

// NewNotifyParams creates method-specific notification params from an AgentEvent.
func NewNotifyParams(sessionID string, event agent.AgentEvent) interface{} {
	switch e := event.(type) {
	case agent.TextEvent:
		return TextParams{SessionID: sessionID, Content: e.Content}
	case agent.ToolCallEvent:
		return ToolCallParams{SessionID: sessionID, ToolName: e.ToolName, ToolInput: e.ToolInput, ToolUseID: e.ToolUseID}
	case agent.ToolResultEvent:
		return ToolResultParams{SessionID: sessionID, ToolUseID: e.ToolUseID, ToolResult: e.ToolResult}
	case agent.ErrorEvent:
		return ErrorParams{SessionID: sessionID, Error: e.Error}
	case agent.DoneEvent:
		return SessionParams{SessionID: sessionID}
	case agent.InterruptedEvent:
		return SessionParams{SessionID: sessionID}
	case agent.PermissionRequestEvent:
		return PermissionRequestParams{
			SessionID:             sessionID,
			RequestID:             e.RequestID,
			ToolName:              e.ToolName,
			ToolInput:             e.ToolInput,
			ToolUseID:             e.ToolUseID,
			PermissionSuggestions: e.PermissionSuggestions,
		}
	case agent.RequestCancelledEvent:
		return RequestCancelledParams{SessionID: sessionID, RequestID: e.RequestID}
	case agent.AskUserQuestionEvent:
		return AskUserQuestionParams{SessionID: sessionID, RequestID: e.RequestID, ToolUseID: e.ToolUseID, Questions: e.Questions}
	case agent.SystemEvent:
		return SystemParams{SessionID: sessionID, Content: e.Content}
	case agent.ProcessEndedEvent:
		return SessionParams{SessionID: sessionID}
	default:
		return SessionParams{SessionID: sessionID}
	}
}
